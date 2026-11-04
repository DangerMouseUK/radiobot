import { describe, expect, it, vi } from 'vitest';
import { Db, parseJson, parseJsonArray } from '../../src/persistence/db.ts';
import { GuildRepository } from '../../src/persistence/repositories/guilds.ts';
import {
  mapSource,
  mapStation,
  type ProbeResultRecord,
  type SourceSeed,
  type StationSeed,
} from '../../src/persistence/repositories/stations.ts';
import { memoryDb } from '../helpers.ts';

const GUILD = '123456789012345678';
const OTHER_GUILD = '876543210987654321';

const stationSeed = (overrides: Partial<StationSeed> = {}): StationSeed => ({
  id: 'mypack:my-station',
  provider: 'mypack',
  slug: 'my-station',
  externalId: 'ext-1',
  displayName: 'My Station',
  aliases: [],
  tags: ['news'],
  category: null,
  sortOrder: 1,
  officialPageUrl: null,
  officialLastSeenAt: '2026-01-02',
  catalogueStatus: 'active',
  description: null,
  ...overrides,
});

const sourceSeed = (overrides: Partial<SourceSeed> = {}): SourceSeed => ({
  id: 'my-source',
  stationId: 'mypack:my-station',
  url: 'https://radio.example.org/a.mp3',
  label: 'Direct',
  priority: 10,
  transportHint: 'http-continuous',
  codecHint: 'mp3',
  provenance: 'curated',
  provenanceDetail: 'Listed on the station website.',
  rightsStatus: 'unreviewed',
  ...overrides,
});

const probe = (overrides: Partial<ProbeResultRecord> = {}): ProbeResultRecord => ({
  sourceId: 'my-source',
  startedAt: new Date().toISOString(),
  durationMs: 1200,
  kind: 'basic',
  effectiveHost: 'radio.example.org',
  transport: 'http-continuous',
  container: 'mp3',
  codec: 'mp3',
  profile: null,
  sampleRateHz: 44_100,
  channels: 2,
  bitrateEstimate: 128,
  bitrateEvidence: 'measured',
  startupMs: 300,
  headersSummary: { server: 'test' },
  manifestSummary: {},
  identityEvidence: [],
  success: true,
  failureCode: null,
  failureDetail: null,
  confidence: 'medium',
  probeVersion: 1,
  ...overrides,
});

function withStation() {
  const t = memoryDb();
  t.stations.upsertProviderStation(stationSeed());
  return t;
}

describe('row mapping defaults', () => {
  it('fills in defaults for a sparse station row and reads bigint numbers', () => {
    const st = mapStation({
      id: 'mypack:x',
      provider: 'mypack',
      canonical_slug: 'x',
      display_name: 'X',
      aliases_json: null,
      genre_tags_json: 'not json',
      sort_order: null,
      catalogue_status: 'active',
      created_at: 'a',
      updated_at: 'b',
    });
    expect(st).toMatchObject({ sortOrder: 1000, aliases: [], tags: [], guildId: null, externalId: null });
    expect(mapStation({ id: 'mypack:y', sort_order: 7n }).sortOrder).toBe(7);
  });

  it('fills in defaults for a sparse source row', () => {
    const src = mapSource({
      id: 's',
      station_id: 'mypack:x',
      stream_url: 'https://radio.example.org/s',
      is_enabled: 0,
      identity_evidence_json: '{broken',
    });
    expect(src).toMatchObject({
      priority: 100,
      transport: 'unknown',
      bitrateConfidence: 'unknown',
      identityConfidence: 'none',
      identityEvidence: [],
      qualityConfidence: 'unknown',
      enabled: false,
      healthScore: 50,
      failureCount: 0,
      consecutiveFailures: 0,
      cooldownTrips: 0,
      sampleRateHz: null,
    });
  });
});

