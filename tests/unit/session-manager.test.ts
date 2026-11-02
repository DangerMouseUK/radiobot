import { EventEmitter } from 'node:events';
import { ChannelType } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import type { CatalogueStatus } from '../../src/catalogue/types.ts';
import { Metrics } from '../../src/observability/metrics.ts';
import type { PlaybackIntent } from '../../src/persistence/repositories/guilds.ts';
import type { SourceProbePatch } from '../../src/persistence/repositories/stations.ts';
import type { probeSource } from '../../src/streams/probe.ts';
import { SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import { SourceService } from '../../src/streams/source-service.ts';
import { UrlPolicy } from '../../src/streams/url-policy.ts';
import type { VoiceLink, VoiceLinkEvents } from '../../src/voice/link.ts';
import type { SessionNotice, SessionTimings } from '../../src/voice/session.ts';
import { memoryDb, silentLogger } from '../helpers.ts';

/**
 * A real SessionManager, GuildSessions and SourceService over an in-memory database. Discord,
 * the stream connection and FFmpeg are fakes: nothing here touches the network or spawns a process.
 */
const fakes = vi.hoisted(() => ({
  pipelines: [] as Array<{
    deps: { owner: string; ffmpegPath: string };
    plan: { channelBitrateKbps: number | null };
    stopped: boolean;
  }>,
  opened: [] as Array<{ url: string; closed: () => boolean }>,
  icyName: null as string | null,
}));

vi.mock('../../src/audio/pipeline.ts', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  const { PassThrough: Pass } = await import('node:stream');
  class AudioPipeline extends Emitter {
    readonly output = new Pass();
    readonly stats = {
      startedAt: Date.now(),
      firstOutputAt: null as number | null,
      lastOutputAt: null as number | null,
      outputBytes: 0,
      inputBytes: 0,
      pid: 1,
    };
    readonly stderrTail: string[] = [];
    stopped = false;
    readonly input: { close(): void };
    readonly plan: unknown;
    readonly deps: unknown;
    readonly #ticker: NodeJS.Timeout;
    constructor(input: { close(): void }, plan: unknown, deps: unknown) {
      super();
      this.input = input;
      this.plan = plan;
      this.deps = deps;
      fakes.pipelines.push(this as never);
      setTimeout(() => {
        if (this.stopped) return;
        this.stats.firstOutputAt = Date.now();
        this.stats.lastOutputAt = Date.now();
        this.emit('firstAudio');
      }, 1);
      this.#ticker = setInterval(() => {
        this.stats.lastOutputAt = Date.now();
      }, 20);
    }
    stop() {
      this.stopped = true;
      clearInterval(this.#ticker);
      this.input.close();
    }
  }
  return { AudioPipeline };
});

vi.mock('../../src/streams/input.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/streams/input.ts')>();
  const { PassThrough: Pass } = await import('node:stream');
  return {
    ...actual,
    openSourceInput: async (_client: unknown, url: string) => {
      const stream = new Pass();
      const input = new actual.SourceInput(
        stream,
        {
          transport: 'http-continuous',
          requestedHost: 'stream.example.com',
          finalHost: 'stream.example.com',
          remoteAddress: '203.0.113.10',
          remotePort: 443,
          redirects: [],
          contentType: 'audio/mpeg',
          headersSummary: {},
          advertisedBitrateKbps: 128,
          icyName: fakes.icyName,
          hls: null,
        },
        {
          segmentHost: null,
          bytesIn: 0,
          firstByteAt: null,
          lastByteAt: null,
          segmentsFetched: 0,
          segmentFailures: 0,
          playlistFailures: 0,
          skippedSegments: 0,
        },
      );
      fakes.opened.push({ url, closed: () => stream.destroyed });
      return input;
    },
  };
});

const { SessionManager, bootDecision } = await import('../../src/voice/session-manager.ts');

