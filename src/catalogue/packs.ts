import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { StationRepository } from '../persistence/repositories/stations.ts';
import { rootPath } from '../shared/paths.ts';
import { normalizeName } from '../shared/text.ts';
import { SYNC_ADAPTERS } from './sync-adapters.ts';

/**
 * Station packs (FR-001). A pack is a folder with three reviewable JSON files:
 *
 *   pack.json      metadata: id, name, categories, brand labels, optional official-list sync
 *   stations.json  the stations (slug, name, aliases, category, tags, order …)
 *   sources.json   candidate stream URLs per station, each with provenance
 *
 * Station IDs are `<packId>:<slug>`. Nothing in the bot is specific to any pack: the
 * built-in packs ship in `catalog/packs/`, and operators can add their own in EXTRA_PACKS_DIR.
 */

const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Slugs stay short so a station id (`<packId>:<slug>`, at most 65 characters) fits inside the
// signed button ids, which Discord caps at 100 characters.
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const CUSTOM_PROVIDER = 'custom';

const packMetaSchema = z.object({
  schemaVersion: z.literal(1),
  id: z
    .string()
    .regex(ID)
    .refine((v) => v !== CUSTOM_PROVIDER, '"custom" is reserved'),
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  /** Shown with the pack; set for packs of stations the project is not affiliated with. */
  disclaimer: z.string().max(500).nullable().default(null),
  order: z.number().int().min(0).max(10_000).default(100),
  enabledByDefault: z.boolean().default(true),
  /** Publisher/brand names that say nothing about which programme a feed carries (§3.1). */
  brandLabels: z.array(z.string().min(1).max(60)).max(50).default([]),
  categories: z
    .array(z.object({ id: z.string().regex(SLUG), name: z.string().min(1).max(60) }))
    .max(25)
    .default([]),
  sync: z
    .object({
      adapter: z.string().refine((a) => a in SYNC_ADAPTERS, 'unknown sync adapter'),
      url: z.string().url(),
    })
    .nullable()
    .default(null),
  snapshotDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
});

const stationSchema = z.object({
  slug: z.string().regex(SLUG),
  displayName: z.string().min(1).max(100),
  externalId: z.string().max(64).nullable().default(null),
  aliases: z.array(z.string().min(1).max(100)).max(20).default([]),
  category: z.string().regex(SLUG).nullable().default(null),
  tags: z.array(z.string().min(1).max(40)).max(30).default([]),
  order: z.number().int().min(0).max(100_000),
  officialPage: z.string().url().nullable().default(null),
  catalogueStatus: z.enum(['active', 'missing_from_official', 'retired']).default('active'),
  catalogueLastSeen: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  description: z.string().max(300).nullable().default(null),
});

const sourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
  station: z.string().regex(SLUG),
  url: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://') || u.startsWith('http://'), 'http(s) only'),
  label: z.string().max(60).nullable().default(null),
  priority: z.number().int().min(0).max(10_000).default(100),
  transportHint: z.enum(['http-continuous', 'hls']).nullable().default(null),
  codecHint: z.string().max(20).nullable().default(null),
  provenance: z.enum(['official-player', 'curated']),
  provenanceDetail: z.string().min(1).max(1000),
  enabled: z.boolean().default(true),
  disabledReason: z.string().max(300).nullable().default(null),
});

const stationsFileSchema = z.object({
  schemaVersion: z.literal(1),
  stations: z.array(stationSchema).min(1).max(2000),
});
const sourcesFileSchema = z.object({
  schemaVersion: z.literal(1),
  sources: z.array(sourceSchema).max(10_000),
});

export type PackMeta = z.infer<typeof packMetaSchema>;
export type PackStation = z.infer<typeof stationSchema> & { id: string };
export type PackSource = z.infer<typeof sourceSchema> & { stationId: string };

