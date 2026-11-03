import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { StationRepository } from '../persistence/repositories/stations.ts';
import { rootPath } from '../shared/paths.ts';
import { normalizeName } from '../shared/text.ts';
import { botVersion, compareVersions } from '../shared/version.ts';
import { SYNC_ADAPTERS } from './sync-adapters.ts';

/**
 * Station packs (FR-001). A pack is a folder with three reviewable JSON files:
 *
 *   pack.json      metadata: id, name, owner, version, categories, brand labels, optional official-list sync
 *   stations.json  the stations (slug, name, aliases, category, tags, order …)
 *   sources.json   candidate stream URLs per station, each with provenance
 *
 * Station IDs are `<packId>:<slug>`. Nothing in the bot is specific to any pack. Packs come from
 * three places: `catalog/packs/` (shipped with the bot), EXTRA_PACKS_DIR (the operator's own) and
 * the installed-packs folder in the data directory (downloaded from a pack library, pack-store.ts).
 */

export const PACK_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Slugs stay short so a station id (`<packId>:<slug>`, at most 65 characters) fits inside the
// signed button ids, which Discord caps at 100 characters.
const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const CUSTOM_PROVIDER = 'custom';
/** A pack's version: the date it changed, with `.2`, `.3` … for later changes on the same day. */
export const PACK_VERSION = /^\d{4}\.\d{2}\.\d{2}(\.\d{1,3})?$/;
/** ISO 3166-1 alpha-2 country code. */
const COUNTRY = /^[A-Z]{2}$/;
/** BCP 47 language tag, such as `en`, `fr` or `pt-BR`. */
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export const PACK_OWNER_KINDS = ['broadcaster', 'group', 'curated'] as const;