describe('StationRepository: pack stations', () => {
  it('reports unchanged, then updated, and stores the change', () => {
    const { stations } = withStation();
    expect(stations.upsertProviderStation(stationSeed())).toBe('unchanged');
    expect(stations.upsertProviderStation(stationSeed({ category: 'talk', sortOrder: 2 }))).toBe('updated');
    expect(stations.getStation('mypack:my-station')).toMatchObject({ category: 'talk', sortOrder: 2 });
  });

  it('keeps an existing external ID when the manifest has none', () => {
    const { stations } = withStation();
    expect(stations.upsertProviderStation(stationSeed({ externalId: null }))).toBe('unchanged');
    expect(stations.getStation('mypack:my-station')?.externalId).toBe('ext-1');
  });

  it('keeps a fresher last-seen date from a live sync over an older manifest date', () => {
    const { stations } = withStation();
    stations.setCatalogueStatus('mypack:my-station', 'active', '2026-05-01');
    expect(stations.upsertProviderStation(stationSeed({ officialLastSeenAt: '2026-01-02' }))).toBe(
      'unchanged',
    );
    expect(stations.getStation('mypack:my-station')?.officialLastSeenAt).toBe('2026-05-01');
    expect(stations.upsertProviderStation(stationSeed({ officialLastSeenAt: '2026-06-01' }))).toBe('updated');
    expect(stations.getStation('mypack:my-station')?.officialLastSeenAt).toBe('2026-06-01');
  });

  it('keeps a name that sync gave the station until the manifest itself changes it', () => {
    const { stations } = withStation();
    stations.renameStation('mypack:my-station', 'My Station Live', true);
    expect(stations.upsertProviderStation(stationSeed())).toBe('unchanged');
    const st = stations.getStation('mypack:my-station')!;
    expect(st.displayName).toBe('My Station Live');
    expect(st.aliases).toEqual(['My Station']);
    stations.upsertProviderStation(stationSeed({ displayName: 'Brand New Name' }));
    expect(stations.getStation('mypack:my-station')?.displayName).toBe('Brand New Name');
  });

  it('retires a station from the manifest, once, and never un-retires it', () => {
    const { stations } = withStation();
    expect(stations.upsertProviderStation(stationSeed({ catalogueStatus: 'retired' }))).toBe('updated');
    const retired = stations.getStation('mypack:my-station')!;
    expect(retired.catalogueStatus).toBe('retired');
    expect(retired.retiredAt).not.toBeNull();
    expect(stations.upsertProviderStation(stationSeed({ catalogueStatus: 'retired' }))).toBe('unchanged');
    stations.upsertProviderStation(stationSeed({ catalogueStatus: 'active', category: 'talk' }));
    expect(stations.getStation('mypack:my-station')?.catalogueStatus).toBe('retired');
    expect(stations.listStations(null).map((s) => s.id)).toEqual([]);
    expect(stations.listStations(null, { includeRetired: true }).map((s) => s.id)).toEqual([
      'mypack:my-station',
    ]);
  });

  it('records the retirement time of a station inserted as retired', () => {
    const { stations } = memoryDb();
    stations.upsertProviderStation(stationSeed({ catalogueStatus: 'retired' }));
    expect(stations.getStation('mypack:my-station')?.retiredAt).not.toBeNull();
  });

  it('ignores a rename or status change of a station that does not exist', () => {
    const { stations } = withStation();
    expect(stations.listStations(null)).toHaveLength(1); // warm the cache
    stations.renameStation('mypack:nope', 'Whatever', true);
    stations.setCatalogueStatus('mypack:nope', 'retired');
    expect(stations.getStation('mypack:nope')).toBeNull();
    expect(stations.listStations(null).map((s) => s.id)).toEqual(['mypack:my-station']);
  });

  it('updates a station status in the warm cache, and clears the retirement time on return', () => {
    const { stations } = withStation();
    expect(stations.listBuiltinStations()).toHaveLength(1);
    stations.setCatalogueStatus('mypack:my-station', 'retired');
    expect(stations.listStations(null)).toEqual([]);
    expect(stations.getStation('mypack:my-station')?.retiredAt).not.toBeNull();
    stations.setCatalogueStatus('mypack:my-station', 'active');
    expect(stations.listStations(null)).toHaveLength(1);
    expect(stations.getStation('mypack:my-station')?.retiredAt).toBeNull();
  });

  it('marks several stations active and seen in one statement, warm cache or cold', () => {
    const { db, stations } = withStation();
    stations.upsertProviderStation(stationSeed({ id: 'mypack:other', slug: 'other', externalId: null }));
    stations.setCatalogueStatus('mypack:other', 'missing_from_official');
    stations.markSeen([], '2026-07-01');
    expect(stations.listBuiltinStations()).toHaveLength(2); // warm the cache
    const reads = vi.spyOn(db, 'all');
    stations.markSeen(['mypack:my-station', 'mypack:other', 'mypack:nope'], '2026-07-01');
    // Only the changed rows are read again, not the whole list.
    expect(reads).toHaveBeenCalledOnce();
    for (const id of ['mypack:my-station', 'mypack:other']) {
      expect(stations.getStation(id)).toMatchObject({
        catalogueStatus: 'active',
        officialLastSeenAt: '2026-07-01',
      });
    }
    expect(stations.listStations(null)).toHaveLength(2);
    reads.mockRestore();
    // With no cache to patch, the next read simply reads everything again.
    const cold = memoryDb();
    cold.stations.upsertProviderStation(stationSeed());
    cold.stations.markSeen(['mypack:my-station'], '2026-07-02');
    expect(cold.stations.getStation('mypack:my-station')?.officialLastSeenAt).toBe('2026-07-02');
  });
});

