import type { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ActivityType, ChannelType, Events, PermissionFlagsBits } from 'discord.js';
import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AppConfig, loadConfig } from '../../src/config/env.ts';
import type { HealthSnapshot } from '../../src/observability/health.ts';
import type { Logger } from '../../src/observability/logger.ts';
import type { SessionStatus } from '../../src/voice/session.ts';

/**
 * createApp wires real repositories, packs, sessions and timers around a fake Discord client:
 * nothing here logs in to Discord, opens a voice connection or runs FFmpeg.
 */
const fake = vi.hoisted(() => ({
  clients: [] as Array<EventEmitter & Record<string, unknown>>,
  ffmpeg: null as null | (() => Promise<unknown>),
  register: [] as unknown[][],
  schedules: [] as Array<{ options: Record<string, unknown>; stop: () => void; stopped: boolean }>,
  diagnostics: [] as Array<{ port: number; snapshot: () => Record<string, unknown>; closed: boolean }>,
}));

vi.mock('discord.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('discord.js')>();
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeClient extends Emitter {
    readonly options: unknown;
    ready = false;
    logins: string[] = [];
    destroyed = 0;
    presences: unknown[] = [];
    puts: Array<{ route: string; body: unknown }> = [];
    user = {
      id: '100000000000000001',
      tag: 'radio#0001',
      setPresence: (p: unknown) => this.presences.push(p),
    };
    guilds = { cache: new Map<string, unknown>(), fetch: async () => null };
    channels = { cache: new Map<string, unknown>() };
    application = { fetch: async () => ({}) };
    rest = {
      put: async (route: string, o: { body: unknown }) => {
        this.puts.push({ route, body: o.body });
      },
    };
    constructor(options: unknown) {
      super();
      this.options = options;
      fake.clients.push(this as never);
    }
    isReady() {
      return this.ready;
    }
    async login(token: string) {
      this.logins.push(token);
      return token;
    }
    async destroy() {
      this.destroyed++;
      this.ready = false;
    }
  }
  return { ...actual, Client: FakeClient };
});

vi.mock('../../src/audio/ffmpeg.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/audio/ffmpeg.ts')>();
  return { ...actual, checkFfmpeg: () => fake.ffmpeg!() };
});

vi.mock('../../src/discord/register.ts', () => ({
  registerGuildCommands: async (...args: unknown[]) => {
    fake.register.push(args);
  },
}));

vi.mock('../../src/catalogue/sync-schedule.ts', () => ({
  scheduleCatalogueSyncs: (options: Record<string, unknown>) => {
    const entry = {
      options,
      stopped: false,
      stop() {
        entry.stopped = true;
      },
    };
    fake.schedules.push(entry);
    return entry;
  },
}));

vi.mock('../../src/observability/health.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/observability/health.ts')>();
  return {
    ...actual,
    startDiagnosticsServer: (port: number, _logger: unknown, snapshot: () => Record<string, unknown>) => {
      const entry = {
        port,
        snapshot,
        closed: false,
        close() {
          entry.closed = true;
        },
      };
      fake.diagnostics.push(entry);
      return entry;
    },
  };
});

const { createApp } = await import('../../src/app.ts');
const { RadioController } = await import('../../src/discord/controller.ts');
const { EventLoopMonitor } = await import('../../src/observability/event-loop.ts');

type FakeClient = EventEmitter & {
  ready: boolean;
  logins: string[];
  destroyed: number;
  presences: Array<{ activities: Array<{ name: string; type: ActivityType }> }>;
  puts: Array<{ route: string; body: unknown }>;
  guilds: { cache: Map<string, unknown> };
  channels: { cache: Map<string, unknown> };
};

const LIBOPUS = {
  ffmpegVersion: 'ffmpeg version 7.1',
  ffprobeVersion: 'ffprobe version 7.1',
  libopus: true,
  libavformat: 'Lavf/61.7.100',
};

let dir: string;
let apps: Array<{ stop(reason: string): Promise<void> }> = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'radio-bot-app-'));
  fake.clients.length = 0;
  fake.register.length = 0;
  fake.schedules.length = 0;
  fake.diagnostics.length = 0;
  fake.ffmpeg = async () => LIBOPUS;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});

