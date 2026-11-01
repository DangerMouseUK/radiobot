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
   * Every station and source, read and parsed once and reused until the next database write.
   * Views, suggestions and playback read them constantly, on the thread that sends voice
   * packets; writes are rare. The rows are frozen because they are shared.
   */
  #cache: {
    version: string;
    stations: readonly Station[];
    stationById: Map<string, Station>;
    sources: readonly StationSource[];
    sourceById: Map<string, StationSource>;
    sourcesByStation: Map<string, readonly StationSource[]>;
  } | null = null;

  /** Bumped by every write to the station tables, which only this repository writes. */
  #writes = 0;

  #write(sql: string, params: Params = []): { changes: number; lastInsertRowid: number } {
    try {
      return this.#db.run(sql, params);
    } finally {
      this.#writes++;
    }
  }

  /** Identifies the data the cache was read from: this repository's writes, and any rollback. */
  #version(): string {
    return `${this.#writes}/${this.#db.rollbacks}`;
  }

  #cached() {
    const version = this.#version();
    if (this.#cache?.version === version) return this.#cache;
    const stations = this.#db
      .all(
        `SELECT * FROM stations
         ORDER BY CASE provider WHEN 'custom' THEN 1 ELSE 0 END, provider, sort_order, display_name COLLATE NOCASE`,
      )
      .map((r) => freezeStation(mapStation(r)));
    const sources = this.#db
      .all('SELECT * FROM station_sources ORDER BY station_id, priority, id')
      .map((r) => freezeSource(mapSource(r)));
    const sourcesByStation = new Map<string, StationSource[]>();
    for (const src of sources) {
      const list = sourcesByStation.get(src.stationId);
      if (list) list.push(src);
      else sourcesByStation.set(src.stationId, [src]);
    }
    for (const list of sourcesByStation.values()) {
      list.sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      Object.freeze(list);
    }
    this.#cache = {
      version,
      stations: Object.freeze(stations),
      stationById: new Map(stations.map((st) => [st.id, st])),
      sources: Object.freeze(sources),
      sourceById: new Map(sources.map((src) => [src.id, src])),
      sourcesByStation,
    };
    return this.#cache;
  }

  /** The cache, only if it is still current (single-row reads don't rebuild it: seeding writes between them). */
  #current() {
    return this.#cache?.version === this.#version() ? this.#cache : null;
  }

  /** Runs several repository writes atomically. */
  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn);
  }

  // ---- stations ----

  getStation(id: string): Station | null {
    const cache = this.#current();
    if (cache) return cache.stationById.get(id) ?? null;
    const r = this.#db.get('SELECT * FROM stations WHERE id = ?', [id]);
    return r ? freezeStation(mapStation(r)) : null;
  }

  /** Pack stations plus the given guild's custom stations, in catalogue order. */
  listStations(guildId: string | null, opts: { includeRetired?: boolean } = {}): Station[] {
    return this.#cached().stations.filter(
      (st) =>
        (st.guildId === null || st.guildId === (guildId ?? '')) &&
        (opts.includeRetired || st.catalogueStatus !== 'retired'),
    );
  }

  /** Every station from every pack (not custom stations). */
  listBuiltinStations(): Station[] {
    return this.#cached().stations.filter((st) => st.provider !== 'custom');
  }

  listProviderStations(provider: Provider): Station[] {
    return this.#cached().stations.filter((st) => st.provider === provider);
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
      this.#write(
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
    this.#write(
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
    this.#write(
      `UPDATE stations SET catalogue_status = ?,
         official_catalog_last_seen_at = COALESCE(?, official_catalog_last_seen_at),
         retired_at = CASE WHEN ? = 'retired' THEN COALESCE(retired_at, ?) ELSE NULL END,
         updated_at = ? WHERE id = ?`,
      [status, lastSeenAt ?? null, status, now, now, id],
    );
  }

  renameStation(id: string, displayName: string, keepOldAsAlias: boolean): void {
    const s = this.getStation(id);
    if (!s) return;
    const aliases = keepOldAsAlias ? [...new Set([...s.aliases, s.displayName])] : s.aliases;
    this.#write('UPDATE stations SET display_name = ?, aliases_json = ?, updated_at = ? WHERE id = ?', [
      displayName,
      JSON.stringify(aliases),
      nowIso(),
      id,
    ]);
  }

  insertCustomStation(s: NewCustomStation): void {
    const now = nowIso();
    this.#write(
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
    this.#write(
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
    const r = this.#write("DELETE FROM stations WHERE id = ? AND provider = 'custom' AND guild_id = ?", [
      id,
      guildId,
    ]);
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
    return this.#write("DELETE FROM stations WHERE provider = 'custom' AND guild_id = ?", [guildId]).changes;
  }

  // ---- sources ----

  listSources(stationId: string): StationSource[] {
    return [...(this.#cached().sourcesByStation.get(stationId) ?? [])];
  }

  listAllSources(): StationSource[] {
    return [...this.#cached().sources];
  }

  getSource(id: string): StationSource | null {
    const cache = this.#current();
    if (cache) return cache.sourceById.get(id) ?? null;
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
      this.#write(
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
        this.#write(
          'DELETE FROM guild_source_preferences WHERE preferred_source_id = ? AND station_id <> ?',
          [seed.id, seed.stationId],
        );
      }
      this.#write(
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
    this.#write(
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
    this.#write(`UPDATE station_sources SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [
      ...columns.map((c) => row[c]!),
      row.id!,
    ]);
  }

  insertSource(seed: SourceSeed): void {
    this.upsertSeedSource(seed);
  }

  deleteSource(id: string): void {
    this.#write('DELETE FROM station_sources WHERE id = ?', [id]);
  }

  setSourceEnabled(id: string, enabled: boolean, reason: string | null): void {
    this.#write(
      'UPDATE station_sources SET is_enabled = ?, disabled_reason = ?, updated_at = ? WHERE id = ?',
      [enabled ? 1 : 0, enabled ? null : reason, nowIso(), id],
    );
  }

  setIdentityOverride(id: string, override: 'verified' | 'mismatch' | null): void {
    this.#write('UPDATE station_sources SET identity_override = ?, updated_at = ? WHERE id = ?', [
      override,
      nowIso(),
      id,
    ]);
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
    this.#write(`UPDATE station_sources SET ${sets.join(', ')} WHERE id = ?`, params);
  }

  /** Records a healthy observation: resets the failure streak and nudges health up. */
  recordSuccess(id: string, at = nowIso()): void {
    this.#write(
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
    this.#write(
      `UPDATE station_sources SET last_failure_at = ?, last_failure_code = ?, failure_count = failure_count + 1,
         consecutive_failures = consecutive_failures + 1, health_score = MAX(0, health_score - 15), updated_at = ?
       WHERE id = ?`,
      [at, code, at, id],
    );
    return this.getSource(id)?.consecutiveFailures ?? 0;
  }

  setCooldown(id: string, until: string | null): void {
    this.#write(
      `UPDATE station_sources SET cooldown_until = ?,
         cooldown_trips = CASE WHEN ? IS NULL THEN 0 ELSE cooldown_trips + 1 END,
         verification_state = CASE WHEN ? IS NULL THEN verification_state ELSE 'cooldown' END,
         updated_at = ? WHERE id = ?`,
      [until, until, until, nowIso(), id],
    );
  }

  // ---- probe results ----

  insertProbeResult(p: ProbeResultRecord): number {
    return this.#write(
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

  /** Bounds probe history (PRD §11.2): keep the newest `keep` rows per source and nothing older than `days`. */
  pruneProbeResults(keep: number, days: number): number {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const byAge = this.#write('DELETE FROM source_probe_results WHERE started_at < ?', [cutoff]).changes;
    // Each new result already trims its own source, so this rarely finds anything. It reads the
    // index, not the rows: a window function over the whole table cost milliseconds every hour.
    let byCount = 0;
    const over = this.#db.all<{ source_id: string }>(
      'SELECT source_id FROM source_probe_results GROUP BY source_id HAVING COUNT(*) > ?',
      [keep],
    );
    for (const r of over) byCount += this.pruneSourceHistory(r.source_id, keep);
    return byAge + byCount;
  }

  /** Keeps the newest `keep` results of one source, through the per-source index. */
  pruneSourceHistory(sourceId: string, keep: number): number {
    return this.#write(
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
    this.#write(
      `INSERT INTO catalogue_sync_reports (provider, started_at, finished_at, success, trigger, summary_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [r.provider, r.startedAt, r.finishedAt, r.success ? 1 : 0, r.trigger, JSON.stringify(r.summary)],
    );
    // Kept per pack, so frequent syncs of one pack never evict another pack's history.
    this.#write(
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

  lastSuccessfulSync(provider: string): string | null {
    const r = this.#db.get<{ f: string | null }>(
      'SELECT MAX(finished_at) AS f FROM catalogue_sync_reports WHERE provider = ? AND success = 1',
      [provider],
    );
    return r?.f ?? null;
  }
}
