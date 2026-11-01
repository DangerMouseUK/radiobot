import { describe, expect, it } from 'vitest';
import type { CatalogueStatus } from '../../src/catalogue/types.ts';
import { Metrics } from '../../src/observability/metrics.ts';
import { SessionManager } from '../../src/voice/session-manager.ts';
import { memoryDb, silentLogger } from '../helpers.ts';

/** A manager whose guild "g1" wants to resume fg:x in voice-1; the fake client has no channels. */
function setup(catalogueStatus: CatalogueStatus = 'active') {
  const { stations, guilds } = memoryDb();
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
    catalogueStatus,
    description: null,
  });
  guilds.updateSettings('g1', { resumeOnRestart: true });
  guilds.setIntent('g1', {
    desiredState: 'playing',
    desiredStationId: 'fg:x',
    desiredVoiceChannelId: 'voice-1',
  });
  const guild = { id: 'g1', channels: { cache: new Map(), fetch: async () => null } };
  const client = { guilds: { cache: new Map([['g1', guild]]), fetch: async () => guild }, on() {} };
  const manager = new SessionManager({
    client: client as never,
    stations,
    guilds,
    sources: {} as never,
    http: {} as never,
    registry: {} as never,
    ffmpegPath: 'ffmpeg',
    linkFactory: async () => {
      throw new Error('not reached');
    },
    maxActiveStreams: 3,
    maxOpusKbps: 510,
    brandLabels: () => new Set(),
    notify: () => {},
    logger: silentLogger(),
    metrics: new Metrics(),
  });
  return { manager, guilds };
}

describe('SessionManager.restoreOnBoot', () => {
  it('tries to resume a station that may still be played', async () => {
    const t = setup();
    t.manager.setStationFilter(() => true);
    await t.manager.restoreOnBoot();
    // The fake guild has no voice channel, so the attempt fails, which proves it was made.
    expect(t.guilds.getIntent('g1')?.lastErrorCode).toBe('VOICE_CHANNEL_GONE');
  });

  it('does not resume a station whose pack is disabled', async () => {
    const t = setup();
    const asked: string[] = [];
    t.manager.setStationFilter((guildId, station) => {
      asked.push(`${guildId}/${station.id}`);
      return false;
    });
    await t.manager.restoreOnBoot();
    expect(asked).toEqual(['g1/fg:x']);
    expect(t.guilds.getIntent('g1')?.lastErrorCode).toBeNull();
    expect(t.manager.get('g1')).toBeNull();
  });

  it('never resumes a retired station', async () => {
    const t = setup('retired');
    await t.manager.restoreOnBoot();
    expect(t.guilds.getIntent('g1')?.lastErrorCode).toBeNull();
    expect(t.manager.get('g1')).toBeNull();
  });
});