export interface StationPack {
  meta: PackMeta;
  dir: string;
  stations: PackStation[];
  sources: PackSource[];
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`);
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, where: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    const issues = r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new Error(`${where} is invalid:\n  ${issues.join('\n  ')}`);
  }
  return r.data;
}

/** Loads and cross-validates one pack folder. Throws with a precise message on any problem. */
export function loadPack(dir: string): StationPack {
  const meta = parse(packMetaSchema, readJson(join(dir, 'pack.json')), `${dir}/pack.json`);
  const stationsFile = parse(
    stationsFileSchema,
    readJson(join(dir, 'stations.json')),
    `${dir}/stations.json`,
  );
  const sourcesPath = join(dir, 'sources.json');
  const sourcesFile = existsSync(sourcesPath)
    ? parse(sourcesFileSchema, readJson(sourcesPath), `${dir}/sources.json`)
    : { schemaVersion: 1 as const, sources: [] };

  const categories = new Set(meta.categories.map((c) => c.id));
  const slugs = new Set<string>();
  const labelOwner = new Map<string, string>();
  const stations: PackStation[] = [];
  for (const s of stationsFile.stations) {
    if (slugs.has(s.slug)) throw new Error(`${meta.id}: duplicate station slug "${s.slug}"`);
    slugs.add(s.slug);
    if (s.category && !categories.has(s.category)) {
      throw new Error(`${meta.id}: station "${s.slug}" uses undeclared category "${s.category}"`);
    }
    // A name or alias must identify exactly one station in the pack.
    for (const label of [s.displayName, ...s.aliases]) {
      const key = normalizeName(label);
      const prev = labelOwner.get(key);
      if (prev && prev !== s.slug)
        throw new Error(`${meta.id}: "${label}" is used by both "${prev}" and "${s.slug}"`);
      labelOwner.set(key, s.slug);
    }
    stations.push({ ...s, id: `${meta.id}:${s.slug}` });
  }
  const sourceIds = new Set<string>();
  const urlOwner = new Map<string, string>();
  const sources: PackSource[] = [];
  for (const src of sourcesFile.sources) {
    if (!slugs.has(src.station))
      throw new Error(`${meta.id}: source "${src.id}" references unknown station "${src.station}"`);
    if (sourceIds.has(src.id)) throw new Error(`${meta.id}: duplicate source id "${src.id}"`);
    sourceIds.add(src.id);
    const prev = urlOwner.get(src.url);
    if (prev && prev !== src.station) {
      throw new Error(`${meta.id}: URL of source "${src.id}" is also mapped to station "${prev}"`);
    }
    urlOwner.set(src.url, src.station);
    sources.push({ ...src, stationId: `${meta.id}:${src.station}` });
  }
  return { meta, dir, stations, sources };
}

/** Every immediate sub-folder containing a pack.json. */
export function discoverPackDirs(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => !name.startsWith('.') && !name.startsWith('_'))
    .map((name) => join(root, name))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, 'pack.json')))
    .sort();
}

export const BUILTIN_PACKS_DIR = (): string => rootPath('catalog', 'packs');

export interface PackSelection {
  enabled: ReadonlySet<string>;
  disabled: ReadonlySet<string>;
}

/** The set of loaded packs and which of them are switched on for this installation. */
export class PackRegistry {
  readonly packs: StationPack[];
  readonly #byId: Map<string, StationPack>;
  readonly #enabled: Set<string>;
  readonly #brand = new Map<string, Set<string>>();

  constructor(packs: StationPack[], selection: PackSelection = { enabled: new Set(), disabled: new Set() }) {
    this.packs = [...packs].sort((a, b) => a.meta.order - b.meta.order || a.meta.id.localeCompare(b.meta.id));
    this.#byId = new Map();
    const sourceOwner = new Map<string, string>();
    for (const p of this.packs) {
      if (this.#byId.has(p.meta.id))
        throw new Error(`Two packs use the id "${p.meta.id}" (${this.#byId.get(p.meta.id)!.dir}, ${p.dir})`);
      this.#byId.set(p.meta.id, p);
      for (const s of p.sources) {
        const other = sourceOwner.get(s.id);
        if (other) throw new Error(`Source id "${s.id}" is used by packs "${other}" and "${p.meta.id}"`);
        sourceOwner.set(s.id, p.meta.id);
      }
      this.#brand.set(p.meta.id, new Set(p.meta.brandLabels.map(normalizeName).filter(Boolean)));
    }
    this.#enabled = new Set(
      this.packs
        .filter(
          (p) =>
            (p.meta.enabledByDefault || selection.enabled.has(p.meta.id)) &&
            !selection.disabled.has(p.meta.id),
        )
        .map((p) => p.meta.id),
    );
  }

  /** Loads the built-in packs plus any packs in `extraDir`. */
  static load(extraDir: string | null, selection?: PackSelection): PackRegistry {
    const dirs = [...discoverPackDirs(BUILTIN_PACKS_DIR()), ...(extraDir ? discoverPackDirs(extraDir) : [])];
    return new PackRegistry(dirs.map(loadPack), selection);
  }

  get(id: string): StationPack | null {
    return this.#byId.get(id) ?? null;
  }

  isEnabled(id: string): boolean {
    return this.#enabled.has(id);
  }

  enabledPacks(): StationPack[] {
    return this.packs.filter((p) => this.#enabled.has(p.meta.id));
  }

  /** Sort key: enabled packs in pack order, custom stations after all packs. */
  orderOf(provider: string): number {
    if (provider === CUSTOM_PROVIDER) return Number.MAX_SAFE_INTEGER;
    const idx = this.packs.findIndex((p) => p.meta.id === provider);
    return idx < 0 ? Number.MAX_SAFE_INTEGER - 1 : idx;
  }

  /** Normalised brand labels of a pack, used by identity checks. */
  brandLabels(provider: string): ReadonlySet<string> {
    return this.#brand.get(provider) ?? new Set();
  }

  /** Categories across enabled packs (id → display name). */
  categories(): Array<{ id: string; name: string; packId: string }> {
    return this.enabledPacks().flatMap((p) => p.meta.categories.map((c) => ({ ...c, packId: p.meta.id })));
  }
}

