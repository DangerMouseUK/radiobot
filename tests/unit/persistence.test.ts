import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Db, loadMigrations, type Migration, matchOwner } from '../../src/persistence/db.ts';
import { GuildRepository } from '../../src/persistence/repositories/guilds.ts';
import { compareNoCase, StationRepository } from '../../src/persistence/repositories/stations.ts';
import { bootDecision } from '../../src/voice/session-manager.ts';
import { memoryDb } from '../helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDb = () => {
  const dir = mkdtempSync(join(tmpdir(), 'radiobot-'));
  dirs.push(dir);
  return join(dir, 'radio-bot.sqlite');
};

describe('migrations', () => {
  it('applies once and is idempotent', () => {
    const path = tempDb();
    const db = new Db(path);
    const all = loadMigrations().map((m) => m.version);
    expect(db.migrate().applied).toEqual(all);
    expect(db.migrate().applied).toEqual([]);
    expect(db.schemaVersion()).toBe(all.at(-1));
    db.close();
  });

  it('refuses a modified migration (checksum)', () => {
    const db = new Db(':memory:');
    const ms = loadMigrations();
    db.migrate(ms);
    const tampered: Migration[] = ms.map((m) => ({ ...m, checksum: 'x' }));
    expect(() => db.migrate(tampered)).toThrow(/modified after being applied/);
  });

  it('refuses to run against a newer schema', () => {
    const db = new Db(':memory:');
    db.migrate();
    db.run("INSERT INTO schema_migrations VALUES (999, 'future', 'now', 'x')");
    expect(() => db.migrate()).toThrow(/newer than this build/);
  });

  it('backs up an existing database before applying a new migration, keeping every setting', () => {
    const path = tempDb();
    const db = new Db(path);
    // A database from before migration 0002: only the first migration applied.
    db.migrate(loadMigrations().slice(0, 1));
    const guilds = new GuildRepository(db, {
      qualityMode: 'maximum',
      idleMode: '24x7',
      resumeOnRestart: false,
    });
    guilds.updateSettings('123456789012345678', { djRoleIds: ['223456789012345678'], autostart: true });
    const r = db.migrate();
    expect(r.applied).toEqual(
      loadMigrations()
        .slice(1)
        .map((m) => m.version),
    );
    expect(r.backupPath && existsSync(r.backupPath)).toBe(true);
    const backup = new Db(r.backupPath!);
    expect(backup.schemaVersion()).toBe(1);
    expect(
      new GuildRepository(backup, {
        qualityMode: 'maximum',
        idleMode: '24x7',
        resumeOnRestart: false,
      }).getSettings('123456789012345678').djRoleIds,
    ).toEqual(['223456789012345678']);
    backup.close();
    const upgraded = guilds.getSettings('123456789012345678');
    expect(upgraded.djRoleIds).toEqual(['223456789012345678']);
    expect(upgraded.autostart).toBe(true);
    // 0002 adds the voice channel status switch, on by default.
    expect(upgraded.voiceChannelStatus).toBe(true);
    db.close();
  });

  it('rolls back a failing migration', () => {
    const db = new Db(':memory:');
    db.migrate();
    const latest = db.schemaVersion();
    const bad: Migration[] = [
      ...loadMigrations(),
      { version: latest + 1, name: 'bad', sql: 'CREATE TABLE ok1 (x); SELECT * FROM nope;', checksum: 'b' },
    ];
    expect(() => db.migrate(bad)).toThrow();
    expect(db.schemaVersion()).toBe(latest);
    expect(db.get("SELECT name FROM sqlite_master WHERE name = 'ok1'")).toBeUndefined();
  });

  it('prunes old backups', () => {
    const path = tempDb();
    const db = new Db(path);
    db.migrate();
    for (let i = 0; i < 7; i++) db.backup(`b${i}`, 3);
    expect(readdirSync(join(path, '..', 'backups')).length).toBe(3);
    db.close();
  });
});

