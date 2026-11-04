import type {
  BitrateEvidence,
  CatalogueStatus,
  Confidence,
  IdentityEvidence,
  IdentityStatus,
  Provider,
  QualityConfidence,
  RightsStatus,
  SourceProvenance,
  Station,
  StationSource,
  Transport,
  VerificationState,
} from '../../catalogue/types.ts';
import { type Db, nowIso, type Params, parseJson, parseJsonArray, type Row } from '../db.ts';

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown): number | null =>
  typeof v === 'number' || typeof v === 'bigint' ? Number(v) : null;

export function mapStation(r: Row): Station {
  return {
    id: String(r.id),
    provider: r.provider as Provider,
    guildId: str(r.guild_id),
    slug: String(r.canonical_slug),
    externalId: str(r.external_id),
    displayName: String(r.display_name),
    aliases: parseJsonArray(r.aliases_json),
    description: str(r.description),
    tags: parseJsonArray(r.genre_tags_json),
    category: str(r.category),
    sortOrder: num(r.sort_order) ?? 1000,
    websiteUrl: str(r.website_url),
    language: str(r.language),
    officialPageUrl: str(r.official_page_url),
    officialLastSeenAt: str(r.official_catalog_last_seen_at),
    catalogueStatus: r.catalogue_status as CatalogueStatus,
    createdById: str(r.created_by_id),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    retiredAt: str(r.retired_at),
  };
}

interface StationLists {
  builtin: Station[];
  builtinActive: Station[];
  /** Each server's own custom stations, so listing them never scans every server's. */
  custom: Map<string, Station[]>;
}

interface StationsCache {
  version: number;
  /** In catalogue order: pack stations first, then custom stations. */
  all: Station[];
  byId: Map<string, Station>;
  /** Worked out from `all` when first asked for, so a run of writes doesn't redo it for each row. */
  lists: StationLists | null;
}

interface SourcesCache {
  version: number;
  byId: Map<string, StationSource>;
  /** Each list by priority and ID; in station ID order while `sorted`. */
  byStation: Map<string, StationSource[]>;
  /** False once a station's first source was added in place (at the end of the map). */
  sorted: boolean;
}

/**
 * SQLite's `NOCASE` collation: only ASCII letters fold, and strings compare by code point (the
 * order of their UTF-8 bytes), which differs from UTF-16 order only for surrogate pairs.
 */
export function compareNoCase(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    if (x >= 65 && x <= 90) x += 32;
    if (y >= 65 && y <= 90) y += 32;
    if (x === y) continue;
    const xs = x >= 0xd800 && x <= 0xdfff;
    const ys = y >= 0xd800 && y <= 0xdfff;
    // A surrogate stands for a code point above U+FFFF, so it sorts after any other unit.
    return xs === ys ? x - y : xs ? 1 : -1;
  }
  return a.length - b.length;
}

/**
 * The order of the full station read (`STATION_ORDER`): pack stations by pack, order, name and
 * ID; custom stations last.
 */