const BOT = '100000000000000001';
const G1 = '223456789012345678';
const G2 = '323456789012345678';
const VOICE_A = '423456789012345678';
const VOICE_B = '523456789012345678';
const HUMAN = '623456789012345678';

class FakeLink extends EventEmitter<VoiceLinkEvents> implements VoiceLink {
  ready = true;
  destroyed = false;
  readonly channelId: string;
  constructor(channelId: string) {
    super();
    this.channelId = channelId;
  }
  play(): void {}
  stopAudio(): void {}
  playbackMs(): number {
    return 0;
  }
  playerStatus(): string {
    return 'playing';
  }
  encryption(): string {
    return 'test';
  }
  stats() {
    return {
      wsPingMs: 20,
      endpoint: null,
      packetsPlayed: null,
      packetTiming: { late: 0, worstGapMs: null },
      encryptionMode: null,
      status: 'ready',
    };
  }
  detach(): void {}
  destroy(): void {
    this.destroyed = true;
  }
}

const TIMINGS: Partial<SessionTimings> = {
  stallMs: 5_000,
  firstAudioTimeoutMs: 2_000,
  stableMs: 60_000,
  noSourceRetryMs: 60_000,
  stoppedIdleLeaveMs: 60_000,
  emptyLeaveMs: 30,
  emptyPauseMs: 30,
  watchdogIntervalMs: 1_000,
  backoff: [5, 5, 5],
  reconnectBackoff: [5, 5],
};

const verified = (o: SourceProbePatch = {}): SourceProbePatch => ({
  codec: 'mp3',
  sampleRateHz: 44_100,
  channels: 2,
  measuredBitrateKbps: 128,
  bitrateConfidence: 'measured',
  identityStatus: 'verified',
  identityConfidence: 'medium',
  verificationState: 'eligible',
  lastProbeAt: new Date().toISOString(),
  ...o,
});

const managers: Array<{ shutdown(): void }> = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.shutdown();
  fakes.pipelines.length = 0;
  fakes.opened.length = 0;
  fakes.icyName = null;
});

async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function voiceChannel(id: string, guildId: string) {
  return {
    id,
    guildId,
    type: ChannelType.GuildVoice,
    joinable: true,
    bitrate: 96_000,
    permissionsFor: () => ({ has: () => true }),
  };
}