describe('guild state', () => {
  it('isolates guilds and persists explicit stop (NFR-09)', () => {
    const { guilds } = memoryDb();
    guilds.setIntent('1', {
      desiredState: 'playing',
      desiredStationId: 'demo:demo-chic',
      desiredVoiceChannelId: 'v1',
    });
    guilds.setIntent('2', { desiredState: 'stopped' });
    expect(guilds.getIntent('1')?.desiredStationId).toBe('demo:demo-chic');
    expect(guilds.getIntent('2')?.desiredStationId).toBeNull();
    guilds.setIntent('1', { desiredState: 'stopped' });
    expect(guilds.getIntent('1')?.desiredStationId).toBe('demo:demo-chic');
    expect(guilds.getIntent('1')?.desiredState).toBe('stopped');
  });

  it('toggles favourites and purges a guild', () => {
    const { guilds, stations } = memoryDb();
    stations.upsertProviderStation({
      id: 'demo:x',
      provider: 'demo',
      slug: 'x',
      externalId: null,
      displayName: 'X',
      aliases: [],
      tags: [],
      category: null,
      sortOrder: 1,
      officialPageUrl: null,
      officialLastSeenAt: null,
      catalogueStatus: 'active',
      description: null,
    });
    expect(guilds.toggleFavourite('g', 'demo:x')).toBe(true);
    expect(guilds.listFavourites('g')).toEqual(['demo:x']);
    expect(guilds.toggleFavourite('g', 'demo:x')).toBe(false);
    guilds.updateSettings('g', { idleMode: '24x7' });
    guilds.purgeGuild('g');
    expect(guilds.getSettings('g').idleMode).toBe('leave_when_empty');
  });

  it('forgets the command registration when a guild is purged, so a re-invite registers again', () => {
    const { guilds, meta } = memoryDb();
    meta.set('commands.hash.g', 'abc');
    meta.set('commands.hash.other', 'abc');
    guilds.purgeGuild('g');
    expect(meta.get('commands.hash.g')).toBeNull();
    expect(meta.get('commands.hash.other')).toBe('abc');
  });
});

describe('boot policy (§9.3)', () => {
  const settings = {
    resumeOnRestart: true,
    autostart: true,
    defaultStationId: 'demo:demo-chic',
    preferredVoiceChannelId: 'v9',
  };
  const intent = (desiredState: 'playing' | 'stopped' | 'left' | 'kicked' | 'idle') => ({
    guildId: 'g',
    desiredStationId: 'demo:demo-radio',
    desiredVoiceChannelId: 'v1',
    desiredState,
    lastRequestedAt: null,
    lastRequestedById: null,
    lastSuccessfulSourceId: null,
    lastErrorCode: null,
    updatedAt: '',
  });

  it('resumes the desired station only when resume is enabled', () => {
    expect(bootDecision(intent('playing'), settings)).toEqual({
      stationId: 'demo:demo-radio',
      channelId: 'v1',
      why: 'resume',
    });
    expect(
      bootDecision(intent('playing'), { ...settings, resumeOnRestart: false, autostart: false }),
    ).toBeNull();
  });

  it('never overrides an explicit stop/leave/kick', () => {
    for (const s of ['stopped', 'left', 'kicked'] as const)
      expect(bootDecision(intent(s), settings)).toBeNull();
  });

  it('autostarts the default only when opted in', () => {
    expect(bootDecision(null, settings)?.why).toBe('autostart');
    expect(bootDecision(intent('idle'), { ...settings, autostart: false })).toBeNull();
  });
});

describe('probe history retention', () => {
  it('keeps only the newest N per source', async () => {
    const { stations } = memoryDb();
    stations.upsertProviderStation({
      id: 'demo:x',
      provider: 'demo',
      slug: 'x',
      externalId: null,
      displayName: 'X',
      aliases: [],
      tags: [],
      category: null,
      sortOrder: 1,
      officialPageUrl: null,
      officialLastSeenAt: null,
      catalogueStatus: 'active',
      description: null,
    });
    stations.upsertSeedSource({
      id: 's',
      stationId: 'demo:x',
      url: 'https://a.example.com/',
      label: null,
      priority: 1,
      transportHint: null,
      codecHint: null,
      provenance: 'curated',
      provenanceDetail: 'x',
      rightsStatus: 'unreviewed',
    });
    for (let i = 0; i < 40; i++) {
      stations.insertProbeResult({
        sourceId: 's',
        startedAt: new Date(Date.now() - i * 1000).toISOString(),
        durationMs: 1,
        kind: 'basic',
        effectiveHost: null,
        transport: null,
        container: null,
        codec: null,
        profile: null,
        sampleRateHz: null,
        channels: null,
        bitrateEstimate: null,
        bitrateEvidence: null,
        startupMs: null,
        headersSummary: {},
        manifestSummary: {},
        identityEvidence: [],
        success: true,
        failureCode: null,
        failureDetail: null,
        confidence: 'none',
        probeVersion: 1,
      });
    }
    // Later hourly runs only age results out; the per-source limit is applied as results arrive.
    const pause = async () => {};
    await stations.pruneProbeHistory({ keep: 30, days: 30, pause, trimEverySource: false });
    expect(stations.listProbeResults('s', 100)).toHaveLength(40);
    await stations.pruneProbeHistory({ keep: 30, days: 30, pause, trimEverySource: true });
    expect(stations.listProbeResults('s', 100)).toHaveLength(30);
    const newest = stations.listProbeResults('s', 1)[0]!.startedAt;
    expect(stations.pruneSourceHistory('s', 5)).toBe(25);
    expect(stations.listProbeResults('s', 100)).toHaveLength(5);
    expect(stations.listProbeResults('s', 1)[0]!.startedAt).toBe(newest);
  });
});