afterEach(async () => {
  for (const app of apps.splice(0)) await app.stop('test over').catch(() => {});
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function config(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({
      DISCORD_TOKEN: 'replace-with-your-bot-token',
      DISCORD_APPLICATION_ID: '123456789012345678',
      DATABASE_PATH: join(dir, 'radio-bot.sqlite'),
      LOG_LEVEL: 'silent',
    }),
    ...overrides,
  };
}

function quietLogger(): Logger {
  return pino({ level: 'silent' });
}

function build(overrides: Partial<AppConfig> = {}, logger = quietLogger()) {
  const app = createApp(config(overrides), logger);
  apps.push(app);
  const client = fake.clients.at(-1) as unknown as FakeClient;
  const heartbeat = () => JSON.parse(readFileSync(join(dir, 'health.json'), 'utf8')) as HealthSnapshot;
  return { app, ctx: app.ctx, client, heartbeat, logger };
}

/** A guild the fake client knows, with one voice channel where the bot may set the status. */
function addGuild(client: FakeClient, guildId: string, channelId: string) {
  const me = { id: '100000000000000001' };
  const channel = {
    id: channelId,
    type: ChannelType.GuildVoice,
    permissionsFor: (member: unknown) =>
      member === me ? { has: (p: bigint) => p === PermissionFlagsBits.SetVoiceChannelStatus } : null,
  };
  client.guilds.cache.set(guildId, {
    id: guildId,
    members: { me },
    channels: { cache: new Map([[channelId, channel]]) },
  });
}

function playingStatus(guildId: string, channelId: string, stationId: string): SessionStatus {
  return {
    guildId,
    state: 'PLAYING',
    desiredState: 'playing',
    stationId,
    channelId,
    source: null,
    selection: null,
    plan: null,
    startedAt: Date.now(),
    nowPlaying: { title: 'Some Artist - Some Song' } as SessionStatus['nowPlaying'],
    lastError: null,
    failovers: 1,
    reconnects: 0,
    inputBytes: 0,
    outputBytes: 0,
    observedOutputKbps: null,
    observedInputKbps: null,
    encryption: null,
    inputTransport: null,
    inputHost: null,
    hls: null,
    encoderPid: null,
    ffmpegWarnings: [],
    manualSourceId: null,
  };
}

function addStation(ctx: ReturnType<typeof build>['ctx'], id = 'mypack:my-station') {
  ctx.stations.upsertProviderStation({
    id,
    provider: 'mypack',
    slug: id.split(':')[1]!,
    externalId: null,
    displayName: 'My Station',
    aliases: [],
    tags: [],
    category: null,
    sortOrder: 1,
    officialPageUrl: null,
    officialLastSeenAt: null,
    catalogueStatus: 'active',
    description: null,
  });
}

/** Lets pending promise callbacks run (the ready handler awaits several steps). */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    // The panel loop yields with setImmediate, which stays real here.
    await new Promise((resolve) => setImmediate(resolve));
  }
}

describe('createApp: Discord client', () => {
  it('asks Discord for the least access it needs and logs in with the configured token', async () => {
    const { app, client } = build();
    const options = (client as unknown as { options: { intents: unknown[]; allowedMentions: unknown } })
      .options;
    expect(options.intents).toEqual([1, 128]); // Guilds, GuildVoiceStates
    expect(options.allowedMentions).toEqual({ parse: [] });
    await app.start();
    expect(client.logins).toEqual(['replace-with-your-bot-token']);
  });

  it('turns every interaction over to the controller and records gateway disconnects', async () => {
    const handle = vi.spyOn(RadioController.prototype, 'handle').mockResolvedValue();
    const { app, ctx, client } = build();
    await app.start();
    const interaction = { id: 'i1' };
    client.emit(Events.InteractionCreate, interaction);
    expect(handle).toHaveBeenCalledWith(interaction);
    expect(() => client.emit(Events.Error, new Error('gateway hiccup'))).not.toThrow();
    client.emit(Events.ShardDisconnect, { code: 1006 }, 0);
    expect(ctx.metrics.recentIncidents(null, 5).map((i) => [i.code, i.domain])).toContainEqual([
      'VOICE_DISCONNECTED',
      'discord',
    ]);
  });

  it('registers commands again for a server that re-invites the bot, but only the dev server when set', async () => {
    const a = build();
    await a.app.start();
    a.client.emit(Events.GuildCreate, { id: '223456789012345678' });
    expect(fake.register.at(-1)).toEqual([
      'replace-with-your-bot-token',
      '123456789012345678',
      ['223456789012345678'],
      a.ctx.meta,
      expect.anything(),
      true,
    ]);
    fake.register.length = 0;
    const b = build({ devGuildId: '323456789012345678' });
    await b.app.start();
    b.client.emit(Events.GuildCreate, { id: '223456789012345678' });
    expect(fake.register).toEqual([]);
    b.client.emit(Events.GuildCreate, { id: '323456789012345678' });
    expect(fake.register).toHaveLength(1);
    const c = build({ registerCommandsOnStart: false });
    await c.app.start();
    c.client.emit(Events.GuildCreate, { id: '223456789012345678' });
    expect(fake.register).toHaveLength(1);
  });

  it('sends the bot status again on a new gateway session', async () => {
    const { app, client } = build();
    await app.start();
    client.ready = true;
    client.emit(Events.ShardReady, 0);
    expect(client.presences).toEqual([{ activities: [] }]);
    // An unchanged status is not sent twice, unless the gateway session is new.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(client.presences).toHaveLength(1);
    client.emit(Events.ShardReady, 0);
    expect(client.presences).toHaveLength(2);
  });
});