function setup(
  opts: {
    maxActiveStreams?: number;
    catalogueStatus?: CatalogueStatus;
    sources?: Array<{ id: string; patch?: SourceProbePatch }>;
  } = {},
) {
  const repos = memoryDb();
  const station = (id: string, displayName: string, status: CatalogueStatus = 'active') =>
    repos.stations.upsertProviderStation({
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
      catalogueStatus: status,
      description: null,
    });
  station('mypack:my-station', 'My Station', opts.catalogueStatus);
  station('mypack:other-station', 'Other Station');
  for (const s of opts.sources ?? [{ id: 'my-src', patch: verified() }]) {
    repos.stations.upsertSeedSource({
      id: s.id,
      stationId: 'mypack:my-station',
      url: `https://stream.example.com/${s.id}`,
      label: null,
      priority: 10,
      transportHint: 'http-continuous',
      codecHint: 'mp3',
      provenance: 'official-player',
      provenanceDetail: 'test',
      rightsStatus: 'unreviewed',
    });
    if (s.patch) repos.stations.applyProbePatch(s.id, s.patch);
  }
  repos.stations.upsertSeedSource({
    id: 'other-src',
    stationId: 'mypack:other-station',
    url: 'https://other.example.com/other-src',
    label: null,
    priority: 10,
    transportHint: 'http-continuous',
    codecHint: 'mp3',
    provenance: 'official-player',
    provenanceDetail: 'test',
    rightsStatus: 'unreviewed',
  });
  repos.stations.applyProbePatch('other-src', verified());

  const probes: string[] = [];
  const probeImpl: typeof probeSource = async (_deps, url) => {
    probes.push(url);
    throw new Error('no probing in these tests');
  };
  const registry = new ProcessRegistry();
  const killAll = vi.spyOn(registry, 'killAll');
  const sources = new SourceService({
    stations: repos.stations,
    guilds: repos.guilds,
    client: new SafeHttpClient(new UrlPolicy({ allowInsecureHttp: true })),
    registry,
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    maxConcurrentProbes: 1,
    logger: silentLogger(),
    metrics: new Metrics(),
    probeImpl,
  });

  const client = Object.assign(new EventEmitter(), {
    user: { id: BOT },
    guilds: { cache: new Map<string, unknown>(), fetch: async () => null },
    channels: { cache: new Map<string, unknown>() },
  });
  const guilds = new Map<
    string,
    { id: string; available: boolean; voiceStates: { cache: Map<string, unknown> } }
  >();
  const addGuild = (guildId: string, channelIds: string[]) => {
    const channels = new Map(channelIds.map((id) => [id, voiceChannel(id, guildId)]));
    for (const [id, ch] of channels) client.channels.cache.set(id, ch);
    const guild = {
      id: guildId,
      available: true,
      client,
      members: { me: { id: BOT } },
      channels: { cache: channels, fetch: async () => null },
      voiceStates: { cache: new Map<string, unknown>() },
    };
    client.guilds.cache.set(guildId, guild);
    guilds.set(guildId, guild);
    return guild;
  };
  addGuild(G1, [VOICE_A, VOICE_B]);
  addGuild(G2, [VOICE_A.replace('4', '7')]);

  const links: Array<{ link: FakeLink; channel: { id: string } }> = [];
  const notices: SessionNotice[] = [];
  const left: Array<[string, string]> = [];
  const manager = new SessionManager({
    client: client as never,
    stations: repos.stations,
    guilds: repos.guilds,
    sources,
    http: {} as never,
    registry,
    ffmpegPath: '/usr/bin/ffmpeg',
    linkFactory: async (channel) => {
      const link = new FakeLink(channel.id);
      links.push({ link, channel });
      return link;
    },
    maxActiveStreams: opts.maxActiveStreams ?? 3,
    maxOpusKbps: 510,
    brandLabels: (provider) => new Set(provider === 'mypack' ? ['mypack radio'] : []),
    notify: (n) => notices.push(n),
    logger: silentLogger(),
    metrics: new Metrics(),
    timings: TIMINGS,
  });
  manager.setLeaveHook((guildId, channelId) => {
    left.push([guildId, channelId]);
  });
  manager.attach();
  managers.push(manager);

  /** Someone (a listener, or the bot itself) moves between voice channels. */
  const voiceState = (guildId: string, userId: string, from: string | null, to: string | null) => {
    const guild = guilds.get(guildId)!;
    if (to)
      guild.voiceStates.cache.set(userId, { id: userId, channelId: to, member: { user: { bot: false } } });
    else guild.voiceStates.cache.delete(userId);
    client.emit(
      'voiceStateUpdate',
      { id: userId, channelId: from, guild },
      { id: userId, channelId: to, guild },
    );
  };

  return { ...repos, manager, client, sources, registry, killAll, links, notices, left, probes, voiceState };
}