describe('seeded sources', () => {
  const station = (id: string) => ({
    id,
    provider: 'demo',
    slug: id.slice(3),
    externalId: null,
    displayName: id,
    aliases: [],
    tags: [],
    category: null,
    sortOrder: 1,
    officialPageUrl: null,
    officialLastSeenAt: null,
    catalogueStatus: 'active' as const,
    description: null,
  });
  const seed = (stationId: string) => ({
    id: 's',
    stationId,
    url: 'https://a.example.com/',
    label: null,
    priority: 1,
    transportHint: null,
    codecHint: null,
    provenance: 'curated' as const,
    provenanceDetail: 'x',
    rightsStatus: 'unreviewed' as const,
  });

  it('moves a source a pack update maps to another station, dropping the old station’s evidence', () => {
    const { stations, guilds } = memoryDb();
    stations.upsertProviderStation(station('demo:a'));
    stations.upsertProviderStation(station('demo:b'));
    stations.upsertSeedSource(seed('demo:a'));
    stations.setIdentityOverride('s', 'verified');
    guilds.setPreference('g', 'demo:a', 'pin', 's', '1');
    expect(stations.upsertSeedSource(seed('demo:a'))).toBe('unchanged');
    expect(stations.upsertSeedSource(seed('demo:b'))).toBe('updated');
    expect(stations.getSource('s')).toMatchObject({
      stationId: 'demo:b',
      identityOverride: null,
      identityStatus: 'unverified',
    });
    expect(stations.listSources('demo:a')).toEqual([]);
    expect(guilds.listPreferences('g')).toEqual([]);
  });
});

describe('backup ownership', () => {
  it('hands root-made backups to the database owner, and does nothing otherwise', () => {
    const path = tempDb();
    new Db(path).close();
    const calls: Array<[string, number, number]> = [];
    const chown = (p: string, uid: number, gid: number) => calls.push([p, uid, gid]);
    matchOwner(path, ['dir', 'file'], 1000, chown);
    expect(calls).toEqual([]);
    matchOwner(path, ['dir', 'file'], 0, chown);
    // The database file belongs to whoever runs the tests: nothing to do if that is root too.
    const owner = statSync(path);
    expect(calls).toEqual(
      owner.uid === 0
        ? []
        : [
            ['dir', owner.uid, owner.gid],
            ['file', owner.uid, owner.gid],
          ],
    );
  });
});

describe('statement cache', () => {
  it('compiles each statement once and reuses it', () => {
    const db = new Db(':memory:');
    db.raw.exec('CREATE TABLE t (a INTEGER)');
    const prepare = vi.spyOn(db.raw, 'prepare');
    for (let i = 0; i < 5; i++) db.run('INSERT INTO t (a) VALUES (?)', [i]);
    expect(db.all<{ a: number }>('SELECT a FROM t ORDER BY a').map((r) => r.a)).toEqual([0, 1, 2, 3, 4]);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM t')?.n).toBe(5);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM t')?.n).toBe(5);
    expect(prepare).toHaveBeenCalledTimes(3);
  });

  it('keeps at most 500 statements', () => {
    const db = new Db(':memory:');
    const prepare = vi.spyOn(db.raw, 'prepare');
    for (let i = 0; i < 501; i++) db.get(`SELECT ${i} AS n`);
    expect(prepare).toHaveBeenCalledTimes(501);
    // The 501st cleared the cache, so the first statement is compiled again.
    db.get('SELECT 0 AS n');
    expect(prepare).toHaveBeenCalledTimes(502);
    db.get('SELECT 500 AS n');
    expect(prepare).toHaveBeenCalledTimes(502);
  });

  it('still sees schema changes made after a statement was cached', () => {
    const db = new Db(':memory:');
    db.raw.exec('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1)');
    expect(db.get('SELECT * FROM t')).toEqual({ a: 1 });
    db.raw.exec('ALTER TABLE t ADD COLUMN b TEXT');
    expect(db.get('SELECT * FROM t')).toEqual({ a: 1, b: null });
  });
});