describe('StationRepository: custom stations', () => {
  const custom = {
    id: 'custom:abc123',
    guildId: GUILD,
    slug: 'abc123',
    displayName: 'My Custom',
    description: 'Desc',
    category: 'music',
    websiteUrl: 'https://radio.example.org',
    language: 'en',
    createdById: '111111111111111111',
  };

  it('shows a server only its own custom stations', () => {
    const { stations } = withStation();
    stations.insertCustomStation(custom);
    stations.insertCustomStation({ ...custom, id: 'custom:def456', slug: 'def456', displayName: 'Z Custom' });
    expect(stations.countCustomStations(GUILD)).toBe(2);
    expect(stations.countCustomStations(OTHER_GUILD)).toBe(0);
    expect(stations.listStations(GUILD).map((s) => s.id)).toEqual([
      'mypack:my-station',
      'custom:abc123',
      'custom:def456',
    ]);
    expect(stations.listStations(OTHER_GUILD).map((s) => s.id)).toEqual(['mypack:my-station']);
    expect(stations.listStations(null).map((s) => s.id)).toEqual(['mypack:my-station']);
    expect(stations.getVisibleStation(GUILD, 'custom:abc123')?.id).toBe('custom:abc123');
    expect(stations.getVisibleStation(OTHER_GUILD, 'custom:abc123')).toBeNull();
    expect(stations.getVisibleStation(OTHER_GUILD, 'mypack:my-station')?.id).toBe('mypack:my-station');
    expect(stations.getVisibleStation(GUILD, 'custom:missing')).toBeNull();
  });

  it('edits only the given fields, clears fields set to null, and only for the owning server', () => {
    const { stations } = withStation();
    stations.insertCustomStation(custom);
    expect(stations.updateCustomStation(OTHER_GUILD, 'custom:abc123', { displayName: 'Hijack' })).toBe(false);
    expect(stations.updateCustomStation(GUILD, 'mypack:my-station', { displayName: 'Nope' })).toBe(false);
    expect(stations.updateCustomStation(GUILD, 'custom:missing', { displayName: 'Nope' })).toBe(false);
    expect(stations.updateCustomStation(GUILD, 'custom:abc123', { displayName: 'Renamed' })).toBe(true);
    expect(stations.getStation('custom:abc123')).toMatchObject({
      displayName: 'Renamed',
      description: 'Desc',
      category: 'music',
      websiteUrl: 'https://radio.example.org',
      language: 'en',
    });
    stations.updateCustomStation(GUILD, 'custom:abc123', {
      description: null,
      category: null,
      websiteUrl: null,
      language: null,
    });
    expect(stations.getStation('custom:abc123')).toMatchObject({
      displayName: 'Renamed',
      description: null,
      category: null,
      websiteUrl: null,
      language: null,
    });
  });

  it('deletes a custom station only for its server, never a pack station', () => {
    const { stations } = withStation();
    stations.insertCustomStation(custom);
    expect(stations.deleteCustomStation(OTHER_GUILD, 'custom:abc123')).toBe(false);
    expect(stations.deleteCustomStation(GUILD, 'mypack:my-station')).toBe(false);
    expect(stations.deleteCustomStation(GUILD, 'custom:abc123')).toBe(true);
    expect(stations.countCustomStations(GUILD)).toBe(0);
    expect(stations.getStation('mypack:my-station')).not.toBeNull();
  });
});