describe('SessionManager: playing', () => {
  it('plays a verified source through one encoder owned by the session', async () => {
    const t = setup();
    const r = await t.manager.play(G1, 'mypack:my-station', VOICE_A, HUMAN);
    expect(r).toMatchObject({ ok: true, code: null });
    expect(r.selection?.selected?.id).toBe('my-src');
    expect(t.links.map((l) => l.channel.id)).toEqual([VOICE_A]);
    expect(fakes.opened.map((o) => o.url)).toEqual(['https://stream.example.com/my-src']);
    expect(fakes.pipelines).toHaveLength(1);
    expect(fakes.pipelines[0]!.deps).toMatchObject({ owner: `session:${G1}`, ffmpegPath: '/usr/bin/ffmpeg' });
    // The voice channel's bitrate is reported alongside the plan, never used to cap it.
    expect(fakes.pipelines[0]!.plan.channelBitrateKbps).toBe(96);
    expect(t.manager.activeStreams()).toBe(1);
    expect(t.manager.get(G1)?.state).toBe('PLAYING');
    expect(t.manager.get(G2)).toBeNull();
    expect(t.manager.all().map((s) => s.guildId)).toEqual([G1]);
    expect(t.probes).toEqual([]);
  });

  it('enforces the installation-wide stream limit, but lets a playing server switch station', async () => {
    const t = setup({ maxActiveStreams: 1 });
    expect((await t.manager.play(G1, 'mypack:my-station', VOICE_A, HUMAN)).ok).toBe(true);
    await expect(t.manager.play(G2, 'mypack:my-station', VOICE_A, HUMAN)).rejects.toMatchObject({
      code: 'STREAM_LIMIT',
    });
    expect(t.manager.get(G2)).toBeNull();
    const switched = await t.manager.play(G1, 'mypack:other-station', VOICE_A, HUMAN);
    expect(switched.ok).toBe(true);
    expect(t.manager.activeStreams()).toBe(1);
  });

  it('refuses a resume in another server while the limit is taken, and says so once', async () => {
    const t = setup({ maxActiveStreams: 1 });
    await t.manager.play(G1, 'mypack:my-station', VOICE_A, HUMAN);
    // A session that already exists but is not streaming asks before it starts.
    const other = t.manager.ensure(G2);
    t.guilds.setIntent(G2, { desiredState: 'playing' });
    const r = await other.play('mypack:my-station', VOICE_A.replace('4', '7'), null);
    expect(r.code).toBe('STREAM_LIMIT');
    expect(t.notices.filter((n) => n.code === 'STREAM_LIMIT').map((n) => n.guildId)).toEqual([G2]);
    expect(t.manager.ensure(G2)).toBe(other);
  });
});

describe('SessionManager: identity at play time', () => {
  it('refuses a stream that now names another catalogue station, and records the contradiction', async () => {
    const t = setup();
    fakes.icyName = 'Other Station';
    const r = await t.manager.play(G1, 'mypack:my-station', VOICE_A, HUMAN);
    expect(r.ok).toBe(false);
    expect(r.code).toBe('IDENTITY_MISMATCH');
    // Nothing was played from it, and its connection was closed at once.
    expect(fakes.pipelines).toEqual([]);
    expect(fakes.opened).toHaveLength(1);
    expect(fakes.opened[0]!.closed()).toBe(true);
    const src = t.stations.getSource('my-src')!;
    expect(src.identityStatus).toBe('mismatch');
    expect(src.verificationState).toBe('unverified');
    expect(
      src.identityEvidence.some((e) => e.verdict === 'contradicts' && /Other Station/.test(e.detail)),
    ).toBe(true);
    // With no other verified source, the bot says so and plays nothing in its place.
    await until(() => t.manager.get(G1)?.status().lastError?.code === 'NO_ELIGIBLE_SOURCE');
    expect(fakes.pipelines).toEqual([]);
    expect(t.notices.map((n) => n.code)).toContain('NO_ELIGIBLE_SOURCE');
  });

  it("trusts an admin's review over the stream's name", async () => {
    const t = setup();
    t.stations.setIdentityOverride('my-src', 'verified');
    fakes.icyName = 'Other Station';
    const r = await t.manager.play(G1, 'mypack:my-station', VOICE_A, HUMAN);
    expect(r.ok).toBe(true);
    expect(t.stations.getSource('my-src')!.identityStatus).toBe('verified');
  });

  it('accepts its own name, a brand label or no name at all', async () => {
    for (const name of ['My Station', 'MyPack Radio', null]) {
      const t = setup();
      fakes.icyName = name;
      expect((await t.manager.play(G1, 'mypack:my-station', VOICE_A, HUMAN)).ok).toBe(true);
      expect(t.stations.getSource('my-src')!.identityStatus).toBe('verified');
      t.manager.shutdown();
      fakes.pipelines.length = 0;
      fakes.opened.length = 0;
    }
  });
});