describe('createApp: ready', () => {
  it('registers commands, writes a heartbeat, restores playback, then refreshes the panels it has', async () => {
    const order: string[] = [];
    const { app, ctx, client, heartbeat } = build();
    const restore = vi.spyOn(ctx.sessions, 'restoreOnBoot').mockImplementation(async () => {
      order.push(`restore (ready=${heartbeat().discordReady})`);
    });
    const refresh = vi.spyOn(RadioController.prototype, 'refreshPanel').mockImplementation(async (g) => {
      order.push(`panel ${g}`);
    });
    ctx.guilds.updateSettings('223456789012345678', { panelChannelId: '1', panelMessageId: '2' });
    // A server that still has a panel row but no longer has the bot is skipped.
    ctx.guilds.updateSettings('323456789012345678', { panelChannelId: '1', panelMessageId: '3' });
    await app.start();
    addGuild(client, '223456789012345678', '423456789012345678');
    addGuild(client, '523456789012345678', '623456789012345678');
    client.ready = true;
    client.emit(Events.ClientReady, {
      user: { tag: 'radio#0001' },
      guilds: client.guilds,
      application: { fetch: async () => ({}) },
    });
    await settle();
    expect(fake.register).toEqual([
      [
        'replace-with-your-bot-token',
        '123456789012345678',
        ['223456789012345678', '523456789012345678'],
        ctx.meta,
        expect.anything(),
      ],
    ]);
    expect(restore).toHaveBeenCalledOnce();
    expect(order).toEqual(['restore (ready=true)', 'panel 223456789012345678']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('registers commands only in the dev server when one is set, and survives a failed restore', async () => {
    const { app, ctx, client } = build({ devGuildId: '323456789012345678' });
    vi.spyOn(ctx.sessions, 'restoreOnBoot').mockRejectedValue(new Error('database is locked'));
    const refresh = vi.spyOn(RadioController.prototype, 'refreshPanel').mockResolvedValue();
    ctx.guilds.updateSettings('223456789012345678', { panelChannelId: '1', panelMessageId: '2' });
    await app.start();
    addGuild(client, '223456789012345678', '423456789012345678');
    client.ready = true;
    client.emit(Events.ClientReady, {
      user: { tag: 'radio#0001' },
      guilds: client.guilds,
      application: { fetch: async () => Promise.reject(new Error('rate limited')) },
    });
    await settle();
    expect(fake.register.map((r) => r[2])).toEqual([['323456789012345678']]);
    // The failed restore is logged; the panels are still brought up to date.
    expect(refresh).toHaveBeenCalledWith('223456789012345678');
  });

  it('stops refreshing panels once shutdown has begun', async () => {
    const { app, ctx, client } = build({ registerCommandsOnStart: false });
    vi.spyOn(ctx.sessions, 'restoreOnBoot').mockResolvedValue();
    let stopping: Promise<void> | null = null;
    const refreshed: string[] = [];
    vi.spyOn(RadioController.prototype, 'refreshPanel').mockImplementation(async (g) => {
      refreshed.push(g);
      stopping ??= app.stop('SIGTERM');
    });
    for (const [g, ch] of [
      ['223456789012345678', '423456789012345678'],
      ['323456789012345678', '523456789012345678'],
    ] as const) {
      ctx.guilds.updateSettings(g, { panelChannelId: '1', panelMessageId: ch });
      addGuild(client, g, ch);
    }
    await app.start();
    client.emit(Events.ClientReady, {
      user: { tag: 'radio#0001' },
      guilds: client.guilds,
      application: { fetch: async () => ({}) },
    });
    await settle();
    await stopping;
    expect(fake.register).toEqual([]);
    expect(refreshed).toHaveLength(1);
    apps = apps.filter((a) => a !== app);
  });
});

describe('createApp: health heartbeat', () => {
  it('writes the fields the health check reads, replacing any heartbeat from a previous run', async () => {
    const { app, ctx, client, heartbeat } = build();
    await app.start();
    // Written first thing at start, before FFmpeg has been checked.
    let hb = heartbeat();
    expect(hb).toMatchObject({ pid: process.pid, discordReady: false, activeStreams: 0, dbOk: true });
    expect(hb.ffmpegProcesses).toBe(0);
    expect(Date.parse(hb.at)).toBeGreaterThan(Date.now() - 60_000);
    expect(ctx.ffmpegInfo).toEqual(LIBOPUS);

    client.ready = true;
    vi.spyOn(ctx.sessions, 'activeStreams').mockReturnValue(2);
    await vi.advanceTimersByTimeAsync(30_000);
    hb = heartbeat();
    expect(hb).toMatchObject({ discordReady: true, activeStreams: 2, ffmpegOk: true, dbOk: true });
  });

  it('reports a failing database and an FFmpeg without libopus', async () => {
    fake.ffmpeg = async () => ({ ...LIBOPUS, libopus: false });
    const { app, ctx, heartbeat } = build();
    await app.start();
    expect(ctx.ffmpegInfo?.libopus).toBe(false);
    vi.spyOn(ctx.db, 'get').mockImplementation(() => {
      throw new Error('disk I/O error');
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeat()).toMatchObject({ dbOk: false, ffmpegOk: false });
  });

  it('reports FFmpeg as missing when the check fails, and keeps running', async () => {
    fake.ffmpeg = async () => {
      throw new Error('spawn ffmpeg ENOENT');
    };
    const { app, ctx, client, heartbeat } = build();
    await app.start();
    expect(ctx.ffmpegInfo).toBeNull();
    expect(client.logins).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(heartbeat().ffmpegOk).toBe(false);
  });

  it('logs, rather than throws, when the heartbeat cannot be written', async () => {
    const logger = quietLogger();
    const warn = vi.spyOn(logger, 'warn');
    // The heartbeat goes next to the database; a file in the way of its folder makes it fail.
    const { app } = build({}, logger);
    await app.start();
    mkdirSync(join(dir, 'health.json.tmp'));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'could not write heartbeat');
  });
});

describe('createApp: stream User-Agent', () => {
  it('identifies as the installed FFmpeg unless an override is configured', async () => {
    const a = build();
    await a.app.start();
    expect(a.ctx.http.userAgent).toBe('Lavf/61.7.100');
    const b = build({ streamUserAgent: 'Lavf/60.16.100' });
    await b.app.start();
    expect(b.ctx.http.userAgent).toBe('Lavf/60.16.100');
  });
});

describe('createApp: timers', () => {
  it('prunes probe history hourly: every source the first time, then only old results', async () => {
    const logger = quietLogger();
    const warn = vi.spyOn(logger, 'warn');
    const { app, ctx } = build({ probeHistoryLimit: 7, probeHistoryDays: 9 }, logger);
    const prune = vi.spyOn(ctx.stations, 'pruneProbeResults');
    const sweep = vi.spyOn(ctx.limits, 'sweep');
    await app.start();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(prune.mock.calls).toEqual([
      [7, 9, true],
      [7, 9, false],
    ]);
    expect(sweep).toHaveBeenCalledTimes(2);
    prune.mockImplementation(() => {
      throw new Error('database is locked');
    });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'probe history pruning failed');
  });

  it('warns each minute in which the event loop ran late enough to delay voice packets', async () => {
    const logger = quietLogger();
    const warn = vi.spyOn(logger, 'warn');
    const { app, ctx } = build({}, logger);
    let maxNs = 80e6;
    ctx.eventLoop = new EventLoopMonitor(() => ({
      count: 100,
      mean: 12e6,
      get max() {
        return maxNs;
      },
      percentile: () => 15e6,
      reset() {},
      enable: () => true,
      disable: () => true,
    }));
    await app.start();
    await vi.advanceTimersByTimeAsync(60_000);
    const delayed = () =>
      warn.mock.calls.filter((c) => c[1] === 'event loop was delayed; voice packets may have been late');
    expect(delayed()).toHaveLength(1);
    expect(delayed()[0]![0]).toMatchObject({ eventLoopDelay: { maxMs: 70 } });
    // A quiet minute is not a warning.
    maxNs = 30e6;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(delayed()).toHaveLength(1);
  });

  it('refreshes the panel of every session every 5 minutes, one at a time', async () => {
    const { app, ctx } = build();
    ctx.sessions.ensure('223456789012345678');
    ctx.sessions.ensure('323456789012345678');
    let running = 0;
    let peak = 0;
    const refreshed: string[] = [];
    vi.spyOn(RadioController.prototype, 'refreshPanel').mockImplementation(async (g) => {
      running++;
      peak = Math.max(peak, running);
      await Promise.resolve();
      refreshed.push(g);
      running--;
    });
    await app.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.waitFor(() => expect(refreshed).toHaveLength(2));
    expect(refreshed).toEqual(['223456789012345678', '323456789012345678']);
    expect(peak).toBe(1);
  });

  it('skips a panel round while the previous one is still running', async () => {
    const { app, ctx } = build();
    ctx.sessions.ensure('223456789012345678');
    let release!: () => void;
    const refresh = vi
      .spyOn(RadioController.prototype, 'refreshPanel')
      .mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    await app.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    release();
    await settle();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    release();
  });

  it("shows each playing server's station as its voice channel status and in the bot status", async () => {
    const { app, ctx, client } = build();
    addStation(ctx);
    addGuild(client, '223456789012345678', '423456789012345678');
    vi.spyOn(ctx.sessions, 'all').mockReturnValue([
      {
        guildId: '223456789012345678',
        status: () => playingStatus('223456789012345678', '423456789012345678', 'mypack:my-station'),
      } as never,
    ]);
    vi.spyOn(RadioController.prototype, 'refreshPanel').mockResolvedValue();
    await app.start();
    client.ready = true;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(client.puts).toEqual([
      {
        route: '/channels/423456789012345678/voice-status',
        body: { status: '📻 My Station · Some Artist - Some Song' },
      },
    ]);
    expect(client.presences.at(-1)).toEqual({
      activities: [{ name: 'My Station · Some Artist - Some Song', type: ActivityType.Listening }],
    });
    // On shutdown the status is cleared while the bot is still connected.
    const destroy = vi.spyOn(client as never as { destroy: () => Promise<void> }, 'destroy');
    await app.stop('SIGTERM');
    expect(client.puts.at(-1)).toEqual({
      route: '/channels/423456789012345678/voice-status',
      body: { status: '' },
    });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('never sets a voice channel status where the bot lacks the permission', async () => {
    const { app, ctx, client } = build();
    addStation(ctx);
    vi.spyOn(ctx.sessions, 'all').mockReturnValue([
      {
        guildId: '223456789012345678',
        status: () => playingStatus('223456789012345678', '423456789012345678', 'mypack:my-station'),
      } as never,
    ]);
    await app.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(client.puts).toEqual([]);
  });
});

describe('createApp: catalogue sync', () => {
  it('schedules every syncable pack at the configured interval, and runs scheduled syncs', async () => {
    const { app, ctx } = build({ catalogSyncIntervalHours: 12 });
    const sync = vi.spyOn(ctx.catalogueSync, 'sync').mockResolvedValue({} as never);
    await app.start();
    expect(fake.schedules).toHaveLength(1);
    const o = fake.schedules[0]!.options as {
      packIds: string[];
      intervalMs: number;
      lastSync: (id: string) => string | null;
      sync: (id: string) => Promise<unknown>;
    };
    expect(o.packIds).toEqual(ctx.catalogueSync.syncablePacks().map((p) => p.meta.id));
    expect(o.intervalMs).toBe(12 * 3_600_000);
    expect(o.lastSync('mypack')).toBeNull();
    await o.sync('mypack');
    expect(sync).toHaveBeenCalledWith('mypack', 'scheduled');
    await app.stop('SIGTERM');
    expect(fake.schedules[0]!.stopped).toBe(true);
  });

  it('schedules nothing when catalogue sync is off', async () => {
    const { app } = build({ catalogSyncEnabled: false });
    await app.start();
    expect(fake.schedules).toEqual([]);
    await app.stop('SIGTERM');
  });
});

describe('createApp: diagnostics endpoint', () => {
  it('is not started unless a port is configured', async () => {
    const { app } = build();
    await app.start();
    expect(fake.diagnostics).toEqual([]);
  });

  it('serves a snapshot of live state on the configured port, and closes on shutdown', async () => {
    const { app, ctx, client } = build({ diagnosticsPort: 9464 });
    addStation(ctx);
    await app.start();
    expect(fake.diagnostics.map((d) => d.port)).toEqual([9464]);
    client.ready = true;
    vi.spyOn(ctx.sessions, 'all').mockReturnValue([
      {
        guildId: '223456789012345678',
        status: () => playingStatus('223456789012345678', '423456789012345678', 'mypack:my-station'),
      } as never,
    ]);
    const snap = fake.diagnostics[0]!.snapshot();
    expect(snap).toMatchObject({
      startedAt: ctx.startedAt.toISOString(),
      discordReady: true,
      activeStreams: 0,
      ffmpeg: { active: 0, spawned: ctx.registry.spawned, reaped: ctx.registry.reaped, byKind: {} },
      sessions: [
        {
          guildId: '223456789012345678',
          state: 'PLAYING',
          desired: 'playing',
          stationId: 'mypack:my-station',
          sourceId: null,
          failovers: 1,
        },
      ],
    });
    expect(snap).toHaveProperty('counters');
    expect(snap).toHaveProperty('eventLoopDelay');
    expect(snap).toHaveProperty('incidents');
    await app.stop('SIGTERM');
    expect(fake.diagnostics[0]!.closed).toBe(true);
  });
});

describe('createApp: shutdown', () => {
  it('stops sync and timers, releases sessions and Discord, then closes the database last', async () => {
    const { app, ctx, client, heartbeat } = build();
    await app.start();
    client.ready = true;
    const order: string[] = [];
    /** Records each call in `order`, then does what the method always does. */
    const spy = (obj: object, name: string, label: string) => {
      const target = obj as Record<string, (...a: unknown[]) => unknown>;
      const original = target[name]!.bind(obj);
      target[name] = (...a: unknown[]) => {
        order.push(label);
        return original(...a);
      };
    };
    spy(fake.schedules[0]!, 'stop', 'sync.stop');
    spy(ctx.eventLoop, 'stop', 'eventLoop.stop');
    spy(ctx.sessions, 'shutdown', 'sessions.shutdown');
    spy(ctx.notifier, 'close', 'notifier.close');
    spy(client as never as { destroy: () => Promise<void> }, 'destroy', 'client.destroy');
    spy(ctx.registry, 'killAll', 'registry.killAll');
    spy(ctx.db, 'close', 'db.close');
    const prune = vi.spyOn(ctx.stations, 'pruneProbeResults');
    const refresh = vi.spyOn(RadioController.prototype, 'refreshPanel').mockResolvedValue();
    ctx.sessions.ensure('223456789012345678');

    await app.stop('SIGTERM');
    expect(order[0]).toBe('sync.stop');
    expect(order.at(-1)).toBe('db.close');
    expect(order.indexOf('sessions.shutdown')).toBeLessThan(order.indexOf('client.destroy'));
    expect(order.indexOf('client.destroy')).toBeLessThan(order.indexOf('db.close'));
    expect(order).toContain('eventLoop.stop');
    expect(order).toContain('notifier.close');
    expect(order.filter((x) => x === 'registry.killAll').length).toBeGreaterThanOrEqual(1);
    // The last heartbeat says the bot is no longer connected.
    expect(heartbeat().discordReady).toBe(false);
    expect(ctx.sessions.all()).toEqual([]);

    // No timer fires after shutdown.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(prune).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    apps = apps.filter((a) => a !== app);
  });

  it('does not wait forever for channel statuses to clear', async () => {
    const { app, ctx, client } = build();
    addStation(ctx);
    addGuild(client, '223456789012345678', '423456789012345678');
    vi.spyOn(ctx.sessions, 'all').mockReturnValue([
      {
        guildId: '223456789012345678',
        status: () => playingStatus('223456789012345678', '423456789012345678', 'mypack:my-station'),
      } as never,
    ]);
    await app.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(client.puts).toHaveLength(1);
    // Discord stops answering: the clear request hangs.
    (client as unknown as { rest: { put: () => Promise<void> } }).rest.put = () => new Promise(() => {});
    let done = false;
    const stopping = app.stop('SIGTERM').then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    await stopping;
    expect(done).toBe(true);
    expect(client.destroyed).toBe(1);
    apps = apps.filter((a) => a !== app);
  });
});