describe('StationRepository: sources', () => {
  it('updates manifest fields in place and keeps runtime evidence when the URL is the same', () => {
    const { stations } = withStation();
    stations.upsertSeedSource(sourceSeed());
    stations.setIdentityOverride('my-source', 'verified');
    expect(stations.listSources('mypack:my-station')).toHaveLength(1); // warm the cache
    expect(stations.upsertSeedSource(sourceSeed({ label: 'Renamed', rightsStatus: 'permitted' }))).toBe(
      'updated',
    );
    expect(stations.getSource('my-source')).toMatchObject({
      label: 'Renamed',
      rightsStatus: 'permitted',
      identityOverride: 'verified',
    });
  });

  it('re-sorts a station’s sources when a priority changes, with ties broken by ID', () => {
    const { stations } = withStation();
    for (const id of ['src-c', 'src-a', 'src-b']) stations.upsertSeedSource(sourceSeed({ id, priority: 10 }));
    expect(stations.listSources('mypack:my-station').map((s) => s.id)).toEqual(['src-a', 'src-b', 'src-c']);
    stations.upsertSeedSource(sourceSeed({ id: 'src-c', priority: 1 }));
    expect(stations.listSources('mypack:my-station').map((s) => s.id)).toEqual(['src-c', 'src-a', 'src-b']);
    expect(stations.listAllSources().map((s) => s.id)).toEqual(['src-c', 'src-a', 'src-b']);
    expect(stations.listSources('mypack:none')).toEqual([]);
  });

  it('snapshots and restores a source row exactly', () => {
    const { stations } = withStation();
    stations.upsertSeedSource(sourceSeed());
    expect(stations.snapshotSource('missing')).toBeNull();
    const snap = stations.snapshotSource('my-source')!;
    stations.setIdentityOverride('my-source', 'mismatch');
    stations.recordFailure('my-source', 'HTTP_ERROR');
    stations.restoreSource(snap);
    expect(stations.snapshotSource('my-source')).toEqual(snap);
    expect(stations.getSource('my-source')).toMatchObject({ identityOverride: null, consecutiveFailures: 0 });
  });

  it('clears the disabled reason when a source is switched back on', () => {
    const { stations } = withStation();
    stations.upsertSeedSource(sourceSeed());
    stations.setSourceEnabled('my-source', false, 'broken');
    expect(stations.getSource('my-source')).toMatchObject({ enabled: false, disabledReason: 'broken' });
    stations.setSourceEnabled('my-source', true, 'ignored');
    expect(stations.getSource('my-source')).toMatchObject({ enabled: true, disabledReason: null });
  });

  it('applies probe patches, storing missing evidence as an empty list, and ignores an empty patch', () => {
    const { stations } = withStation();
    stations.upsertSeedSource(sourceSeed());
    stations.listAllSources(); // warm the cache: no write keeps the very same cached row
    const before = stations.getSource('my-source')!;
    stations.applyProbePatch('my-source', {});
    expect(stations.getSource('my-source')).toBe(before);
    stations.applyProbePatch('my-source', {
      identityEvidence: undefined,
      codec: 'aac',
      sampleRateHz: null,
    });
    expect(stations.getSource('my-source')).toMatchObject({
      identityEvidence: [],
      codec: 'aac',
      sampleRateHz: null,
    });
  });

  it('counts failures, returns 0 for an unknown source, and resets on success after a cooldown', () => {
    const { stations } = withStation();
    stations.upsertSeedSource(sourceSeed());
    expect(stations.recordFailure('my-source', 'HTTP_ERROR')).toBe(1);
    expect(stations.recordFailure('my-source', 'HTTP_ERROR')).toBe(2);
    expect(stations.recordFailure('missing', 'HTTP_ERROR')).toBe(0);
    stations.setCooldown('my-source', '2026-01-01T00:10:00.000Z');
    expect(stations.getSource('my-source')).toMatchObject({
      cooldownTrips: 1,
      verificationState: 'cooldown',
    });
    stations.recordSuccess('my-source', '2026-01-01T00:05:00.000Z');
    expect(stations.getSource('my-source')).toMatchObject({
      consecutiveFailures: 0,
      cooldownUntil: '2026-01-01T00:10:00.000Z',
      cooldownTrips: 1,
    });
    stations.recordSuccess('my-source', '2026-01-01T00:20:00.000Z');
    expect(stations.getSource('my-source')).toMatchObject({ cooldownUntil: null, cooldownTrips: 0 });
    stations.setCooldown('my-source', '2026-01-02T00:00:00.000Z');
    stations.setCooldown('my-source', null);
    expect(stations.getSource('my-source')).toMatchObject({ cooldownUntil: null, cooldownTrips: 0 });
  });

  it('deletes a source and reads the cache again', () => {
    const { stations } = withStation();
    stations.upsertSeedSource(sourceSeed());
    expect(stations.listAllSources()).toHaveLength(1);
    stations.deleteSource('my-source');
    expect(stations.listAllSources()).toEqual([]);
    expect(stations.getSource('my-source')).toBeNull();
  });
});