describe('SessionManager: Discord events', () => {
  it('follows listeners in its channel and leaves when the last one goes', async () => {
    const t = setup();
    t.voiceState(G1, HUMAN, null, VOICE_A);
    await t.manager.play(G1, 'mypack:my-station', VOICE_A, HUMAN);
    // Someone in another channel, or in a server without a session, changes nothing.
    t.voiceState(G1, '723456789012345678', null, VOICE_B);
    t.voiceState(G2, '723456789012345678', null, VOICE_A);
    await new Promise((r) => setTimeout(r, 60));
    expect(t.manager.get(G1)?.state).toBe('PLAYING');
    t.voiceState(G1, HUMAN, VOICE_A, null);
    await until(() => t.notices.some((n) => n.kind === 'idle-left'));
    expect(t.manager.get(G1)?.state).toBe('IDLE');
    expect(t.left).toEqual([[G1, VOICE_A]]);
    expect(t.guilds.getIntent(G1)?.desiredState).toBe('idle');
  });

  it('follows a move to an approved channel and keeps the move for the next resume', async () => {
    const t = setup();
    t.voiceState(G1, HUMAN, null, VOICE_A);
    await t.manager.play(G1, 'mypack:my-station', VOICE_A, HUMAN);
    t.voiceState(G1, HUMAN, VOICE_A, VOICE_B);
    t.voiceState(G1, BOT, VOICE_A, VOICE_B);
    expect(t.guilds.getIntent(G1)?.desiredVoiceChannelId).toBe(VOICE_B);
    expect(t.manager.get(G1)?.state).toBe('PLAYING');
    // A voice state of the bot that is not a move (a mute, say) changes nothing.
    t.voiceState(G1, BOT, VOICE_B, VOICE_B);
    expect(t.manager.get(G1)?.state).toBe('PLAYING');
    expect(t.notices).toEqual([]);
  });

  it('leaves when moved to a channel the radio may not use', async () => {
    const t = setup();
    t.guilds.updateSettings(G1, { allowedVoiceChannelIds: [VOICE_A] });
    await t.manager.play(G1, 'mypack:my-station', VOICE_A, HUMAN);
    t.voiceState(G1, BOT, VOICE_A, VOICE_B);
    expect(t.manager.get(G1)?.state).toBe('IDLE');
    expect(t.notices.at(-1)).toMatchObject({ guildId: G1, kind: 'error', code: 'VOICE_PERMISSION' });
    expect(t.notices.at(-1)?.message).toContain(`<#${VOICE_B}>`);
    expect(t.guilds.getIntent(G1)?.desiredState).toBe('idle');
  });

  it('leaves when moved away from its locked channel', async () => {
    const t = setup();
    t.guilds.updateSettings(G1, { voiceLock: true, preferredVoiceChannelId: VOICE_A });
    await t.manager.play(G1, 'mypack:my-station', VOICE_A, HUMAN);
    t.voiceState(G1, BOT, VOICE_A, VOICE_B);
    expect(t.manager.get(G1)?.state).toBe('IDLE');
    expect(t.notices.at(-1)?.code).toBe('VOICE_PERMISSION');
  });

  it('stops when its voice channel is deleted, and ignores other deletions', async () => {
    const t = setup();
    await t.manager.play(G1, 'mypack:my-station', VOICE_A, HUMAN);
    t.client.emit('channelDelete', { id: '823456789012345678' }); // a DM channel: no server
    t.client.emit('channelDelete', { id: VOICE_B, guildId: G1 });
    t.client.emit('channelDelete', { id: VOICE_A, guildId: G2 });
    expect(t.manager.get(G1)?.state).toBe('PLAYING');
    t.client.emit('channelDelete', { id: VOICE_A, guildId: G1 });
    expect(t.manager.get(G1)?.state).toBe('IDLE');
    expect(t.notices).toEqual([
      {
        guildId: G1,
        kind: 'error',
        code: 'VOICE_CHANNEL_GONE',
        message: 'The radio voice channel was deleted, so playback stopped.',
      },
    ]);
  });

  it('releases the session and deletes the server data when removed from a server', async () => {
    const t = setup();
    t.guilds.updateSettings(G1, { resumeOnRestart: true });
    t.stations.insertCustomStation({
      id: 'custom:my-custom',
      guildId: G1,
      slug: 'my-custom',
      displayName: 'My Custom',
      description: null,
      category: null,
      websiteUrl: null,
      language: null,
      createdById: HUMAN,
    });
    t.guilds.toggleFavourite(G1, 'custom:my-custom');
    await t.manager.play(G1, 'mypack:my-station', VOICE_A, HUMAN);
    const link = t.links[0]!.link;
    t.client.emit('guildDelete', { id: G1, available: true });
    expect(t.manager.get(G1)).toBeNull();
    expect(link.destroyed).toBe(true);
    expect(fakes.pipelines[0]!.stopped).toBe(true);
    expect(t.guilds.getIntent(G1)).toBeNull();
    expect(t.guilds.listGuildIdsWithSettings()).not.toContain(G1);
    expect(t.guilds.listFavourites(G1)).toEqual([]);
    expect(t.stations.countCustomStations(G1)).toBe(0);
  });

  it('deletes nothing of a removed server when a later step of the purge fails', () => {
    const t = setup();
    t.guilds.updateSettings(G1, { resumeOnRestart: true });
    t.guilds.setIntent(G1, { desiredState: 'playing', desiredStationId: 'mypack:my-station' });
    t.stations.insertCustomStation({
      id: 'custom:my-custom',
      guildId: G1,
      slug: 'my-custom',
      displayName: 'My Custom',
      description: null,
      category: null,
      websiteUrl: null,
      language: null,
      createdById: HUMAN,
    });
    vi.spyOn(t.stations, 'deleteGuildCustomStations').mockImplementation(() => {
      throw new Error('disk full');
    });
    expect(() => t.client.emit('guildDelete', { id: G1, available: true })).toThrow('disk full');
    // The settings purge ran first, and was rolled back with the rest.
    expect(t.guilds.listGuildIdsWithSettings()).toContain(G1);
    expect(t.guilds.getIntent(G1)?.desiredStationId).toBe('mypack:my-station');
    expect(t.stations.countCustomStations(G1)).toBe(1);
  });

  it('keeps the server data through an outage', async () => {
    const t = setup();
    t.guilds.updateSettings(G1, { resumeOnRestart: true });
    await t.manager.play(G1, 'mypack:my-station', VOICE_A, HUMAN);
    t.client.emit('guildDelete', { id: G1, available: false });
    expect(t.manager.get(G1)).toBeNull();
    expect(fakes.pipelines[0]!.stopped).toBe(true);
    expect(t.guilds.getIntent(G1)).toMatchObject({
      desiredState: 'playing',
      desiredStationId: 'mypack:my-station',
    });
    expect(t.guilds.getSettings(G1).resumeOnRestart).toBe(true);
    // A server the bot never played in is simply purged.
    t.client.emit('guildDelete', { id: G2, available: true });
    expect(t.manager.get(G2)).toBeNull();
  });
});

