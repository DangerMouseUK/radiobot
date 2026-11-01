import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Db, loadMigrations, type Migration, matchOwner } from '../../src/persistence/db.ts';
import { GuildRepository } from '../../src/persistence/repositories/guilds.ts';
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
      desiredStationId: 'fg:fg-chic',
      desiredVoiceChannelId: 'v1',
    });
    guilds.setIntent('2', { desiredState: 'stopped' });
    expect(guilds.getIntent('1')?.desiredStationId).toBe('fg:fg-chic');
    expect(guilds.getIntent('2')?.desiredStationId).toBeNull();
    guilds.setIntent('1', { desiredState: 'stopped' });
    expect(guilds.getIntent('1')?.desiredStationId).toBe('fg:fg-chic');
    expect(guilds.getIntent('1')?.desiredState).toBe('stopped');
  });

  it('toggles favourites and purges a guild', () => {
    const { guilds, stations } = memoryDb();
    stations.upsertProviderStation({
      id: 'fg:x',
      provider: 'fg',
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
    expect(guilds.toggleFavourite('g', 'fg:x')).toBe(true);
    expect(guilds.listFavourites('g')).toEqual(['fg:x']);
    expect(guilds.toggleFavourite('g', 'fg:x')).toBe(false);
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
    defaultStationId: 'fg:fg-chic',
    preferredVoiceChannelId: 'v9',
  };
  const intent = (desiredState: 'playing' | 'stopped' | 'left' | 'kicked' | 'idle') => ({
    guildId: 'g',
    desiredStationId: 'fg:fg-dj-radio',
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
      stationId: 'fg:fg-dj-radio',
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
  it('keeps only the newest N per source', () => {
    const { stations } = memoryDb();
    stations.upsertProviderStation({
      id: 'fg:x',
      provider: 'fg',
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
      stationId: 'fg:x',
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
    stations.pruneProbeResults(30, 30);
    expect(stations.listProbeResults('s', 100)).toHaveLength(30);
  });
});

describe('seeded sources', () => {
  const station = (id: string) => ({
    id,
    provider: 'fg',
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
    stations.upsertProviderStation(station('fg:a'));
    stations.upsertProviderStation(station('fg:b'));
    stations.upsertSeedSource(seed('fg:a'));
    stations.setIdentityOverride('s', 'verified');
    guilds.setPreference('g', 'fg:a', 'pin', 's', '1');
    expect(stations.upsertSeedSource(seed('fg:a'))).toBe('unchanged');
    expect(stations.upsertSeedSource(seed('fg:b'))).toBe('updated');
    expect(stations.getSource('s')).toMatchObject({
      stationId: 'fg:b',
      identityOverride: null,
      identityStatus: 'unverified',
    });
    expect(stations.listSources('fg:a')).toEqual([]);
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