describe('StationRepository: probe results and sync reports', () => {
  it('stores and reads probe results newest first', () => {
    const { stations } = withStation();
    stations.upsertSeedSource(sourceSeed());
    stations.insertProbeResult(probe({ startedAt: '2026-01-01T00:00:00.000Z' }));
    stations.insertProbeResult(
      probe({
        startedAt: '2026-01-02T00:00:00.000Z',
        success: false,
        failureCode: 'HTTP_TIMEOUT',
        failureDetail: 'slow',
        transport: null,
        bitrateEvidence: null,
        bitrateEstimate: null,
      }),
    );
    const [newest, older] = stations.listProbeResults('my-source');
    expect(newest).toMatchObject({
      success: false,
      failureCode: 'HTTP_TIMEOUT',
      transport: null,
      bitrateEvidence: null,
      bitrateEstimate: null,
      confidence: 'medium',
    });
    expect(older).toMatchObject({ success: true, headersSummary: { server: 'test' }, sampleRateHz: 44_100 });
    expect(stations.listProbeResults('my-source', 1)).toHaveLength(1);
  });

  it('prunes by age only when asked not to trim every source', async () => {
    const { stations } = withStation();
    stations.upsertSeedSource(sourceSeed());
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    stations.insertProbeResult(probe({ startedAt: old }));
    for (let i = 0; i < 3; i++) stations.insertProbeResult(probe());
    const pause = async () => {};
    const prune = (trimEverySource: boolean) =>
      stations.pruneProbeHistory({ keep: 1, days: 30, pause, trimEverySource });
    expect(await prune(false)).toMatchObject({ deleted: 1 });
    expect(stations.listProbeResults('my-source')).toHaveLength(3);
    expect(await prune(true)).toMatchObject({ deleted: 2 });
    expect(stations.listProbeResults('my-source')).toHaveLength(1);
  });

  it('returns the time of the last successful sync of each pack', () => {
    const { stations } = memoryDb();
    expect(stations.lastSuccessfulSync('mypack')).toBeNull();
    expect(stations.lastSyncReport('mypack')).toBeNull();
    const report = (finishedAt: string, success: boolean, provider = 'mypack') =>
      stations.insertSyncReport({
        provider,
        startedAt: finishedAt,
        finishedAt,
        success,
        trigger: 'admin',
        summary: {},
      });
    report('2026-01-01T00:00:00.000Z', true);
    report('2026-01-03T00:00:00.000Z', false);
    report('2026-01-05T00:00:00.000Z', true, 'otherpack');
    expect(stations.lastSuccessfulSync('mypack')).toBe('2026-01-01T00:00:00.000Z');
    expect(stations.lastSyncReport('mypack')).toEqual({
      finishedAt: '2026-01-03T00:00:00.000Z',
      success: false,
      summary: {},
    });
  });
});