describe('SessionManager.restoreOnBoot', () => {
  it('resumes where the server opted in', async () => {
    const t = setup();
    t.guilds.updateSettings(G1, { resumeOnRestart: true });
    t.guilds.setIntent(G1, {
      desiredState: 'playing',
      desiredStationId: 'mypack:my-station',
      desiredVoiceChannelId: VOICE_A,
    });
    await t.manager.restoreOnBoot();
    expect(t.manager.get(G1)?.state).toBe('PLAYING');
    expect(t.links.map((l) => l.channel.id)).toEqual([VOICE_A]);
  });

  it('stays idle and records why when playback was wanted but resume is off', async () => {
    const t = setup();
    t.guilds.setIntent(G1, {
      desiredState: 'paused_empty',
      desiredStationId: 'mypack:my-station',
      desiredVoiceChannelId: VOICE_A,
    });
    await t.manager.restoreOnBoot();
    expect(t.manager.get(G1)).toBeNull();
    expect(t.guilds.getIntent(G1)).toMatchObject({ desiredState: 'idle', lastErrorCode: 'RESUME_DISABLED' });
  });

  it('autostarts the default station, but never after an explicit stop', async () => {
    const t = setup();
    for (const g of [G1, G2]) {
      t.guilds.updateSettings(g, {
        autostart: true,
        defaultStationId: 'mypack:my-station',
        preferredVoiceChannelId: g === G1 ? VOICE_A : VOICE_A.replace('4', '7'),
      });
    }
    t.guilds.setIntent(G2, { desiredState: 'stopped' });
    await t.manager.restoreOnBoot();
    expect(t.manager.get(G1)?.state).toBe('PLAYING');
    expect(t.manager.get(G2)).toBeNull();
    expect(t.guilds.getIntent(G2)?.desiredState).toBe('stopped');
  });

  it('skips servers the bot is no longer in and stations that are gone', async () => {
    const t = setup();
    t.guilds.updateSettings('923456789012345678', {
      autostart: true,
      defaultStationId: 'mypack:my-station',
      preferredVoiceChannelId: VOICE_A,
    });
    t.guilds.updateSettings(G1, {
      autostart: true,
      defaultStationId: 'mypack:no-such-station',
      preferredVoiceChannelId: VOICE_A,
    });
    await t.manager.restoreOnBoot();
    expect(t.manager.all()).toEqual([]);
    expect(t.links).toEqual([]);
  });

  it('records why a restore could not join', async () => {
    const t = setup();
    t.guilds.updateSettings(G1, { resumeOnRestart: true });
    t.guilds.setIntent(G1, {
      desiredState: 'playing',
      desiredStationId: 'mypack:my-station',
      desiredVoiceChannelId: '923456789012345678', // deleted while the bot was down
    });
    await t.manager.restoreOnBoot();
    expect(t.guilds.getIntent(G1)).toMatchObject({
      desiredState: 'playing',
      lastErrorCode: 'VOICE_CHANNEL_GONE',
    });
    expect(t.links).toEqual([]);
  });

  it('records a failed autostart as idle', async () => {
    const t = setup();
    t.guilds.updateSettings(G1, {
      autostart: true,
      defaultStationId: 'mypack:my-station',
      preferredVoiceChannelId: '923456789012345678',
    });
    await t.manager.restoreOnBoot();
    expect(t.guilds.getIntent(G1)).toMatchObject({
      desiredState: 'idle',
      lastErrorCode: 'VOICE_CHANNEL_GONE',
    });
  });

  it('joins but plays nothing when no source of the station is usable', async () => {
    const t = setup({ sources: [{ id: 'my-src', patch: verified({ verificationState: 'offline' }) }] });
    t.guilds.updateSettings(G1, { resumeOnRestart: true });
    t.guilds.setIntent(G1, {
      desiredState: 'playing',
      desiredStationId: 'mypack:my-station',
      desiredVoiceChannelId: VOICE_A,
    });
    await t.manager.restoreOnBoot();
    expect(t.manager.get(G1)?.status().lastError?.code).toBe('NO_ELIGIBLE_SOURCE');
    expect(fakes.pipelines).toEqual([]);
  });

  it('does not resume a station whose pack is disabled, or a retired one', async () => {
    for (const status of ['active', 'retired'] as const) {
      const t = setup({ catalogueStatus: status });
      t.guilds.updateSettings(G1, { resumeOnRestart: true });
      t.guilds.setIntent(G1, {
        desiredState: 'playing',
        desiredStationId: 'mypack:my-station',
        desiredVoiceChannelId: VOICE_A,
      });
      const asked: string[] = [];
      t.manager.setStationFilter((guildId, station) => {
        asked.push(`${guildId}/${station.id}`);
        return false;
      });
      await t.manager.restoreOnBoot();
      expect(asked).toEqual(status === 'active' ? [`${G1}/mypack:my-station`] : []);
      expect(t.guilds.getIntent(G1)?.lastErrorCode).toBeNull();
      expect(t.manager.get(G1)).toBeNull();
    }
  });
});

