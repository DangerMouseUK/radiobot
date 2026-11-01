import type { Logger } from '../observability/logger.ts';
import type { MetaRepository } from '../persistence/repositories/guilds.ts';
import type { StationRepository } from '../persistence/repositories/stations.ts';
import { errorMessage, RadioError } from '../shared/errors.ts';
import { normalizeName, similarity, slugify } from '../shared/text.ts';
import type { SafeHttpClient } from '../streams/safe-fetch.ts';
import type { PackRegistry, StationPack } from './packs.ts';
import { type OfficialEntry, SYNC_ADAPTERS } from './sync-adapters.ts';

export interface SyncReport {
  packId: string;
  packName: string;
  ok: boolean;
  checkedAt: string;
  error: string | null;
  officialCount: number;
  added: string[];
  renamed: Array<{ from: string; to: string }>;
  missing: string[];
  returned: string[];
  unchanged: number;
  needsSourceMapping: string[];
  /** Stations whose every enabled source failed its last probe (from local evidence). */
  unreachable: string[];
}

/**
 * Reconciles packs that declare an official list (`sync` in pack.json) with that list
 * (FR-002). Generic: the only pack-specific part is the adapter that reads the list.
 * Conservative: a failed or implausible fetch changes nothing.
 */
export class CatalogueSync {
  readonly #repo: StationRepository;
  readonly #meta: MetaRepository;
  readonly #http: SafeHttpClient;
  readonly #packs: PackRegistry;
  readonly #log: Logger;

  constructor(
    repo: StationRepository,
    meta: MetaRepository,
    http: SafeHttpClient,
    packs: PackRegistry,
    logger: Logger,
  ) {
    this.#repo = repo;
    this.#meta = meta;
    this.#http = http;
    this.#packs = packs;
    this.#log = logger.child({ component: 'catalogue-sync' });
  }

  /** Enabled packs that have an official list to reconcile with. */
  syncablePacks(): StationPack[] {
    return this.#packs.enabledPacks().filter((p) => p.meta.sync !== null);
  }

  lastSync(packId: string): { at: string | null; ok: boolean } {
    const at = this.#repo.lastSuccessfulSync(packId);
    const last = this.#repo.lastSyncReport(packId);
    return { at, ok: last?.success ?? false };
  }

  /** True when the last successful sync is older than 3× the interval. */
  isStale(packId: string, intervalHours: number): boolean {
    const at = this.#repo.lastSuccessfulSync(packId);
    if (!at) return true;
    return Date.now() - Date.parse(at) > 3 * intervalHours * 3_600_000;
  }

  async syncAll(trigger: 'scheduled' | 'admin' | 'startup', signal?: AbortSignal): Promise<SyncReport[]> {
    const reports: SyncReport[] = [];
    for (const pack of this.syncablePacks()) reports.push(await this.sync(pack.meta.id, trigger, signal));
    return reports;
  }

