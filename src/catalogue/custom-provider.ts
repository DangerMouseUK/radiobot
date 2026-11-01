import { randomBytes } from 'node:crypto';
import type { StationRepository } from '../persistence/repositories/stations.ts';
import { RadioError } from '../shared/errors.ts';
import { slugify } from '../shared/text.ts';
import type { ProbeReport, SourceService } from '../streams/source-service.ts';
import type { UrlPolicy } from '../streams/url-policy.ts';
import type { Station } from './types.ts';

export interface CustomStationInput {
  name: string;
  url: string;
  website?: string | null;
  description?: string | null;
  category?: string | null;
  language?: string | null;
}

const newId = (prefix: string) =>
  `${prefix}:${randomBytes(6)
    .toString('base64url')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x')}`;

function cleanText(v: string | null | undefined, max: number): string | null {
  if (v === undefined || v === null) return null;
  const t = [...v]
    .map((ch) => (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t.slice(0, max) : null;
}

function validateWebsite(raw: string | null | undefined): string | null {
  const v = cleanText(raw, 300);
  if (!v) return null;
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
    if (u.username || u.password) throw new Error('credentials');
    return u.href;
  } catch {
    throw new RadioError('URL_INVALID', 'The website must be a plain http(s) link.');
  }
}

/**
 * Guild-scoped third-party stations (FR-011). They live in a separate, secondary catalogue,
 * never alter the shipped provider manifest, and every URL passes the same SSRF policy and
 * live inspection as built-in sources before it is accepted.
 */
export class CustomStationService {
  readonly #repo: StationRepository;
  readonly #sources: SourceService;
  readonly #policy: UrlPolicy;
  readonly #maxPerGuild: number;

  constructor(repo: StationRepository, sources: SourceService, policy: UrlPolicy, maxPerGuild: number) {
    this.#repo = repo;
    this.#sources = sources;
    this.#policy = policy;
    this.#maxPerGuild = maxPerGuild;
  }

  get maxPerGuild(): number {
    return this.#maxPerGuild;
  }

  async add(
    guildId: string,
    userId: string,
    input: CustomStationInput,
  ): Promise<{ station: Station; report: ProbeReport }> {
    const name = cleanText(input.name, 60);
    if (!name || name.length < 2)
      throw new RadioError('URL_INVALID', 'The station name must be 2–60 characters long.');
    if (this.#repo.countCustomStations(guildId) >= this.#maxPerGuild) {
      throw new RadioError(
        'CUSTOM_STATION_LIMIT',
        `This server already has the maximum of ${this.#maxPerGuild} custom stations.`,
      );
    }
    const url = this.#policy.validateUrl(input.url).href;
    const website = validateWebsite(input.website);
    const baseSlug = slugify(name) || 'station';
    let slug = baseSlug;
    let n = 2;
    while (this.#repo.listStations(guildId).some((s) => s.provider === 'custom' && s.slug === slug))
      slug = `${baseSlug}-${n++}`;
    const stationId = newId('custom');
    const sourceId = newId('src').replace(':', '-');
    this.#repo.insertCustomStation({
      id: stationId,
      guildId,
      slug,
      displayName: name,
      description: cleanText(input.description, 300),
      category: cleanText(input.category, 40),
      websiteUrl: website,
      language: cleanText(input.language, 20),
      createdById: userId,
    });
    this.#repo.insertSource({
      id: sourceId,
      stationId,
      url,
      label: 'Custom stream',
      priority: 10,
      transportHint: null,
      codecHint: null,
      provenance: 'custom-user',
      provenanceDetail: `Added by a server administrator on ${new Date().toISOString().slice(0, 10)}.`,
      rightsStatus: 'unreviewed',
    });
    let report: ProbeReport;
    try {
      report = await this.#sources.probe(sourceId);
    } catch (err) {
      this.#repo.deleteCustomStation(guildId, stationId);
      throw err;
    }
    if (!report.outcome.success) {
      this.#repo.deleteCustomStation(guildId, stationId);
      throw new RadioError(
        report.outcome.failureCode ?? 'PROBE_FAILED',
        `That stream failed its check, so nothing was added. Reason: ${report.outcome.failureDetail ?? 'unknown'}`,
      );
    }
    return { station: this.#repo.getStation(stationId)!, report };
  }

  async edit(
    guildId: string,
    stationId: string,
    patch: Partial<CustomStationInput>,
  ): Promise<{ station: Station; report: ProbeReport | null }> {
    const station = this.#repo.getStation(stationId);
    if (station?.provider !== 'custom' || station.guildId !== guildId) {
      throw new RadioError('URL_INVALID', 'That is not one of this server’s custom stations.');
    }
    const name = patch.name !== undefined ? cleanText(patch.name, 60) : undefined;
    if (name !== undefined && (!name || name.length < 2)) {
      throw new RadioError('URL_INVALID', 'The station name must be 2–60 characters long.');
    }
    // Validate everything before changing anything, and apply the other fields only once a new URL
    // has passed its probe, so a rejected edit leaves the station exactly as it was.
    const fields = {
      ...(name ? { displayName: name } : {}),
      ...(patch.description !== undefined ? { description: cleanText(patch.description, 300) } : {}),
      ...(patch.category !== undefined ? { category: cleanText(patch.category, 40) } : {}),
      ...(patch.website !== undefined ? { websiteUrl: validateWebsite(patch.website) } : {}),
      ...(patch.language !== undefined ? { language: cleanText(patch.language, 20) } : {}),
    };
    const url = patch.url ? this.#policy.validateUrl(patch.url).href : null;
    let report: ProbeReport | null = null;
    if (url) {
      const source = this.#repo.listSources(stationId)[0];
      if (!source)
        throw new RadioError(
          'INTERNAL',
          'This custom station has no stream saved. Remove it and add it again.',
        );
      // Restored as it was if the new URL fails, so a bad edit costs the old source no evidence.
      const previous = this.#repo.snapshotSource(source.id)!;
      this.#repo.upsertSeedSource({
        id: source.id,
        stationId,
        url,
        label: source.label,
        priority: source.priority,
        transportHint: null,
        codecHint: null,
        provenance: 'custom-user',
        provenanceDetail: `URL changed by a server administrator on ${new Date().toISOString().slice(0, 10)}.`,
        rightsStatus: 'unreviewed',
      });
      const restore = () => this.#repo.restoreSource(previous);
      try {
        report = await this.#sources.probe(source.id);
      } catch (err) {
        restore();
        throw err;
      }
      if (!report.outcome.success) {
        restore();
        throw new RadioError(
          report.outcome.failureCode ?? 'PROBE_FAILED',
          `The new URL failed its check, so the old URL was kept. Reason: ${report.outcome.failureDetail ?? 'unknown'}`,
        );
      }
    }
    if (Object.keys(fields).length > 0) this.#repo.updateCustomStation(guildId, stationId, fields);
    return { station: this.#repo.getStation(stationId)!, report };
  }

  remove(guildId: string, stationId: string): boolean {
    return this.#repo.deleteCustomStation(guildId, stationId);
  }
}