describe('SessionManager.shutdown', () => {
  it('releases every session and child process but keeps what each server wanted', async () => {
    const t = setup();
    await t.manager.play(G1, 'mypack:my-station', VOICE_A, HUMAN);
    t.manager.shutdown();
    expect(t.manager.all()).toEqual([]);
    expect(t.links[0]!.link.destroyed).toBe(true);
    expect(fakes.pipelines[0]!.stopped).toBe(true);
    expect(t.killAll).toHaveBeenCalled();
    expect(t.guilds.getIntent(G1)?.desiredState).toBe('playing');
    // Leaving after shutdown does not reach the leave hook: the session is gone.
    expect(t.left).toEqual([]);
  });
});

describe('bootDecision', () => {
  const intent = (o: Partial<PlaybackIntent>): PlaybackIntent =>
    ({
      guildId: G1,
      desiredState: 'playing',
      desiredStationId: 'mypack:my-station',
      desiredVoiceChannelId: VOICE_A,
      ...o,
    }) as PlaybackIntent;
  const settings = {
    resumeOnRestart: false,
    autostart: false,
    defaultStationId: null as string | null,
    preferredVoiceChannelId: null as string | null,
  };
  const auto = {
    ...settings,
    autostart: true,
    defaultStationId: 'mypack:other-station',
    preferredVoiceChannelId: VOICE_B,
  };

  it('resumes only with the opt-in and a complete intent', () => {
    expect(bootDecision(intent({}), { ...settings, resumeOnRestart: true })).toEqual({
      stationId: 'mypack:my-station',
      channelId: VOICE_A,
      why: 'resume',
    });
    expect(
      bootDecision(intent({ desiredState: 'paused_empty' }), { ...settings, resumeOnRestart: true })?.why,
    ).toBe('resume');
    expect(bootDecision(intent({}), settings)).toBeNull();
    expect(
      bootDecision(intent({ desiredVoiceChannelId: null }), { ...settings, resumeOnRestart: true }),
    ).toBeNull();
    expect(
      bootDecision(intent({ desiredStationId: null }), { ...settings, resumeOnRestart: true }),
    ).toBeNull();
  });

  it('autostarts the default unless an explicit stop, leave or kick is on record', () => {
    expect(bootDecision(null, auto)).toEqual({
      stationId: 'mypack:other-station',
      channelId: VOICE_B,
      why: 'autostart',
    });
    expect(bootDecision(intent({ desiredState: 'idle' }), auto)?.why).toBe('autostart');
    for (const desiredState of ['stopped', 'left', 'kicked'] as const) {
      expect(bootDecision(intent({ desiredState }), auto)).toBeNull();
    }
    expect(bootDecision(null, { ...auto, preferredVoiceChannelId: null })).toBeNull();
    expect(bootDecision(null, { ...auto, defaultStationId: null })).toBeNull();
    // Resume wins over autostart when both apply.
    expect(bootDecision(intent({}), { ...auto, resumeOnRestart: true })?.why).toBe('resume');
  });
});