  async sync(
    packId: string,
    trigger: 'scheduled' | 'admin' | 'startup',
    signal?: AbortSignal,
  ): Promise<SyncReport> {
    const pack = this.#packs.get(packId);
    const startedAt = new Date().toISOString();
    const report: SyncReport = {
      packId,
      packName: pack?.meta.name ?? packId,
      ok: false,
      checkedAt: startedAt,
      error: null,
      officialCount: 0,
      added: [],
      renamed: [],
      missing: [],
      returned: [],
      unchanged: 0,
      needsSourceMapping: [],
      unreachable: [],
    };
    try {
      if (!pack?.meta.sync) throw new RadioError('INTERNAL', 'This pack has no official list to sync with.');
      const adapter = SYNC_ADAPTERS[pack.meta.sync.adapter];
      if (!adapter) throw new RadioError('INTERNAL', `Unknown sync adapter "${pack.meta.sync.adapter}".`);
      const { text } = await this.#http.fetchText(pack.meta.sync.url, {
        maxBytes: 6 * 1024 * 1024,
        totalTimeoutMs: 20_000,
        signal,
        headers: { accept: 'text/html,application/json' },
      });
      const entries = adapter(text);
      // A list that suddenly shrinks to a handful of names is far more likely a broken page than
      // a real change; refuse to apply it.
      const floor = Math.min(10, Math.max(1, Math.floor(pack.stations.length / 2)));
      if (entries.length < floor) {
        throw new RadioError(
          'PLAYLIST_INVALID',
          `The official list looked implausible (${entries.length} names); nothing changed.`,
        );
      }
      report.officialCount = entries.length;
      // All or nothing: a failure part-way leaves the catalogue, and the report, as they were.
      const changes: SyncReport = {
        ...report,
        added: [],
        renamed: [],
        missing: [],
        returned: [],
        unchanged: 0,
        needsSourceMapping: [],
      };
      this.#repo.transaction(() => this.#apply(packId, entries, changes));
      Object.assign(report, changes);
      report.unreachable = this.#repo
        .listProviderStations(packId)
        .filter((st) => {
          const probed = this.#repo.listSources(st.id).filter((s) => s.enabled && s.lastProbeAt !== null);
          return probed.length > 0 && probed.every((s) => s.verificationState === 'offline');
        })
        .map((st) => st.displayName);
      report.ok = true;
    } catch (err) {
      report.error = err instanceof RadioError ? err.userMessage : errorMessage(err);
      this.#log.warn({ packId, error: report.error }, 'catalogue sync failed; keeping existing entries');
    }
    this.#repo.insertSyncReport({
      provider: packId,
      startedAt,
      finishedAt: new Date().toISOString(),
      success: report.ok,
      trigger,
      summary: report,
    });
    this.#meta.set(`catalogue.${packId}.lastSyncAttempt`, startedAt);
    return report;
  }

  #apply(packId: string, entries: OfficialEntry[], report: SyncReport): void {
    const today = new Date().toISOString().slice(0, 10);
    const existing = this.#repo.listProviderStations(packId);
    const byExternal = new Map(existing.filter((s) => s.externalId).map((s) => [s.externalId!, s]));
    const byName = new Map(existing.map((s) => [normalizeName(s.displayName), s]));
    const seen = new Set<string>();
    const unmatched: OfficialEntry[] = [];
    for (const e of entries) {
      const match = (e.externalId && byExternal.get(e.externalId)) || byName.get(normalizeName(e.name));
      if (!match) {
        unmatched.push(e);
        continue;
      }
      seen.add(match.id);
      if (match.displayName !== e.name && normalizeName(match.displayName) !== normalizeName(e.name)) {
        this.#repo.renameStation(match.id, e.name, true);
        report.renamed.push({ from: match.displayName, to: e.name });
      }
      if (match.catalogueStatus === 'missing_from_official') report.returned.push(e.name);
      if (match.catalogueStatus !== 'retired') this.#repo.setCatalogueStatus(match.id, 'active', today);
      if (match.displayName === e.name) report.unchanged++;
    }
    const missingNow = existing.filter((s) => !seen.has(s.id) && s.catalogueStatus === 'active');
    for (const e of unmatched) {
      // Name changed and no stable ID: accept a rename only for one clearly similar missing entry.
      const similar = missingNow
        .map((s) => ({ s, sim: similarity(s.displayName, e.name) }))
        .filter((x) => x.sim >= 0.8)
        .sort((a, b) => b.sim - a.sim);
      if (similar.length === 1 || (similar.length > 1 && similar[0]!.sim - similar[1]!.sim > 0.1)) {
        const target = similar[0]!.s;
        this.#repo.renameStation(target.id, e.name, true);
        this.#repo.setCatalogueStatus(target.id, 'active', today);
        seen.add(target.id);
        missingNow.splice(missingNow.indexOf(target), 1);
        report.renamed.push({ from: target.displayName, to: e.name });
        continue;
      }
      const base = slugify(e.name) || 'station';
      let slug = base;
      let n = 2;
      while (this.#repo.getStation(`${packId}:${slug}`)) slug = `${base}-${n++}`;
      this.#repo.upsertProviderStation({
        id: `${packId}:${slug}`,
        provider: packId,
        slug,
        externalId: e.externalId,
        displayName: e.name,
        aliases: [],
        tags: [],
        category: null,
        sortOrder: 5000 + entries.indexOf(e),
        officialPageUrl: null,
        officialLastSeenAt: today,
        catalogueStatus: 'active',
        description: null,
      });
      report.added.push(e.name);
      report.needsSourceMapping.push(e.name);
    }
    for (const s of missingNow) {
      if (seen.has(s.id)) continue;
      this.#repo.setCatalogueStatus(s.id, 'missing_from_official');
      report.missing.push(s.displayName);
    }
    this.#log.info(
      { packId, added: report.added.length, renamed: report.renamed.length, missing: report.missing.length },
      'catalogue synced',
    );
  }
}