function byCatalogueOrder(a: Station, b: Station): number {
  const ca = a.provider === 'custom' ? 1 : 0;
  const cb = b.provider === 'custom' ? 1 : 0;
  if (ca !== cb) return ca - cb;
  if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
  return (
    a.sortOrder - b.sortOrder ||
    compareNoCase(a.displayName, b.displayName) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

const STATION_ORDER = `ORDER BY CASE provider WHEN 'custom' THEN 1 ELSE 0 END, provider, sort_order,
  display_name COLLATE NOCASE, id`;

/** Where `item` goes in `list` (sorted by `cmp`): after everything that sorts before or with it. */
function insertionPoint<T>(list: readonly T[], item: T, cmp: (a: T, b: T) => number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (cmp(list[mid]!, item) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function stationLists(cache: StationsCache): StationLists {
  cache.lists ??= deriveStations(cache.all);
  return cache.lists;
}

/**
 * Puts one re-read station row into the cached list where a full read would put it, or takes it
 * out if the row is gone. A new pack station or a rename touches just that row, so installing a
 * pack or syncing one never reads every station again.
 */
function placeStation(cache: StationsCache, id: string, row: Row | undefined): void {
  const prev = cache.byId.get(id);
  if (prev) {
    cache.all.splice(cache.all.indexOf(prev), 1);
    cache.byId.delete(id);
  }
  if (row) {
    const next = freezeStation(mapStation(row));
    cache.all.splice(insertionPoint(cache.all, next, byCatalogueOrder), 0, next);
    cache.byId.set(id, next);
  }
  cache.lists = null;
}

function deriveStations(all: Station[]): StationLists {
  const builtin: Station[] = [];
  const builtinActive: Station[] = [];
  const custom = new Map<string, Station[]>();
  for (const st of all) {
    if (st.provider !== 'custom') {
      builtin.push(st);
      if (st.catalogueStatus !== 'retired') builtinActive.push(st);
    } else if (st.guildId) {
      const list = custom.get(st.guildId);
      if (list) list.push(st);
      else custom.set(st.guildId, [st]);
    }
  }
  return { builtin, builtinActive, custom };
}

/**
 * Puts one server's re-read custom stations into the cached lists. Custom stations come after
 * every pack station, and no other server's list changes, so nothing else is read again.
 */
function replaceGuildCustom(cache: StationsCache, guildId: string, fresh: Station[]): void {
  const lists = stationLists(cache);
  for (const st of lists.custom.get(guildId) ?? []) cache.byId.delete(st.id);
  for (const st of fresh) cache.byId.set(st.id, st);
  cache.all = [...cache.all.filter((st) => st.guildId !== guildId), ...fresh];
  if (fresh.length > 0) lists.custom.set(guildId, fresh);
  else lists.custom.delete(guildId);
}

const byPriority = (a: StationSource, b: StationSource) =>
  a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Puts one re-read source row into the cached lists: changed in place (the frequent case: check
 * and playback results), new, moved to another station or priority, or (no row) deleted. Only
 * that station's short list is touched, so seeding a pack never reads every source again.
 */
function patchSource(cache: SourcesCache, id: string, row: Row | undefined): void {
  const prev = cache.byId.get(id);
  const next = row ? freezeSource(mapSource(row)) : undefined;
  if (prev && next && prev.stationId === next.stationId && prev.priority === next.priority) {
    cache.byId.set(id, next);
    const list = cache.byStation.get(next.stationId)!;
    list[list.indexOf(prev)] = next;
    return;
  }
  if (prev) {
    cache.byId.delete(id);
    const list = cache.byStation.get(prev.stationId)!;
    list.splice(list.indexOf(prev), 1);
    if (list.length === 0) cache.byStation.delete(prev.stationId);
  }
  if (next) {
    cache.byId.set(id, next);
    const list = cache.byStation.get(next.stationId);
    if (list) list.splice(insertionPoint(list, next, byPriority), 0, next);
    else {
      cache.byStation.set(next.stationId, [next]);
      cache.sorted = false;
    }
  }
}

/** Drops every cached source of stations that were deleted (their sources went with them). */
function dropStationSources(cache: SourcesCache, stationIds: readonly string[]): void {
  for (const id of stationIds) {
    for (const src of cache.byStation.get(id) ?? []) cache.byId.delete(src.id);
    cache.byStation.delete(id);
  }
}

function freezeStation(st: Station): Station {
  Object.freeze(st.aliases);
  Object.freeze(st.tags);
  return Object.freeze(st);
}

function freezeSource(src: StationSource): StationSource {
  Object.freeze(src.identityEvidence);
  return Object.freeze(src);
}

export function mapSource(r: Row): StationSource {
  return {
    id: String(r.id),
    stationId: String(r.station_id),
    url: String(r.stream_url),
    label: str(r.label),
    priority: num(r.priority) ?? 100,
    transportHint: str(r.transport_hint) as Transport | null,
    codecHint: str(r.codec_hint),
    transport: (str(r.transport) ?? 'unknown') as Transport,
    container: str(r.container),
    codec: str(r.codec),
    profile: str(r.profile),
    sampleRateHz: num(r.sample_rate_hz),
    channels: num(r.channel_count),
    channelLayout: str(r.channel_layout),
    advertisedBitrateKbps: num(r.advertised_bitrate_kbps),
    codecBitrateKbps: num(r.codec_bitrate_kbps),
    measuredBitrateKbps: num(r.measured_bitrate_kbps),
    bitrateConfidence: (str(r.bitrate_confidence) ?? 'unknown') as BitrateEvidence,
    identityStatus: r.identity_status as IdentityStatus,
    identityConfidence: (str(r.identity_confidence) ?? 'none') as Confidence,
    identityEvidence: parseJson<IdentityEvidence[]>(r.identity_evidence_json, []),
    identityOverride: str(r.identity_override) as 'verified' | 'mismatch' | null,
    qualityConfidence: (str(r.quality_confidence) ?? 'unknown') as QualityConfidence,
    rightsStatus: r.rights_status as RightsStatus,
    provenance: r.source_provenance as SourceProvenance,
    provenanceDetail: str(r.provenance_detail),
    enabled: Number(r.is_enabled) === 1,
    disabledReason: str(r.disabled_reason),
    verificationState: r.verification_state as VerificationState,
    icyName: str(r.icy_name),
    effectiveHost: str(r.effective_host),
    startupMs: num(r.startup_ms),
    lastProbeAt: str(r.last_probe_at),
    lastSuccessAt: str(r.last_success_at),
    lastFailureAt: str(r.last_failure_at),
    lastFailureCode: str(r.last_failure_code),
    healthScore: num(r.health_score) ?? 50,
    cooldownUntil: str(r.cooldown_until),
    failureCount: num(r.failure_count) ?? 0,
    consecutiveFailures: num(r.consecutive_failures) ?? 0,
    cooldownTrips: num(r.cooldown_trips) ?? 0,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export interface StationSeed {
  id: string;
  provider: Provider;
  slug: string;
  externalId: string | null;
  displayName: string;
  aliases: string[];
  tags: string[];
  category: string | null;
  sortOrder: number;
  officialPageUrl: string | null;
  officialLastSeenAt: string | null;
  catalogueStatus: CatalogueStatus;
  description: string | null;
}

export interface SourceSeed {
  id: string;
  stationId: string;
  url: string;
  label: string | null;
  priority: number;
  transportHint: Transport | null;
  codecHint: string | null;
  provenance: SourceProvenance;
  provenanceDetail: string | null;
  rightsStatus: RightsStatus;
}

export interface NewCustomStation {
  id: string;
  guildId: string;
  slug: string;
  displayName: string;
  description: string | null;
  category: string | null;
  websiteUrl: string | null;
  language: string | null;
  createdById: string;
}

export interface ProbeResultRecord {
  sourceId: string;
  startedAt: string;
  durationMs: number;
  kind: 'basic' | 'identity' | 'playback';
  effectiveHost: string | null;
  transport: Transport | null;
  container: string | null;
  codec: string | null;
  profile: string | null;
  sampleRateHz: number | null;
  channels: number | null;
  bitrateEstimate: number | null;
  bitrateEvidence: BitrateEvidence | null;
  startupMs: number | null;
  headersSummary: Record<string, unknown>;
  manifestSummary: Record<string, unknown>;
  identityEvidence: IdentityEvidence[];
  success: boolean;
  failureCode: string | null;
  failureDetail: string | null;
  confidence: Confidence;
  probeVersion: number;
}

export interface StoredProbeResult extends ProbeResultRecord {
  id: number;
}

export interface PruneProbeHistoryOptions {
  /** Results kept per source (PROBE_HISTORY_LIMIT). */
  keep: number;
  /** Results older than this many days go (PROBE_HISTORY_DAYS). */
  days: number;
  /** Now, in milliseconds since the epoch (default `Date.now()`). */
  now?: number;
  /** Awaited between batches: gives the event loop (and voice packets) a turn. */
  pause: () => Promise<void>;
  signal?: AbortSignal;
  /** Also cut every source's history to `keep`, when that limit is lower than the last one applied. */
  trimEverySource: boolean;
  /** Most rows one statement deletes (default 250). */
  batch?: number;
}

/** Rows deleted per statement by `pruneProbeHistory`: about a millisecond's work. */
const PRUNE_BATCH = 250;
/** Sources whose history the count pass trims between two pauses. */
const PRUNE_SOURCES_PER_PAGE = 50;
/** The per-source limit the count pass last applied to every source. */
const PROBE_LIMIT_KEY = 'probe_history.trimmed_to';

/** Source fields updated from a probe. */
export interface SourceProbePatch {
  transport?: Transport;
  container?: string | null;
  codec?: string | null;
  profile?: string | null;
  sampleRateHz?: number | null;
  channels?: number | null;
  channelLayout?: string | null;
  advertisedBitrateKbps?: number | null;
  codecBitrateKbps?: number | null;
  measuredBitrateKbps?: number | null;
  bitrateConfidence?: BitrateEvidence;
  identityStatus?: IdentityStatus;
  identityConfidence?: Confidence;
  identityEvidence?: IdentityEvidence[];
  qualityConfidence?: QualityConfidence;
  verificationState?: VerificationState;
  icyName?: string | null;
  effectiveHost?: string | null;
  startupMs?: number | null;
  lastProbeAt?: string;
}

const PATCH_COLUMNS: Record<keyof SourceProbePatch, string> = {
  transport: 'transport',
  container: 'container',
  codec: 'codec',
  profile: 'profile',
  sampleRateHz: 'sample_rate_hz',
  channels: 'channel_count',
  channelLayout: 'channel_layout',
  advertisedBitrateKbps: 'advertised_bitrate_kbps',
  codecBitrateKbps: 'codec_bitrate_kbps',
  measuredBitrateKbps: 'measured_bitrate_kbps',
  bitrateConfidence: 'bitrate_confidence',
  identityStatus: 'identity_status',
  identityConfidence: 'identity_confidence',
  identityEvidence: 'identity_evidence_json',
  qualityConfidence: 'quality_confidence',
  verificationState: 'verification_state',
  icyName: 'icy_name',
  effectiveHost: 'effective_host',
  startupMs: 'startup_ms',
  lastProbeAt: 'last_probe_at',
};

export class StationRepository {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /**
   * Every station and every source, read and parsed once and reused, on the thread that sends
   * voice packets. Stations and sources are cached apart, and every write re-reads just the rows
   * it changed and puts them in place: background checks and playback results write sources all
   * the time, and seeding a pack or a sync adds and renames stations by the thousand. A full
   * re-read of a big catalogue (tens of milliseconds for each table) would hold up voice packets.
   * A change to a server's custom stations re-reads only that server's. A write made while a table
   * wasn't cached leaves the next read to read it all again, and so does a rollback of a
   * transaction that wrote that table (or read it into the cache); other rollbacks keep the cache.
   * The rows are frozen because they are shared.
   */
  #stations: StationsCache | null = null;
  #sources: SourcesCache | null = null;
  /** Writes that the caches didn't apply in place, so the next read starts again. */
  #stationWrites = 0;
  #sourceWrites = 0;
  /** Every station or source write, and every rollback that undid one: see `changeCount`. */
  #changes = 0;

  /** Called by the database when a transaction that wrote stations, or cached them, rolls back. */
  readonly #stationsUndone = (): void => {
    this.#stationWrites++;
    this.#changes++;
  };

  readonly #sourcesUndone = (): void => {
    this.#sourceWrites++;
    this.#changes++;
  };

  /**
   * Goes up on every station or source write (in place in the caches or not) and on every rollback
   * that may have undone one. Never goes down: a cheap key for anything worked out from stations
   * and sources, valid while it stays the same.
   */
  get changeCount(): number {
    return this.#changes;
  }

  /** Bookkeeping for a write to the stations table (whether or not it reached the cache). */
  #stationsWritten(): void {
    this.#changes++;
    this.#db.onRollback(this.#stationsUndone);
  }

  #sourcesWritten(): void {
    this.#changes++;
    this.#db.onRollback(this.#sourcesUndone);
  }

  /** The cached stations, if still current (single-row reads don't rebuild: seeding writes between them). */
  #currentStations(): StationsCache | null {
    return this.#stations?.version === this.#stationWrites ? this.#stations : null;
  }

  #currentSources(): SourcesCache | null {
    return this.#sources?.version === this.#sourceWrites ? this.#sources : null;
  }

  #cachedStations(): StationsCache {
    const current = this.#currentStations();
    if (current) return current;
    const all = this.#db
      .all(`SELECT * FROM stations ${STATION_ORDER}`)
      .map((r) => freezeStation(mapStation(r)));
    this.#stations = { version: this.#stationWrites, all, byId: new Map(), lists: null };
    for (const st of all) this.#stations.byId.set(st.id, st);
    // Read inside a transaction, it may hold rows that a rollback takes back.
    this.#db.onRollback(this.#stationsUndone);
    return this.#stations;
  }

  #cachedSources(): SourcesCache {
    const current = this.#currentSources();
    if (current) return current;
    const all = this.#db
      .all('SELECT * FROM station_sources ORDER BY station_id, priority, id')
      .map((r) => freezeSource(mapSource(r)));
    const byStation = new Map<string, StationSource[]>();
    for (const src of all) {
      const list = byStation.get(src.stationId);
      if (list) list.push(src);
      else byStation.set(src.stationId, [src]);
    }
    for (const list of byStation.values()) list.sort(byPriority);
    this.#sources = {
      version: this.#sourceWrites,
      byId: new Map(all.map((x) => [x.id, x])),
      byStation,
      sorted: true,
    };
    this.#db.onRollback(this.#sourcesUndone);
    return this.#sources;
  }

  /**
   * A write that may add a pack station or change its place in the list (a rename, a new order):
   * only that row is read again, and put where a full read would put it.
   */
  #writeStationPlaced(id: string, sql: string, params: Params): void {
    const cache = this.#currentStations();
    let done = false;
    try {
      this.#db.run(sql, params);
      done = true;
    } finally {
      this.#stationsWritten();
      if (done && cache) placeStation(cache, id, this.#db.get('SELECT * FROM stations WHERE id = ?', [id]));
      else this.#stationWrites++;
    }
  }

  /**
   * A change to one server's custom stations: only that server's are read again. Their order
   * matches the full read's, which puts custom stations last. A delete (`deletes`: the stations
   * it may remove) takes their sources out of the cached sources too (ON DELETE CASCADE).
   */
  #writeGuildCustomStations(
    guildId: string,
    sql: string,
    params: Params,
    deletes: readonly string[] | null = null,
  ): { changes: number; lastInsertRowid: number } {
    const cache = this.#currentStations();
    const sources = deletes ? this.#currentSources() : null;
    let result: { changes: number; lastInsertRowid: number } | null = null;
    try {
      result = this.#db.run(sql, params);
      return result;
    } finally {
      this.#stationsWritten();
      if (deletes) {
        this.#sourcesWritten();
        if (result !== null && sources) {
          if (result.changes > 0) dropStationSources(sources, deletes);
        } else this.#sourceWrites++;
      }
      if (result !== null && cache) {
        const fresh = this.#db
          .all(`SELECT * FROM stations WHERE provider = 'custom' AND guild_id = ? ${STATION_ORDER}`, [
            guildId,
          ])
          .map((r) => freezeStation(mapStation(r)));
        replaceGuildCustom(cache, guildId, fresh);
      } else this.#stationWrites++;
    }
  }

  /** A change to one station that keeps the list's order: only that row is read again. */
  #writeStationRow(id: string, sql: string, params: Params): void {
    const cache = this.#currentStations();
    let done = false;
    try {
      this.#db.run(sql, params);
      done = true;
    } finally {
      this.#stationsWritten();
      if (done && cache) {
        const r = this.#db.get('SELECT * FROM stations WHERE id = ?', [id]);
        const prev = cache.byId.get(id);
        if (r && prev) {
          const next = freezeStation(mapStation(r));
          cache.byId.set(id, next);
          cache.all[cache.all.indexOf(prev)] = next;
          cache.lists = null;
        } else this.#stationWrites++;
      } else this.#stationWrites++;
    }
  }

  /**
   * A change to several stations (IDs as a JSON array) that keeps the list's order: only those
   * rows are read again, in one query.
   */
  #writeStationRows(idsJson: string, sql: string, params: Params): void {
    const cache = this.#currentStations();
    let done = false;
    try {
      this.#db.run(sql, params);
      done = true;
    } finally {
      this.#stationsWritten();
      let patched = false;
      if (done && cache) {
        const rows = this.#db.all('SELECT * FROM stations WHERE id IN (SELECT value FROM json_each(?))', [
          idsJson,
        ]);
        const at = new Map(cache.all.map((st, i) => [st.id, i]));
        patched = rows.every((r) => at.has(r.id as string));
        if (patched) {
          for (const r of rows) {
            const next = freezeStation(mapStation(r));
            cache.byId.set(next.id, next);
            cache.all[at.get(next.id)!] = next;
          }
          cache.lists = null;
        }
      }
      if (!patched) this.#stationWrites++;
    }
  }

  /** A change to one source (or a new one, or a delete): only that row is read again, and put in place. */
  #writeSourceRow(id: string, sql: string, params: Params): { changes: number; lastInsertRowid: number } {
    const cache = this.#currentSources();
    let result: { changes: number; lastInsertRowid: number } | null = null;
    try {
      result = this.#db.run(sql, params);
      return result;
    } finally {
      this.#sourcesWritten();
      if (result !== null && cache)
        patchSource(cache, id, this.#db.get('SELECT * FROM station_sources WHERE id = ?', [id]));
      else this.#sourceWrites++;
    }
  }

  /** Runs several repository writes atomically. */
  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn);
  }

  // ---- stations ----

  getStation(id: string): Station | null {
    const cache = this.#currentStations();
    if (cache) return cache.byId.get(id) ?? null;
    const r = this.#db.get('SELECT * FROM stations WHERE id = ?', [id]);
    return r ? freezeStation(mapStation(r)) : null;
  }

  /** Pack stations plus the given guild's custom stations, in catalogue order. */
  listStations(guildId: string | null, opts: { includeRetired?: boolean } = {}): Station[] {
    const c = stationLists(this.#cachedStations());
    const custom = (guildId ? c.custom.get(guildId) : undefined) ?? [];
    return opts.includeRetired
      ? [...c.builtin, ...custom]
      : [...c.builtinActive, ...custom.filter((st) => st.catalogueStatus !== 'retired')];
  }

  /** Every station from every pack (not custom stations). */
  listBuiltinStations(): Station[] {
    return [...stationLists(this.#cachedStations()).builtin];
  }

  listProviderStations(provider: Provider): Station[] {
    return this.#cachedStations().all.filter((st) => st.provider === provider);
  }

  /** Every pack that has stations in the database (loaded or not), custom stations excluded. */
  providerIds(): string[] {
    return [...new Set(stationLists(this.#cachedStations()).builtin.map((st) => st.provider))];
  }

  /** A station is visible to a guild if it is a provider station or one of its own custom stations. */
  getVisibleStation(guildId: string, id: string): Station | null {
    const s = this.getStation(id);
    if (!s) return null;
    if (s.guildId !== null && s.guildId !== guildId) return null;
    return s;
  }

  upsertProviderStation(seed: StationSeed): 'inserted' | 'updated' | 'unchanged' {
    const existing = this.getStation(seed.id);
    const now = nowIso();
    if (!existing) {
      this.#writeStationPlaced(
        seed.id,
        `INSERT INTO stations (id, provider, guild_id, canonical_slug, external_id, display_name, aliases_json,
           description, genre_tags_json, category, sort_order, official_page_url, official_catalog_last_seen_at,
           catalogue_status, created_at, updated_at, retired_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          seed.id,
          seed.provider,
          seed.slug,
          seed.externalId,
          seed.displayName,
          JSON.stringify(seed.aliases),
          seed.description,
          JSON.stringify(seed.tags),
          seed.category,
          seed.sortOrder,
          seed.officialPageUrl,
          seed.officialLastSeenAt,
          seed.catalogueStatus,
          now,
          now,
          seed.catalogueStatus === 'retired' ? now : null,
        ],
      );
      return 'inserted';
    }
    // Keep a fresher "last seen" from a live sync, and never un-retire via an older manifest.
    const lastSeen =
      existing.officialLastSeenAt &&
      seed.officialLastSeenAt &&
      existing.officialLastSeenAt > seed.officialLastSeenAt
        ? existing.officialLastSeenAt
        : (seed.officialLastSeenAt ?? existing.officialLastSeenAt);
    const aliases = [...new Set([...seed.aliases, ...existing.aliases])];
    // If sync renamed the station (old name kept as an alias), keep the live name until the pack
    // manifest itself is updated, instead of reverting it on every restart.
    const displayName =
      existing.displayName !== seed.displayName && existing.aliases.includes(seed.displayName)
        ? existing.displayName
        : seed.displayName;
    const changed =
      existing.externalId !== (seed.externalId ?? existing.externalId) ||
      existing.displayName !== displayName ||
      JSON.stringify(existing.aliases) !== JSON.stringify(aliases) ||
      JSON.stringify(existing.tags) !== JSON.stringify(seed.tags) ||
      existing.category !== seed.category ||
      existing.sortOrder !== seed.sortOrder ||
      existing.officialPageUrl !== seed.officialPageUrl ||
      existing.description !== seed.description ||
      existing.officialLastSeenAt !== lastSeen ||
      (seed.catalogueStatus === 'retired' && existing.catalogueStatus !== 'retired');
    if (!changed) return 'unchanged';
    this.#writeStationPlaced(
      seed.id,
      `UPDATE stations SET external_id = COALESCE(?, external_id), display_name = ?, aliases_json = ?,
         genre_tags_json = ?, category = ?, sort_order = ?,
         official_page_url = ?, description = ?, official_catalog_last_seen_at = ?,
         catalogue_status = CASE WHEN ? = 'retired' THEN 'retired' ELSE catalogue_status END,
         retired_at = CASE WHEN ? = 'retired' AND retired_at IS NULL THEN ? ELSE retired_at END,
         updated_at = ?
       WHERE id = ?`,
      [
        seed.externalId,
        displayName,
        JSON.stringify(aliases),
        JSON.stringify(seed.tags),
        seed.category,
        seed.sortOrder,
        seed.officialPageUrl,
        seed.description,
        lastSeen,
        seed.catalogueStatus,
        seed.catalogueStatus,
        now,
        now,
        seed.id,
      ],
    );
    return 'updated';
  }

  setCatalogueStatus(id: string, status: CatalogueStatus, lastSeenAt?: string): void {
    const now = nowIso();
    this.#writeStationRow(
      id,
      `UPDATE stations SET catalogue_status = ?,
         official_catalog_last_seen_at = COALESCE(?, official_catalog_last_seen_at),
         retired_at = CASE WHEN ? = 'retired' THEN COALESCE(retired_at, ?) ELSE NULL END,
         updated_at = ? WHERE id = ?`,
      [status, lastSeenAt ?? null, status, now, now, id],
    );
  }

  /**
   * Marks stations active and seen on `day` (what a catalogue sync does for every station still on
   * the official list), in one statement rather than one per station.
   */
  markSeen(ids: readonly string[], day: string): void {
    if (ids.length === 0) return;
    const list = JSON.stringify(ids);
    this.#writeStationRows(
      list,
      `UPDATE stations SET catalogue_status = 'active', official_catalog_last_seen_at = ?, retired_at = NULL,
         updated_at = ? WHERE id IN (SELECT value FROM json_each(?))`,
      [day, nowIso(), list],
    );
  }

  renameStation(id: string, displayName: string, keepOldAsAlias: boolean): void {
    const s = this.getStation(id);
    if (!s) return;
    const aliases = keepOldAsAlias ? [...new Set([...s.aliases, s.displayName])] : s.aliases;
    this.#writeStationPlaced(
      id,
      'UPDATE stations SET display_name = ?, aliases_json = ?, updated_at = ? WHERE id = ?',
      [displayName, JSON.stringify(aliases), nowIso(), id],
    );
  }

  insertCustomStation(s: NewCustomStation): void {
    const now = nowIso();
    this.#writeGuildCustomStations(
      s.guildId,
      `INSERT INTO stations (id, provider, guild_id, canonical_slug, display_name, description, category,
         website_url, language, sort_order, catalogue_status, created_by_id, created_at, updated_at)
       VALUES (?, 'custom', ?, ?, ?, ?, ?, ?, ?, 1000, 'active', ?, ?, ?)`,
      [
        s.id,
        s.guildId,
        s.slug,
        s.displayName,
        s.description,
        s.category,
        s.websiteUrl,
        s.language,
        s.createdById,
        now,
        now,
      ],
    );
  }

  updateCustomStation(
    guildId: string,
    id: string,
    patch: Partial<
      Pick<NewCustomStation, 'displayName' | 'description' | 'category' | 'websiteUrl' | 'language'>
    >,
  ): boolean {
    const s = this.getStation(id);
    if (s?.provider !== 'custom' || s.guildId !== guildId) return false;
    this.#writeGuildCustomStations(
      guildId,
      `UPDATE stations SET display_name = ?, description = ?, category = ?, website_url = ?, language = ?,
         updated_at = ? WHERE id = ? AND guild_id = ?`,
      [
        patch.displayName ?? s.displayName,
        patch.description !== undefined ? patch.description : s.description,
        patch.category !== undefined ? patch.category : s.category,
        patch.websiteUrl !== undefined ? patch.websiteUrl : s.websiteUrl,
        patch.language !== undefined ? patch.language : s.language,
        nowIso(),
        id,
        guildId,
      ],
    );
    return true;
  }

  /** Deletes a guild's custom station. Provider (shipped) stations can never be deleted here. */
  deleteCustomStation(guildId: string, id: string): boolean {
    const r = this.#writeGuildCustomStations(
      guildId,
      "DELETE FROM stations WHERE id = ? AND provider = 'custom' AND guild_id = ?",
      [id, guildId],
      [id],
    );
    return r.changes > 0;
  }

  countCustomStations(guildId: string): number {
    const r = this.#db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM stations WHERE provider = 'custom' AND guild_id = ?",
      [guildId],
    );
    return Number(r?.n ?? 0);
  }

  deleteGuildCustomStations(guildId: string): number {
    const ids = this.#db
      .all<{ id: string }>("SELECT id FROM stations WHERE provider = 'custom' AND guild_id = ?", [guildId])
      .map((r) => r.id);
    return this.#writeGuildCustomStations(
      guildId,
      "DELETE FROM stations WHERE provider = 'custom' AND guild_id = ?",
      [guildId],
      ids,
    ).changes;
  }

  // ---- sources ----

  listSources(stationId: string): StationSource[] {
    return [...(this.#cachedSources().byStation.get(stationId) ?? [])];
  }

  /** Every source, ordered by station, priority and ID. */
  listAllSources(): StationSource[] {
    const cache = this.#cachedSources();
    if (!cache.sorted) {
      cache.byStation = new Map([...cache.byStation].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
      cache.sorted = true;
    }
    return [...cache.byStation.values()].flat();
  }

  getSource(id: string): StationSource | null {
    const cache = this.#currentSources();
    if (cache) return cache.byId.get(id) ?? null;
    const r = this.#db.get('SELECT * FROM station_sources WHERE id = ?', [id]);
    return r ? freezeSource(mapSource(r)) : null;
  }

  /**
   * Inserts or refreshes a manifest source. Runtime evidence (probe results, health,
   * identity overrides) is preserved; a changed URL resets evidence because it is a
   * different endpoint, and so does a move to another station, because the identity
   * evidence was gathered for the old one.
   */
  upsertSeedSource(seed: SourceSeed): 'inserted' | 'updated' | 'unchanged' {
    const existing = this.getSource(seed.id);
    const now = nowIso();
    if (!existing) {
      this.#writeSourceRow(
        seed.id,
        `INSERT INTO station_sources (id, station_id, stream_url, label, priority, transport_hint, codec_hint,
           transport, source_provenance, provenance_detail, rights_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          seed.id,
          seed.stationId,
          seed.url,
          seed.label,
          seed.priority,
          seed.transportHint,
          seed.codecHint,
          seed.transportHint ?? 'unknown',
          seed.provenance,
          seed.provenanceDetail,
          seed.rightsStatus,
          now,
          now,
        ],
      );
      return 'inserted';
    }
    if (existing.url !== seed.url || existing.stationId !== seed.stationId) {
      if (existing.stationId !== seed.stationId) {
        // A server's pin to this source belonged to the old station.
        this.#db.run(
          'DELETE FROM guild_source_preferences WHERE preferred_source_id = ? AND station_id <> ?',
          [seed.id, seed.stationId],
        );
      }
      this.#writeSourceRow(
        seed.id,
        `UPDATE station_sources SET station_id = ?, stream_url = ?, label = ?, priority = ?, transport_hint = ?, codec_hint = ?,
           transport = ?, source_provenance = ?, provenance_detail = ?, rights_status = ?,
           container = NULL, codec = NULL, profile = NULL, sample_rate_hz = NULL, channel_count = NULL,
           channel_layout = NULL, advertised_bitrate_kbps = NULL, codec_bitrate_kbps = NULL,
           measured_bitrate_kbps = NULL, bitrate_confidence = 'unknown', identity_status = 'unverified',
           identity_confidence = 'none', identity_evidence_json = '[]', identity_override = NULL,
           verification_state = 'discovered', health_score = 50, cooldown_until = NULL,
           consecutive_failures = 0, cooldown_trips = 0, updated_at = ?
         WHERE id = ?`,
        [
          seed.stationId,
          seed.url,
          seed.label,
          seed.priority,
          seed.transportHint,
          seed.codecHint,
          seed.transportHint ?? 'unknown',
          seed.provenance,
          seed.provenanceDetail,
          seed.rightsStatus,
          now,
          seed.id,
        ],
      );
      return 'updated';
    }
    if (
      existing.label === seed.label &&
      existing.priority === seed.priority &&
      existing.transportHint === seed.transportHint &&
      existing.codecHint === seed.codecHint &&
      existing.provenance === seed.provenance &&
      existing.provenanceDetail === seed.provenanceDetail &&
      existing.rightsStatus === seed.rightsStatus
    ) {
      return 'unchanged';
    }
    this.#writeSourceRow(
      seed.id,
      `UPDATE station_sources SET label = ?, priority = ?, transport_hint = ?, codec_hint = ?,
         source_provenance = ?, provenance_detail = ?, rights_status = ?, updated_at = ? WHERE id = ?`,
      [
        seed.label,
        seed.priority,
        seed.transportHint,
        seed.codecHint,
        seed.provenance,
        seed.provenanceDetail,
        seed.rightsStatus,
        now,
        seed.id,
      ],
    );
    return 'updated';
  }

  /** The source's stored row, exactly as it is, for `restoreSource`. */
  snapshotSource(id: string): Row | null {
    return this.#db.get('SELECT * FROM station_sources WHERE id = ?', [id]) ?? null;
  }

  /** Puts a source row back exactly as `snapshotSource` captured it, evidence and overrides included. */
  restoreSource(row: Row): void {
    const columns = Object.keys(row).filter((c) => c !== 'id');
    this.#writeSourceRow(
      String(row.id),
      `UPDATE station_sources SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...columns.map((c) => row[c]!), row.id!],
    );
  }

  insertSource(seed: SourceSeed): void {
    this.upsertSeedSource(seed);
  }

  deleteSource(id: string): void {
    this.#writeSourceRow(id, 'DELETE FROM station_sources WHERE id = ?', [id]);
  }

  setSourceEnabled(id: string, enabled: boolean, reason: string | null): void {
    this.#writeSourceRow(
      id,
      'UPDATE station_sources SET is_enabled = ?, disabled_reason = ?, updated_at = ? WHERE id = ?',
      [enabled ? 1 : 0, enabled ? null : reason, nowIso(), id],
    );
  }

  setIdentityOverride(id: string, override: 'verified' | 'mismatch' | null): void {
    this.#writeSourceRow(
      id,
      'UPDATE station_sources SET identity_override = ?, updated_at = ? WHERE id = ?',
      [override, nowIso(), id],
    );
  }

  applyProbePatch(id: string, patch: SourceProbePatch): void {
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    for (const [key, column] of Object.entries(PATCH_COLUMNS) as Array<[keyof SourceProbePatch, string]>) {
      if (!(key in patch)) continue;
      const value = patch[key];
      sets.push(`${column} = ?`);
      params.push(
        key === 'identityEvidence'
          ? JSON.stringify(value ?? [])
          : ((value as string | number | null) ?? null),
      );
    }
    if (sets.length === 0) return;
    sets.push('updated_at = ?');
    params.push(nowIso(), id);
    this.#writeSourceRow(id, `UPDATE station_sources SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  /** Records a healthy observation: resets the failure streak and nudges health up. */
  recordSuccess(id: string, at = nowIso()): void {
    this.#writeSourceRow(
      id,
      `UPDATE station_sources SET last_success_at = ?, consecutive_failures = 0,
         health_score = MIN(100, health_score + 10),
         cooldown_trips = CASE WHEN cooldown_until IS NOT NULL AND cooldown_until < ? THEN 0 ELSE cooldown_trips END,
         cooldown_until = CASE WHEN cooldown_until IS NOT NULL AND cooldown_until < ? THEN NULL ELSE cooldown_until END,
         updated_at = ? WHERE id = ?`,
      [at, at, at, at, id],
    );
  }

  /** Records a failure; returns the updated consecutive failure count. */
  recordFailure(id: string, code: string, at = nowIso()): number {
    this.#writeSourceRow(
      id,
      `UPDATE station_sources SET last_failure_at = ?, last_failure_code = ?, failure_count = failure_count + 1,
         consecutive_failures = consecutive_failures + 1, health_score = MAX(0, health_score - 15), updated_at = ?
       WHERE id = ?`,
      [at, code, at, id],
    );
    return this.getSource(id)?.consecutiveFailures ?? 0;
  }

  setCooldown(id: string, until: string | null): void {
    this.#writeSourceRow(
      id,
      `UPDATE station_sources SET cooldown_until = ?,
         cooldown_trips = CASE WHEN ? IS NULL THEN 0 ELSE cooldown_trips + 1 END,
         verification_state = CASE WHEN ? IS NULL THEN verification_state ELSE 'cooldown' END,
         updated_at = ? WHERE id = ?`,
      [until, until, until, nowIso(), id],
    );
  }

  // ---- probe results ----

  insertProbeResult(p: ProbeResultRecord): number {
    return this.#db.run(
      `INSERT INTO source_probe_results (source_id, started_at, duration_ms, kind, effective_url_host, transport,
         container, codec, profile, sample_rate_hz, channels, bitrate_estimate, bitrate_evidence, startup_ms,
         headers_summary_json, manifest_summary_json, identity_evidence_json, success, failure_code,
         failure_detail, confidence, probe_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        p.sourceId,
        p.startedAt,
        p.durationMs,
        p.kind,
        p.effectiveHost,
        p.transport,
        p.container,
        p.codec,
        p.profile,
        p.sampleRateHz,
        p.channels,
        p.bitrateEstimate,
        p.bitrateEvidence,
        p.startupMs,
        JSON.stringify(p.headersSummary),
        JSON.stringify(p.manifestSummary),
        JSON.stringify(p.identityEvidence),
        p.success ? 1 : 0,
        p.failureCode,
        p.failureDetail,
        p.confidence,
        p.probeVersion,
      ],
    ).lastInsertRowid;
  }

  listProbeResults(sourceId: string, limit = 10): StoredProbeResult[] {
    return this.#db
      .all(
        'SELECT * FROM source_probe_results WHERE source_id = ? ORDER BY started_at DESC, id DESC LIMIT ?',
        [sourceId, limit],
      )
      .map((r) => ({
        id: Number(r.id),
        sourceId: String(r.source_id),
        startedAt: String(r.started_at),
        durationMs: Number(r.duration_ms),
        kind: r.kind as ProbeResultRecord['kind'],
        effectiveHost: str(r.effective_url_host),
        transport: str(r.transport) as Transport | null,
        container: str(r.container),
        codec: str(r.codec),
        profile: str(r.profile),
        sampleRateHz: num(r.sample_rate_hz),
        channels: num(r.channels),
        bitrateEstimate: num(r.bitrate_estimate),
        bitrateEvidence: str(r.bitrate_evidence) as BitrateEvidence | null,
        startupMs: num(r.startup_ms),
        headersSummary: parseJson(r.headers_summary_json, {}),
        manifestSummary: parseJson(r.manifest_summary_json, {}),
        identityEvidence: parseJson(r.identity_evidence_json, []),
        success: Number(r.success) === 1,
        failureCode: str(r.failure_code),
        failureDetail: str(r.failure_detail),
        confidence: (str(r.confidence) ?? 'none') as Confidence,
        probeVersion: Number(r.probe_version),
      }));
  }

  /**
   * Bounds probe history (PRD §11.2) without holding up voice packets: deletes results older than
   * `days` a batch at a time (through the `started_at` index), with `await pause()` between
   * batches. With `trimEverySource`, it also cuts every source's history to its newest `keep`
   * results, but only when `keep` is lower than the limit it last applied (kept in `app_meta`):
   * each new result already trims its own source, so the pass is needed only after
   * PROBE_HISTORY_LIMIT was lowered, or the first time. That pass also goes a batch at a time.
   * Stops between batches once `signal` aborts (the limit is then recorded only when it finished).
   */
  async pruneProbeHistory(o: PruneProbeHistoryOptions): Promise<{ deleted: number }> {
    const batch = Math.max(1, Math.floor(o.batch ?? PRUNE_BATCH));
    const cutoff = new Date((o.now ?? Date.now()) - o.days * 86_400_000).toISOString();
    let deleted = 0;
    for (;;) {
      if (o.signal?.aborted) return { deleted };
      const n = this.#db.run(
        `DELETE FROM source_probe_results WHERE id IN (
           SELECT id FROM source_probe_results WHERE started_at < ? ORDER BY started_at LIMIT ?)`,
        [cutoff, batch],
      ).changes;
      deleted += n;
      if (n < batch) break;
      await o.pause();
    }
    if (!o.trimEverySource) return { deleted };
    const keep = Math.max(0, Math.floor(o.keep));
    const stored = this.#db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', [
      PROBE_LIMIT_KEY,
    ])?.value;
    const applied = stored === undefined ? Number.NaN : Number(stored);
    if (Number.isFinite(applied) && keep >= applied) {
      // A higher limit needs no pass now, but a later, lower one must compare with this one.
      if (keep > applied) this.#setMeta(PROBE_LIMIT_KEY, String(keep));
      return { deleted };
    }
    let after = '';
    for (;;) {
      if (o.signal?.aborted) return { deleted };
      const ids = this.#db.all<{ source_id: string }>(
        `SELECT DISTINCT source_id FROM source_probe_results WHERE source_id > ?
         ORDER BY source_id LIMIT ?`,
        [after, PRUNE_SOURCES_PER_PAGE],
      );
      if (ids.length === 0) break;
      for (const { source_id } of ids) {
        for (;;) {
          const n = this.#db.run(
            `DELETE FROM source_probe_results WHERE id IN (
               SELECT id FROM source_probe_results WHERE source_id = ?
               ORDER BY started_at DESC, id DESC LIMIT ? OFFSET ?)`,
            [source_id, batch, keep],
          ).changes;
          deleted += n;
          if (n < batch) break;
          await o.pause();
          if (o.signal?.aborted) return { deleted };
        }
      }
      after = ids.at(-1)!.source_id;
      await o.pause();
    }
    this.#setMeta(PROBE_LIMIT_KEY, String(keep));
    return { deleted };
  }

  #setMeta(key: string, value: string): void {
    this.#db.run(
      `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, nowIso()],
    );
  }

  /** Keeps the newest `keep` results of one source, through the per-source index. */
  pruneSourceHistory(sourceId: string, keep: number): number {
    return this.#db.run(
      `DELETE FROM source_probe_results WHERE source_id = ? AND id NOT IN (
         SELECT id FROM source_probe_results WHERE source_id = ? ORDER BY started_at DESC, id DESC LIMIT ?
       )`,
      [sourceId, sourceId, keep],
    ).changes;
  }

  // ---- sync reports ----

  insertSyncReport(r: {
    provider: string;
    startedAt: string;
    finishedAt: string;
    success: boolean;
    trigger: string;
    summary: unknown;
  }): void {
    this.#db.run(
      `INSERT INTO catalogue_sync_reports (provider, started_at, finished_at, success, trigger, summary_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [r.provider, r.startedAt, r.finishedAt, r.success ? 1 : 0, r.trigger, JSON.stringify(r.summary)],
    );
    // Kept per pack, so frequent syncs of one pack never evict another pack's history.
    this.#db.run(
      `DELETE FROM catalogue_sync_reports WHERE provider = ? AND id NOT IN (
         SELECT id FROM catalogue_sync_reports WHERE provider = ? ORDER BY id DESC LIMIT 50)`,
      [r.provider, r.provider],
    );
  }

  lastSyncReport(provider: string): { finishedAt: string; success: boolean; summary: unknown } | null {
    const r = this.#db.get(
      'SELECT * FROM catalogue_sync_reports WHERE provider = ? ORDER BY id DESC LIMIT 1',
      [provider],
    );
    if (!r) return null;
    return {
      finishedAt: String(r.finished_at),
      success: Number(r.success) === 1,
      summary: parseJson(r.summary_json, {}),
    };
  }

  /** How the pack's last sync ended, without reading its (possibly long) summary. */
  lastSyncOutcome(provider: string): { finishedAt: string; success: boolean } | null {
    const r = this.#db.get<{ finished_at: string; success: number }>(
      'SELECT finished_at, success FROM catalogue_sync_reports WHERE provider = ? ORDER BY id DESC LIMIT 1',
      [provider],
    );
    return r ? { finishedAt: String(r.finished_at), success: Number(r.success) === 1 } : null;
  }

  lastSuccessfulSync(provider: string): string | null {
    const r = this.#db.get<{ f: string | null }>(
      'SELECT MAX(finished_at) AS f FROM catalogue_sync_reports WHERE provider = ? AND success = 1',
      [provider],
    );
    return r?.f ?? null;
  }
}