const packMetaSchema = z.object({
  schemaVersion: z.literal(1),
  id: z
    .string()
    .regex(PACK_ID)
    .refine((v) => v !== CUSTOM_PROVIDER, '"custom" is reserved'),
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  version: z
    .string()
    .regex(PACK_VERSION, 'must be a date such as 2026.11.03 (add .2, .3 … for another change that day)')
    .nullable()
    .default(null),
  /** The company the pack belongs to; a big brand with a pack of its own also names the brand. */
  owner: z
    .object({
      name: z.string().min(1).max(100),
      kind: z.enum(PACK_OWNER_KINDS),
      brand: z.string().min(1).max(100).nullable().default(null),
    })
    .nullable()
    .default(null),
  countries: z
    .array(z.string().regex(COUNTRY, 'must be a two-letter country code such as GB'))
    .max(50)
    .default([]),
  regions: z.array(z.string().min(1).max(60)).max(50).default([]),
  languages: z.array(z.string().regex(LANGUAGE, 'must be a language code such as en')).max(20).default([]),
  /** The oldest Radio Bot that can use this pack; older bots skip it. */
  minBotVersion: z
    .string()
    .regex(/^\d+\.\d+\.\d+$/)
    .nullable()
    .default(null),
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
  /** Only where it differs from the pack's: for the rare pack that crosses borders. */
  country: z.string().regex(COUNTRY).nullable().default(null),
  region: z.string().min(1).max(60).nullable().default(null),
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

/** Where a pack came from: shipped with the bot, the operator's EXTRA_PACKS_DIR, or installed from a library. */
export type PackOrigin = 'builtin' | 'extra' | 'installed';

export interface StationPack {
  meta: PackMeta;
  dir: string;
  stations: PackStation[];
  sources: PackSource[];
  origin: PackOrigin;
  /** SHA-256 of the pack's files as read, so a reload can tell whether anything changed. */
  contentHash: string;
}

/** A pack's three files, as parsed JSON (sources may be absent). */
export interface PackFiles {
  pack: unknown;
  stations: unknown;
  sources?: unknown;
}

export const PACK_FILE_NAMES = ['pack.json', 'stations.json', 'sources.json'] as const;

function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${where}: ${(err as Error).message}`);
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

/** Hash of a pack's file texts, in a fixed order (an absent sources.json counts as empty). */
export function packContentHash(texts: ReadonlyArray<string | null>): string {
  const h = createHash('sha256');
  for (const t of texts) h.update(`${t?.length ?? -1}:`).update(t ?? '');
  return h.digest('hex');
}

/** Loads and cross-validates one pack folder. Throws with a precise message on any problem. */
export function loadPack(dir: string, origin: PackOrigin = 'builtin'): StationPack {
  const texts: Array<string | null> = [];
  const parsed: unknown[] = [];
  for (const name of PACK_FILE_NAMES) {
    const path = join(dir, name);
    let text: string | null = null;
    if (name !== 'sources.json' || existsSync(path)) {
      try {
        text = readFileSync(path, 'utf8');
      } catch (err) {
        throw new Error(`${path}: ${(err as Error).message}`);
      }
    }
    texts.push(text);
    parsed.push(text === null ? undefined : parseJson(text, path));
    // pack.json first, so a broken one is reported before anything it would explain.
    if (name === 'pack.json') parse(packMetaSchema, parsed[0], `${dir}/pack.json`);
  }
  const [pack, stations, sources] = parsed;
  return { ...parsePack({ pack, stations, sources }, dir), origin, contentHash: packContentHash(texts) };
}

/**
 * Validates a pack from its parsed files (`where` names it in errors). Throws with a precise
 * message on any problem, including a pack that needs a newer Radio Bot than this one.
 */
export function parsePack(files: PackFiles, where: string): Omit<StationPack, 'origin' | 'contentHash'> {
  const dir = where;
  const meta = parse(packMetaSchema, files.pack, `${where}/pack.json`);
  if (meta.minBotVersion && compareVersions(botVersion(), meta.minBotVersion) < 0) {
    throw new Error(
      `${where}/pack.json: this pack needs Radio Bot ${meta.minBotVersion} or later (this is ${botVersion()})`,
    );
  }
  const stationsFile = parse(stationsFileSchema, files.stations, `${where}/stations.json`);
  const sourcesFile =
    files.sources === undefined
      ? { schemaVersion: 1 as const, sources: [] }
      : parse(sourcesFileSchema, files.sources, `${where}/sources.json`);

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

/** An installed pack that wasn't loaded, and why. */
export interface SkippedPack {
  dir: string;
  reason: string;
}

/**
 * Why `pack` can't join `packs` (a pack id or source id already used), or null if it can. With
 * `replacing`, a loaded pack with the same id is the one it replaces, so only its sources count.
 */
export function packConflict(
  packs: readonly StationPack[],
  pack: StationPack,
  opts: { replacing?: boolean } = {},
): string | null {
  const other = packs.find((p) => p.meta.id === pack.meta.id);
  if (other && !opts.replacing) return `Two packs use the id "${pack.meta.id}" (${other.dir}, ${pack.dir})`;
  const sourceOwner = new Map<string, string>();
  for (const p of packs) {
    if (p.meta.id === pack.meta.id) continue;
    for (const s of p.sources) sourceOwner.set(s.id, p.meta.id);
  }
  for (const s of pack.sources) {
    const owner = sourceOwner.get(s.id);
    if (owner) return `Source id "${s.id}" is used by packs "${owner}" and "${pack.meta.id}"`;
  }
  return null;
}

/**
 * The set of loaded packs and which of them are switched on for this installation. Installed packs
 * can be added, replaced and removed while the bot runs (`put`, `drop`); everything that asks the
 * registry (visibility, brand labels, order) sees the change at once.
 */
export class PackRegistry {
  #packs: StationPack[] = [];
  readonly #byId = new Map<string, StationPack>();
  readonly #enabled = new Set<string>();
  readonly #brand = new Map<string, Set<string>>();
  readonly #selection: PackSelection;
  /** Installed packs that failed their checks at start-up or on a reload. */
  skipped: SkippedPack[] = [];

  constructor(packs: StationPack[], selection: PackSelection = { enabled: new Set(), disabled: new Set() }) {
    this.#selection = selection;
    for (const p of packs) {
      const conflict = packConflict(this.#packs, p);
      if (conflict) throw new Error(conflict);
      this.#packs.push(p);
    }
    this.#rebuild();
  }

  #rebuild(): void {
    this.#packs.sort((a, b) => a.meta.order - b.meta.order || a.meta.id.localeCompare(b.meta.id));
    this.#byId.clear();
    this.#brand.clear();
    this.#enabled.clear();
    for (const p of this.#packs) {
      this.#byId.set(p.meta.id, p);
      this.#brand.set(p.meta.id, new Set(p.meta.brandLabels.map(normalizeName).filter(Boolean)));
      if (
        (p.meta.enabledByDefault || this.#selection.enabled.has(p.meta.id)) &&
        !this.#selection.disabled.has(p.meta.id)
      )
        this.#enabled.add(p.meta.id);
    }
  }

  /**
   * Loads the built-in packs, any packs in `extraDir` and any installed packs in `installedDir`.
   * A mistake in a built-in or extra pack stops start-up, so its author sees it at once; an
   * installed pack that fails its checks or clashes with another is skipped (see `skipped`), so
   * one bad download never takes the radio off the air.
   */
  static load(
    extraDir: string | null,
    selection?: PackSelection,
    installedDir: string | null = null,
  ): PackRegistry {
    const strict = [
      ...discoverPackDirs(BUILTIN_PACKS_DIR()).map((d) => loadPack(d, 'builtin')),
      ...(extraDir ? discoverPackDirs(extraDir).map((d) => loadPack(d, 'extra')) : []),
    ];
    const registry = new PackRegistry(strict, selection);
    // The installed folder may also be EXTRA_PACKS_DIR; its packs are then loaded once, strictly.
    if (installedDir && !(extraDir && resolve(extraDir) === resolve(installedDir))) {
      for (const dir of discoverPackDirs(installedDir)) {
        try {
          registry.put(loadPack(dir, 'installed'));
        } catch (err) {
          registry.skipped.push({ dir, reason: (err as Error).message });
        }
      }
    }
    return registry;
  }

  get packs(): readonly StationPack[] {
    return this.#packs;
  }

  /**
   * Adds a pack, or replaces the installed pack with the same id. Throws if it clashes with another,
   * or would replace a built-in or EXTRA_PACKS_DIR pack.
   */
  put(pack: StationPack): void {
    const current = this.#byId.get(pack.meta.id);
    const conflict =
      current && current.origin !== 'installed'
        ? `Two packs use the id "${pack.meta.id}" (${current.dir}, ${pack.dir})`
        : packConflict(this.#packs, pack, { replacing: true });
    if (conflict) throw new Error(conflict);
    this.#packs = [...this.#packs.filter((p) => p.meta.id !== pack.meta.id), pack];
    this.skipped = this.skipped.filter((s) => s.dir !== pack.dir);
    this.#rebuild();
  }

  /** Unloads a pack. Its stations stay in the database, hidden, so favourites come back with it. */
  drop(id: string): boolean {
    const before = this.#packs.length;
    this.#packs = this.#packs.filter((p) => p.meta.id !== id);
    this.#rebuild();
    return this.#packs.length !== before;
  }

  get(id: string): StationPack | null {
    return this.#byId.get(id) ?? null;
  }

  isEnabled(id: string): boolean {
    return this.#enabled.has(id);
  }

  enabledPacks(): StationPack[] {
    return this.#packs.filter((p) => this.#enabled.has(p.meta.id));
  }

  /** Sort key: enabled packs in pack order, custom stations after all packs. */
  orderOf(provider: string): number {
    if (provider === CUSTOM_PROVIDER) return Number.MAX_SAFE_INTEGER;
    const idx = this.#packs.findIndex((p) => p.meta.id === provider);
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
  const summary = emptySeedSummary(registry.packs.length);
  for (const pack of registry.packs) {
    seedStations(repo, pack, pack.stations, summary);
    seedSources(repo, pack.sources, summary);
    disableRemovedSources(repo, pack, summary);
  }
  return summary;
}

function emptySeedSummary(packs: number): SeedSummary {
  return {
    packs,
    stationsInserted: 0,
    stationsUpdated: 0,
    sourcesInserted: 0,
    sourcesUpdated: 0,
    sourcesDisabled: 0,
  };
}

/** Rows written per transaction by `seedPackInSlices`, with the event loop given back in between. */
const SEED_SLICE = 50;

/**
 * Seeds one pack while the bot runs: the same writes as `seedPacks`, in small transactions with
 * the event loop given back between them, so a pack of 2000 stations never holds up voice packets.
 */
export async function seedPackInSlices(
  repo: StationRepository,
  transaction: <T>(fn: () => T) => T,
  pack: StationPack,
): Promise<SeedSummary> {
  const summary = emptySeedSummary(1);
  const pause = () => new Promise<void>((r) => setImmediate(r));
  for (let i = 0; i < pack.stations.length; i += SEED_SLICE) {
    transaction(() => seedStations(repo, pack, pack.stations.slice(i, i + SEED_SLICE), summary));
    await pause();
  }
  for (let i = 0; i < pack.sources.length; i += SEED_SLICE) {
    transaction(() => seedSources(repo, pack.sources.slice(i, i + SEED_SLICE), summary));
    await pause();
  }
  transaction(() => disableRemovedSources(repo, pack, summary));
  return summary;
}

function seedStations(
  repo: StationRepository,
  pack: StationPack,
  stations: readonly PackStation[],
  summary: SeedSummary,
): void {
  for (const s of stations) {
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
}

function seedSources(repo: StationRepository, sources: readonly PackSource[], summary: SeedSummary): void {
  for (const src of sources) {
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
}

function disableRemovedSources(repo: StationRepository, pack: StationPack, summary: SeedSummary): void {
  const manifestIds = new Set(pack.sources.map((s) => s.id));
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