describe('station and source cache', () => {
  const station = (id: string, displayName = id) => ({
    id,
    provider: 'mypack',
    slug: id.split(':')[1]!,
    externalId: null,
    displayName,
    aliases: [],
    tags: [],
    category: null,
    sortOrder: 1,
    officialPageUrl: null,
    officialLastSeenAt: null,
    catalogueStatus: 'active' as const,
    description: null,
  });
  const source = (id: string, stationId: string, priority = 1) => ({
    id,
    stationId,
    url: `https://${id}.example.com/`,
    label: null,
    priority,
    transportHint: null,
    codecHint: null,
    provenance: 'curated' as const,
    provenanceDetail: 'x',
    rightsStatus: 'unreviewed' as const,
  });

  it('re-reads only the changed row after a source or status change, never the whole catalogue', () => {
    const { db, stations } = memoryDb();
    stations.upsertProviderStation(station('mypack:a'));
    stations.upsertProviderStation(station('mypack:b'));
    stations.upsertSeedSource(source('s1', 'mypack:a', 1));
    stations.upsertSeedSource(source('s2', 'mypack:a', 2));
    stations.listStations(null);
    stations.listAllSources();
    const all = vi.spyOn(db, 'all');
    // The kinds of write that happen during playback and background checks.
    stations.recordFailure('s1', 'TIMEOUT');
    stations.recordSuccess('s2');
    stations.applyProbePatch('s1', { codec: 'aac' });
    stations.setCooldown('s2', '2030-01-01T00:00:00.000Z');
    stations.setCatalogueStatus('mypack:b', 'missing_from_official');
    expect(stations.getSource('s1')).toMatchObject({ codec: 'aac', consecutiveFailures: 1 });
    expect(stations.listSources('mypack:a').map((x) => x.cooldownUntil)).toEqual([
      null,
      '2030-01-01T00:00:00.000Z',
    ]);
    expect(stations.getStation('mypack:b')?.catalogueStatus).toBe('missing_from_official');
    expect(stations.listStations(null).map((x) => x.id)).toEqual(['mypack:a', 'mypack:b']);
    expect(all).not.toHaveBeenCalled();
    // A new source, a move to another station or priority, or a delete is put in place too.
    stations.upsertSeedSource({ ...source('s1', 'mypack:b', 1), url: 'https://moved.example.com/' });
    stations.upsertSeedSource(source('s3', 'mypack:a', 0));
    expect(stations.listSources('mypack:a').map((x) => x.id)).toEqual(['s3', 's2']);
    expect(stations.listSources('mypack:b').map((x) => x.id)).toEqual(['s1']);
    stations.deleteSource('s2');
    expect(stations.listAllSources().map((x) => x.id)).toEqual(['s3', 's1']);
    // So are a new pack station and a rename that moves one.
    stations.upsertProviderStation(station('mypack:c', 'A first'));
    stations.renameStation('mypack:a', 'Zed', true);
    expect(stations.listStations(null).map((x) => x.id)).toEqual(['mypack:c', 'mypack:b', 'mypack:a']);
    expect(all).not.toHaveBeenCalled();
  });

  it('keeps both caches the same as a fresh read through a run of writes, never reading a table again', () => {
    const { db, stations } = memoryDb();
    // Names that sort differently with and without NOCASE, accents, and a character beyond U+FFFF.
    const names = [
      'alpha',
      'Beta',
      'beta two',
      'Émile',
      'émile',
      'zulu',
      'Zulu FM',
      '_under',
      '😀 Smile',
      'ﬀ',
    ];
    let seed = 7;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 6; i++)
      stations.upsertProviderStation({ ...station(`mypack:s${i}`), sortOrder: i % 3 });
    for (let i = 0; i < 6; i++) stations.upsertSeedSource(source(`src${i}`, `mypack:s${i % 3}`, i % 2));
    stations.insertCustomStation({
      id: 'custom:mine',
      guildId: '111111111111111111',
      slug: 'mine',
      displayName: 'Mine',
      description: null,
      category: null,
      websiteUrl: null,
      language: null,
      createdById: '222222222222222222',
    });
    stations.upsertSeedSource(source('src-custom', 'custom:mine'));
    stations.listStations('111111111111111111');
    stations.listAllSources();
    const all = vi.spyOn(db, 'all');
    let next = 6;
    for (let step = 0; step < 300; step++) {
      const st = `mypack:s${rand(next)}`;
      switch (rand(7)) {
        case 0:
          stations.upsertProviderStation({
            ...station(`mypack:s${next++}`, names[rand(names.length)]),
            sortOrder: rand(3),
          });
          break;
        case 1:
          stations.renameStation(st, names[rand(names.length)]!, rand(2) === 0);
          break;
        case 2:
          stations.upsertProviderStation({ ...station(st, names[rand(names.length)]), sortOrder: rand(3) });
          break;
        case 3:
          stations.setCatalogueStatus(st, rand(2) === 0 ? 'retired' : 'active');
          break;
        case 4:
          stations.upsertSeedSource(source(`src${rand(40)}`, st, rand(3)));
          break;
        case 5:
          stations.deleteSource(`src${rand(40)}`);
          break;
        default:
          stations.markSeen([st, `mypack:s${rand(next)}`], `2026-11-0${1 + rand(9)}`);
      }
    }
    stations.deleteGuildCustomStations('111111111111111111');
    // Only the rows written were read again (by ID, or that server's custom stations), never a table.
    for (const [sql] of all.mock.calls) expect(sql).toMatch(/WHERE (id IN|provider = 'custom' AND guild_id)/);
    const fresh = new StationRepository(db);
    const ids = (list: Array<{ id: string }>) => list.map((x) => x.id);
    expect(ids(stations.listStations(null, { includeRetired: true }))).toEqual(
      ids(fresh.listStations(null, { includeRetired: true })),
    );
    expect(stations.listStations(null)).toEqual(fresh.listStations(null));
    expect(stations.listAllSources()).toEqual(fresh.listAllSources());
    expect(stations.providerIds()).toEqual(fresh.providerIds());
    expect(stations.getSource('src-custom')).toBeNull();
    for (let i = 0; i < next; i++) {
      expect(stations.getStation(`mypack:s${i}`)).toEqual(fresh.getStation(`mypack:s${i}`));
      expect(stations.listSources(`mypack:s${i}`)).toEqual(fresh.listSources(`mypack:s${i}`));
    }
  });

  it('compares names the way SQLite’s NOCASE collation does', () => {
    const { db } = memoryDb();
    const words = [
      '',
      'a',
      'A',
      'ab',
      'aB',
      'b',
      'Z',
      '_',
      '[',
      '`',
      'é',
      'É',
      'z',
      '�',
      '😀',
      '😁',
      'ﬀ',
      'a😀',
    ];
    for (const a of words) {
      for (const b of words) {
        const r = db.get<{ c: number }>(
          'SELECT CASE WHEN ?1 = ?2 COLLATE NOCASE THEN 0 WHEN ?1 < ?2 COLLATE NOCASE THEN -1 ELSE 1 END AS c',
          [a, b],
        )!;
        expect(Math.sign(compareNoCase(a, b)), `${a} vs ${b}`).toBe(r.c);
      }
    }
  });

  it('drops a deleted custom station’s sources from the cache without reading them all again', () => {
    const { db, stations } = memoryDb();
    stations.upsertProviderStation(station('mypack:a'));
    stations.upsertSeedSource(source('s1', 'mypack:a'));
    stations.insertCustomStation({
      id: 'custom:mine',
      guildId: '111111111111111111',
      slug: 'mine',
      displayName: 'Mine',
      description: null,
      category: null,
      websiteUrl: null,
      language: null,
      createdById: '222222222222222222',
    });
    stations.upsertSeedSource(source('s2', 'custom:mine'));
    expect(stations.listAllSources().map((x) => x.id)).toEqual(['s2', 's1']);
    const all = vi.spyOn(db, 'all');
    // Another server's station of that ID is not this server's to delete.
    expect(stations.deleteCustomStation('333333333333333333', 'custom:mine')).toBe(false);
    expect(stations.getSource('s2')).not.toBeNull();
    expect(stations.deleteCustomStation('111111111111111111', 'custom:mine')).toBe(true);
    expect(stations.getSource('s2')).toBeNull();
    expect(stations.listAllSources().map((x) => x.id)).toEqual(['s1']);
    expect(all.mock.calls.some(([sql]) => String(sql).includes('FROM station_sources'))).toBe(false);
  });

  it("lists each server's own custom stations without scanning every server's", () => {
    const { stations } = memoryDb();
    stations.upsertProviderStation(station('mypack:a'));
    for (const g of ['111111111111111111', '222222222222222222']) {
      stations.insertCustomStation({
        id: `custom:${g.slice(0, 3)}`,
        guildId: g,
        slug: `mine-${g.slice(0, 3)}`,
        displayName: `Mine ${g.slice(0, 3)}`,
        description: null,
        category: null,
        websiteUrl: null,
        language: null,
        createdById: '333333333333333333',
      });
    }
    expect(stations.listStations('111111111111111111').map((x) => x.id)).toEqual(['mypack:a', 'custom:111']);
    expect(stations.listStations('222222222222222222').map((x) => x.id)).toEqual(['mypack:a', 'custom:222']);
    expect(stations.listStations(null).map((x) => x.id)).toEqual(['mypack:a']);
    expect(stations.listBuiltinStations().map((x) => x.id)).toEqual(['mypack:a']);
    stations.setCatalogueStatus('mypack:a', 'retired');
    expect(stations.listStations('111111111111111111').map((x) => x.id)).toEqual(['custom:111']);
    expect(stations.listStations(null, { includeRetired: true }).map((x) => x.id)).toEqual(['mypack:a']);
  });

  it("re-reads only that server's custom stations after a custom-station write", () => {
    const { db, stations } = memoryDb();
    const [g1, g2] = ['111111111111111111', '222222222222222222'];
    const custom = (guildId: string, slug: string, displayName: string) => ({
      id: `custom:${slug}`,
      guildId,
      slug,
      displayName,
      description: null,
      category: null,
      websiteUrl: null,
      language: null,
      createdById: '333333333333333333',
    });
    stations.upsertProviderStation(station('mypack:a'));
    stations.upsertProviderStation(station('mypack:b'));
    stations.insertCustomStation(custom(g2, 'other', 'Other'));
    stations.insertCustomStation(custom(g1, 'mine-b', 'Mine B'));
    const builtin = stations.listBuiltinStations();
    const other = stations.listStations(g2);
    const all = vi.spyOn(db, 'all');
    stations.insertCustomStation(custom(g1, 'mine-a', 'Mine A'));
    stations.updateCustomStation(g1, 'custom:mine-b', { displayName: 'Mine C' });
    expect(stations.listStations(g1).map((x) => x.displayName)).toEqual([
      'mypack:a',
      'mypack:b',
      'Mine A',
      'Mine C',
    ]);
    stations.deleteCustomStation(g1, 'custom:mine-a');
    expect(stations.listStations(g1).map((x) => x.id)).toEqual(['mypack:a', 'mypack:b', 'custom:mine-b']);
    expect(stations.getStation('custom:mine-a')).toBeNull();
    // Each write read just that server's custom stations; the whole list was never read again.
    expect(all).toHaveBeenCalledTimes(3);
    for (const [sql, params] of all.mock.calls) {
      expect(sql).toMatch(/guild_id = \?/);
      expect(params).toEqual([g1]);
    }
    // Another server's stations and the pack stations are the very same cached rows.
    expect(stations.listStations(g2)).toEqual(other);
    for (const [i, st] of stations.listStations(g2).entries()) expect(st).toBe(other[i]);
    for (const [i, st] of stations.listBuiltinStations().entries()) expect(st).toBe(builtin[i]);
    expect(stations.getStation('custom:other')).toBe(other.at(-1));
    // The cache matches a fresh read.
    expect(new StationRepository(db).listStations(g1)).toEqual(stations.listStations(g1));
    stations.deleteGuildCustomStations(g1);
    expect(stations.listStations(g1).map((x) => x.id)).toEqual(['mypack:a', 'mypack:b']);
    expect(stations.listStations(g2).map((x) => x.id)).toEqual(['mypack:a', 'mypack:b', 'custom:other']);
  });

  it('forgets a custom-station write that rolled back', () => {
    const { stations } = memoryDb();
    stations.upsertProviderStation(station('mypack:a'));
    stations.listStations(null);
    expect(() =>
      stations.transaction(() => {
        stations.insertCustomStation({
          id: 'custom:mine',
          guildId: '111111111111111111',
          slug: 'mine',
          displayName: 'Mine',
          description: null,
          category: null,
          websiteUrl: null,
          language: null,
          createdById: '333333333333333333',
        });
        expect(stations.listStations('111111111111111111')).toHaveLength(2);
        throw new Error('roll back');
      }),
    ).toThrow('roll back');
    expect(stations.listStations('111111111111111111').map((x) => x.id)).toEqual(['mypack:a']);
    expect(stations.getStation('custom:mine')).toBeNull();
  });

  it('reads once, and reads again after a station or source write (only)', () => {
    const { db, stations, guilds } = memoryDb();
    stations.upsertProviderStation(station('mypack:a'));
    stations.upsertSeedSource(source('s2', 'mypack:a', 2));
    stations.upsertSeedSource(source('s1', 'mypack:a', 1));
    const prepare = vi.spyOn(db.raw, 'prepare');
    const all = vi.spyOn(db, 'all');
    expect(stations.listSources('mypack:a').map((s) => s.id)).toEqual(['s1', 's2']);
    stations.listStations(null);
    stations.listSources('mypack:a');
    stations.getSource('s1');
    stations.getStation('mypack:a');
    expect(all).toHaveBeenCalledTimes(2); // one read of each table
    guilds.updateSettings('111111111111111111', { idleMode: '24x7' });
    stations.listStations(null);
    expect(all).toHaveBeenCalledTimes(2); // other tables' writes don't matter
    stations.pruneSourceHistory('s1', 5);
    stations.insertSyncReport({
      provider: 'mypack',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      success: true,
      trigger: 'manual',
      summary: {},
    });
    stations.listAllSources();
    expect(all).toHaveBeenCalledTimes(2); // nor do probe history and sync reports
    stations.recordFailure('s1', 'TIMEOUT');
    expect(stations.getSource('s1')?.consecutiveFailures).toBe(1);
    expect(stations.listSources('mypack:a')[0]?.consecutiveFailures).toBe(1);
    prepare.mockRestore();
  });

  it('forgets what it read inside a transaction that rolled back', () => {
    const { stations } = memoryDb();
    stations.upsertProviderStation(station('mypack:a', 'Before'));
    expect(() =>
      stations.transaction(() => {
        stations.renameStation('mypack:a', 'During', false);
        expect(stations.listStations(null)[0]?.displayName).toBe('During');
        throw new Error('roll back');
      }),
    ).toThrow('roll back');
    expect(stations.listStations(null)[0]?.displayName).toBe('Before');
    expect(stations.getStation('mypack:a')?.displayName).toBe('Before');
  });

  it('sees the result of every kind of station and source write', () => {
    const custom = (id: string, displayName = id) => ({
      id: `custom:${id}`,
      guildId: '111111111111111111',
      slug: id,
      displayName,
      description: null,
      category: null,
      websiteUrl: null,
      language: null,
      createdById: '222222222222222222',
    });
    type Repo = ReturnType<typeof memoryDb>['stations'];
    const cases: Array<[string, (r: Repo) => void, (r: Repo) => unknown, unknown]> = [
      [
        'setSourceEnabled',
        (r) => r.setSourceEnabled('s1', false, 'gone'),
        (r) => r.getSource('s1')?.enabled,
        false,
      ],
      [
        'setIdentityOverride',
        (r) => r.setIdentityOverride('s1', 'verified'),
        (r) => r.getSource('s1')?.identityOverride,
        'verified',
      ],
      [
        'applyProbePatch',
        (r) => r.applyProbePatch('s1', { codec: 'mp3' }),
        (r) => r.listSources('mypack:a')[0]?.codec,
        'mp3',
      ],
      [
        'recordSuccess',
        (r) => r.recordSuccess('s1', '2026-01-01T00:00:00.000Z'),
        (r) => r.getSource('s1')?.lastSuccessAt,
        '2026-01-01T00:00:00.000Z',
      ],
      [
        'setCooldown',
        (r) => r.setCooldown('s1', '2030-01-01T00:00:00.000Z'),
        (r) => r.getSource('s1')?.cooldownUntil,
        '2030-01-01T00:00:00.000Z',
      ],
      ['deleteSource', (r) => r.deleteSource('s1'), (r) => r.listAllSources().length, 0],
      [
        'upsertSeedSource (new URL)',
        (r) => r.upsertSeedSource({ ...source('s1', 'mypack:a'), url: 'https://moved.example.com/' }),
        (r) => r.getSource('s1')?.url,
        'https://moved.example.com/',
      ],
      [
        'restoreSource',
        (r) => {
          const row = r.snapshotSource('s1')!;
          r.applyProbePatch('s1', { codec: 'aac' });
          r.listAllSources();
          r.restoreSource(row);
        },
        (r) => r.getSource('s1')?.codec,
        null,
      ],
      [
        'setCatalogueStatus',
        (r) => r.setCatalogueStatus('mypack:a', 'retired'),
        (r) => r.listStations(null).length,
        0,
      ],
      [
        'renameStation',
        (r) => r.renameStation('mypack:a', 'Renamed', true),
        (r) => r.getStation('mypack:a')?.aliases,
        ['mypack:a'],
      ],
      [
        'insertCustomStation',
        (r) => r.insertCustomStation(custom('mine')),
        (r) => r.listStations('111111111111111111').length,
        2,
      ],
      [
        'updateCustomStation',
        (r) => {
          r.insertCustomStation(custom('mine'));
          r.listStations(null);
          r.updateCustomStation('111111111111111111', 'custom:mine', { displayName: 'Changed' });
        },
        (r) => r.getStation('custom:mine')?.displayName,
        'Changed',
      ],
      [
        'deleteCustomStation',
        (r) => {
          r.insertCustomStation(custom('mine'));
          r.listStations(null);
          r.deleteCustomStation('111111111111111111', 'custom:mine');
        },
        (r) => r.getStation('custom:mine'),
        null,
      ],
      [
        'deleteGuildCustomStations',
        (r) => {
          r.insertCustomStation(custom('mine'));
          r.listStations(null);
          r.deleteGuildCustomStations('111111111111111111');
        },
        (r) => r.listStations('111111111111111111').length,
        1,
      ],
    ];
    for (const [name, write, read, expected] of cases) {
      const { stations } = memoryDb();
      stations.upsertProviderStation(station('mypack:a'));
      stations.upsertSeedSource(source('s1', 'mypack:a'));
      // Fill the cache first, so a write that skipped invalidation would leave old values.
      stations.listStations(null);
      stations.listAllSources();
      write(stations);
      expect(read(stations), name).toEqual(expected);
    }
  });

  it('forgets a nested write that rolled back, and keeps the outer one', () => {
    const { stations } = memoryDb();
    stations.upsertProviderStation(station('mypack:a', 'Before'));
    stations.transaction(() => {
      stations.renameStation('mypack:a', 'Outer', false);
      try {
        stations.transaction(() => {
          stations.renameStation('mypack:a', 'Inner', false);
          expect(stations.getStation('mypack:a')?.displayName).toBe('Inner');
          throw new Error('inner only');
        });
      } catch {
        /* the outer transaction carries on */
      }
      expect(stations.listStations(null)[0]?.displayName).toBe('Outer');
    });
    expect(stations.getStation('mypack:a')?.displayName).toBe('Outer');
  });

  it('shares rows read-only, so one caller cannot change what another sees', () => {
    const { stations } = memoryDb();
    stations.upsertProviderStation(station('mypack:a'));
    stations.upsertSeedSource(source('s1', 'mypack:a'));
    const src = stations.listSources('mypack:a')[0]!;
    expect(() => {
      (src as { enabled: boolean }).enabled = false;
    }).toThrow();
    stations.listSources('mypack:a').pop();
    expect(stations.listSources('mypack:a')).toHaveLength(1);
  });
});