export interface SeedSummary {
  packs: number;
  stationsInserted: number;
  stationsUpdated: number;
  sourcesInserted: number;
  sourcesUpdated: number;
  sourcesDisabled: number;
}

/**
 * Seeds/refreshes every loaded pack. Runtime evidence and guild data are preserved; a source
 * removed from its pack's manifest is disabled, never silently deleted.
 */
export function seedPacks(repo: StationRepository, registry: PackRegistry): SeedSummary {
  const summary: SeedSummary = {
    packs: registry.packs.length,
    stationsInserted: 0,
    stationsUpdated: 0,
    sourcesInserted: 0,
    sourcesUpdated: 0,
    sourcesDisabled: 0,
  };
  for (const pack of registry.packs) {
    for (const s of pack.stations) {
      const r = repo.upsertProviderStation({
        id: s.id,
        provider: pack.meta.id,
        slug: s.slug,
        externalId: s.externalId,
        displayName: s.displayName,
        aliases: s.aliases,
        tags: s.tags,
        category: s.category,
        sortOrder: s.order,
        officialPageUrl: s.officialPage,
        officialLastSeenAt: s.catalogueLastSeen,
        catalogueStatus: s.catalogueStatus,
        description: s.description,
      });
      if (r === 'inserted') summary.stationsInserted++;
      if (r === 'updated') summary.stationsUpdated++;
    }
    const manifestIds = new Set(pack.sources.map((s) => s.id));
    for (const src of pack.sources) {
      const r = repo.upsertSeedSource({
        id: src.id,
        stationId: src.stationId,
        url: src.url,
        label: src.label,
        priority: src.priority,
        transportHint: src.transportHint,
        codecHint: src.codecHint,
        provenance: src.provenance,
        provenanceDetail: src.provenanceDetail,
        rightsStatus: 'unreviewed',
      });
      if (r === 'inserted') summary.sourcesInserted++;
      if (r === 'updated') summary.sourcesUpdated++;
      const current = repo.getSource(src.id);
      const reason = src.enabled ? null : (src.disabledReason ?? 'disabled in the pack manifest');
      if (current && (current.enabled !== src.enabled || current.disabledReason !== reason)) {
        repo.setSourceEnabled(src.id, src.enabled, reason);
      }
    }
    for (const station of repo.listProviderStations(pack.meta.id)) {
      for (const s of repo.listSources(station.id)) {
        if (
          (s.provenance === 'official-player' || s.provenance === 'curated') &&
          !manifestIds.has(s.id) &&
          s.enabled
        ) {
          repo.setSourceEnabled(s.id, false, 'removed from the pack manifest');
          summary.sourcesDisabled++;
        }
      }
    }
  }
  return summary;
}