describe('GuildRepository edge cases', () => {
  it('creates settings with the installation defaults', () => {
    const { db } = memoryDb();
    const guilds = new GuildRepository(db, {
      qualityMode: 'balanced',
      idleMode: '24x7',
      resumeOnRestart: true,
    });
    expect(guilds.getSettings(GUILD)).toMatchObject({
      qualityMode: 'balanced',
      idleMode: '24x7',
      resumeOnRestart: true,
      voiceChannelStatus: true,
    });
  });

  it('stores an unset list as empty and leaves settings alone for an empty patch', () => {
    const { guilds } = memoryDb();
    guilds.updateSettings(GUILD, { djRoleIds: ['222222222222222222'], defaultStationId: 'mypack:x' });
    const before = guilds.getSettings(GUILD);
    expect(guilds.updateSettings(GUILD, {})).toEqual(before);
    const after = guilds.updateSettings(GUILD, { djRoleIds: undefined, defaultStationId: undefined });
    expect(after.djRoleIds).toEqual([]);
    expect(after.defaultStationId).toBeNull();
  });

  it('merges playback intent: given keys replace (undefined clears), missing keys are kept', () => {
    const { guilds } = memoryDb();
    expect(guilds.getIntent(GUILD)).toBeNull();
    const first = guilds.setIntent(GUILD, { desiredState: 'playing' });
    expect(first).toMatchObject({ desiredStationId: null, lastErrorCode: null });
    guilds.setIntent(GUILD, {
      desiredState: 'playing',
      desiredStationId: 'mypack:x',
      desiredVoiceChannelId: '333333333333333333',
      lastRequestedAt: '2026-01-01T00:00:00.000Z',
      lastRequestedById: '444444444444444444',
      lastSuccessfulSourceId: 'my-source',
      lastErrorCode: 'HTTP_ERROR',
    });
    const kept = guilds.setIntent(GUILD, { desiredState: 'stopped' });
    expect(kept).toMatchObject({
      desiredState: 'stopped',
      desiredStationId: 'mypack:x',
      desiredVoiceChannelId: '333333333333333333',
      lastRequestedAt: '2026-01-01T00:00:00.000Z',
      lastRequestedById: '444444444444444444',
      lastSuccessfulSourceId: 'my-source',
      lastErrorCode: 'HTTP_ERROR',
    });
    const cleared = guilds.setIntent(GUILD, {
      desiredState: 'idle',
      desiredStationId: undefined,
      desiredVoiceChannelId: undefined,
      lastRequestedAt: undefined,
      lastRequestedById: undefined,
      lastSuccessfulSourceId: undefined,
      lastErrorCode: undefined,
    });
    expect(cleared).toMatchObject({
      desiredStationId: null,
      desiredVoiceChannelId: null,
      lastRequestedAt: null,
      lastRequestedById: null,
      lastSuccessfulSourceId: null,
      lastErrorCode: null,
    });
    expect(guilds.getIntent(GUILD)).toEqual(cleared);
  });

  it('removes a queue entry by ID only within its own server', () => {
    const { guilds, stations } = withStation();
    guilds.enqueue(GUILD, 'mypack:my-station', null);
    const [entry] = guilds.listQueue(GUILD);
    expect(guilds.removeQueueEntry(OTHER_GUILD, entry!.id)).toBe(false);
    expect(guilds.removeFromQueue(GUILD, 5)).toBeNull();
    expect(guilds.removeQueueEntry(GUILD, entry!.id)).toBe(true);
    expect(guilds.removeQueueEntry(GUILD, entry!.id)).toBe(false);
    expect(guilds.listQueue(GUILD)).toEqual([]);
    expect(stations.getStation('mypack:my-station')).not.toBeNull();
  });
});

describe('MetaRepository.getOrCreate', () => {
  it('creates a value once and returns the stored one afterwards', () => {
    const { meta } = memoryDb();
    const create = vi.fn(() => 'generated');
    expect(meta.getOrCreate('install.id', create)).toBe('generated');
    expect(meta.getOrCreate('install.id', create)).toBe('generated');
    expect(create).toHaveBeenCalledTimes(1);
    expect(meta.get('install.id')).toBe('generated');
  });
});

describe('Db helpers', () => {
  it('accepts named parameters for all, get and run', () => {
    const db = new Db(':memory:');
    db.raw.exec('CREATE TABLE t (a INTEGER, b TEXT)');
    expect(db.run('INSERT INTO t (a, b) VALUES (:a, :b)', { a: 1, b: 'x' })).toEqual({
      changes: 1,
      lastInsertRowid: 1,
    });
    expect(db.get('SELECT b FROM t WHERE a = :a', { a: 1 })).toEqual({ b: 'x' });
    expect(db.all('SELECT a FROM t WHERE b = :b', { b: 'x' })).toEqual([{ a: 1 }]);
    db.close();
  });

  it('reports schema version 0 before any migration, never backs up memory, and closes twice safely', () => {
    const db = new Db(':memory:');
    expect(db.migrate([])).toEqual({ applied: [], backupPath: null });
    expect(db.schemaVersion()).toBe(0);
    expect(db.backup('manual')).toBeNull();
    db.close();
    expect(() => db.close()).not.toThrow();
  });

  it('parses JSON defensively', () => {
    expect(parseJsonArray('["a", 1, "b"]')).toEqual(['a', 'b']);
    expect(parseJsonArray('{"a":1}')).toEqual([]);
    expect(parseJsonArray('[oops')).toEqual([]);
    expect(parseJsonArray(42)).toEqual([]);
    expect(parseJson('{"a":1}', {})).toEqual({ a: 1 });
    expect(parseJson('{oops', { fallback: true })).toEqual({ fallback: true });
    expect(parseJson(null, 'none')).toBe('none');
  });
});