describe('control panels at start-up', () => {
  it('lists only servers with a panel, without creating settings for any other', () => {
    const { db, guilds } = memoryDb();
    guilds.updateSettings('111111111111111111', {
      panelChannelId: '222222222222222222',
      panelMessageId: '333333333333333333',
    });
    guilds.getSettings('444444444444444444');
    expect(guilds.guildsWithPanel()).toEqual(['111111111111111111']);
    const rows = () => db.get<{ n: number }>('SELECT COUNT(*) AS n FROM guild_settings')!.n;
    const before = rows();
    guilds.guildsWithPanel();
    expect(rows()).toBe(before);
  });
});

describe('transactions', () => {
  it('rolls back and keeps working when a commit itself fails', () => {
    const db = new Db(':memory:');
    db.raw.exec(`CREATE TABLE parent (id INTEGER PRIMARY KEY);
      CREATE TABLE child (id INTEGER PRIMARY KEY,
        parent_id INTEGER REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED);`);
    const before = db.rollbacks;
    // The foreign key is only checked at COMMIT, so the commit is what fails.
    expect(() => db.transaction(() => db.run('INSERT INTO child (parent_id) VALUES (42)'))).toThrow(
      /FOREIGN KEY/,
    );
    expect(db.rollbacks).toBe(before + 1);
    expect(db.raw.isTransaction).toBe(false);
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM child')?.n).toBe(0);
    // Later transactions, nested ones included, still work.
    db.transaction(() => {
      db.run('INSERT INTO parent (id) VALUES (1)');
      db.transaction(() => db.run('INSERT INTO child (parent_id) VALUES (1)'));
    });
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM child')?.n).toBe(1);
  });
});

describe('probe history index', () => {
  it('lets the hourly clean-up find old results by start time without reading the whole table', () => {
    const { db } = memoryDb();
    const plan = db
      .all<{ detail: string }>(
        "EXPLAIN QUERY PLAN DELETE FROM source_probe_results WHERE started_at < '2026-01-01'",
      )
      .map((r) => r.detail)
      .join(' ');
    expect(plan).toMatch(/USING (COVERING )?INDEX ix_probe_results_started/);
  });
});

describe('foreign key indexes', () => {
  it.each([
    ['guild_favourites', 'station_id', 'ix_guild_favourites_station'],
    ['guild_queue', 'station_id', 'ix_guild_queue_station'],
    ['guild_source_preferences', 'station_id', 'ix_guild_source_preferences_station'],
    ['guild_source_preferences', 'preferred_source_id', 'ix_guild_source_preferences_source'],
  ])('finds %s rows by %s without reading the whole table', (table, column, index) => {
    const { db } = memoryDb();
    // The lookup a cascading delete of a station or source makes.
    const plan = db
      .all<{ detail: string }>(`EXPLAIN QUERY PLAN SELECT 1 FROM ${table} WHERE ${column} = 'x'`)
      .map((r) => r.detail)
      .join(' ');
    expect(plan).toMatch(new RegExp(`USING (COVERING )?INDEX ${index}`));
  });
});
