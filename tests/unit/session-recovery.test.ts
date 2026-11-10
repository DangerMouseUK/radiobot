import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EncoderPlan } from '../../src/audio/encoder.ts';
import type { PipelineStats } from '../../src/audio/pipeline.ts';
import { Metrics } from '../../src/observability/metrics.ts';
import { RadioError } from '../../src/shared/errors.ts';
import type { SourceInput } from '../../src/streams/input.ts';
import { selectSource } from '../../src/streams/ranking.ts';
import type { VoiceLink, VoiceLinkEvents } from '../../src/voice/link.ts';
import { GuildSession, type SessionNotice, type SessionTimings } from '../../src/voice/session.ts';
import { makeSource, memoryDb, silentLogger } from '../helpers.ts';

/** Recovery paths of a GuildSession: voice reconnects, link events, resync and the bot's own faults. */

class FakeLink extends EventEmitter<VoiceLinkEvents> implements VoiceLink {
  ready = true;
  destroyed = false;
  stopped = 0;
  played = 0;
  /** Audio the player has sent, ms; a lagging player reports less than has arrived. */
  sentMs = () => 0;
  packets = () => null as number | null;
  silence = () => null as number | null;
  /** Audio the live queue has dropped mid-stream to stay live, ms. */
  caughtUp = () => 0;
  readonly channelId: string;
  constructor(channelId: string) {
    super();
    this.channelId = channelId;
  }
  play(): void {
    this.played++;
  }
  reportsArmed = false;
  armReports(): void {
    this.reportsArmed = true;
  }
  disarmReports(): void {
    this.reportsArmed = false;
  }
  async receiverReport() {
    return this.reportsArmed ? ({ state: 'waiting' } as const) : ({ state: 'off' } as const);
  }
  stopAudio(): void {
    this.stopped++;
  }
  playbackMs(): number {
    return this.sentMs();
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
      packetsPlayed: this.packets(),
      packetTiming: { late: 0, worstGapMs: null, recent: [] },
      silenceMs: this.silence(),
      encryptionMode: null,
      status: 'ready',
      live: {
        depthMs: 1_000,
        floorMs: null,
        cushionMs: 1_000,
        startDroppedMs: 0,
        caughtUpMs: this.caughtUp(),
        catchUps: 0,
        gaps: 0,
        driftPpm: null,
      },
    };
  }
  detach(): void {}
  destroy(): void {
    this.destroyed = true;
  }
}

class FakePipeline extends EventEmitter {
  readonly output = new PassThrough();
  readonly stats: PipelineStats;
  readonly stderrTail: string[] = [];
  stopped = false;
  readonly input: SourceInput;
  readonly plan: EncoderPlan;
  readonly #ticker: NodeJS.Timeout;
  constructor(input: SourceInput, plan: EncoderPlan, audioAlready: boolean) {
    super();
    this.input = input;
    this.plan = plan;
    const now = Date.now();
    this.stats = {
      startedAt: now,
      firstOutputAt: audioAlready ? now : null,
      lastOutputAt: audioAlready ? now : null,
      outputBytes: 0,
      inputBytes: 0,
      pid: 1,
    };
    if (!audioAlready) {
      setTimeout(() => {
        if (this.stopped) return;
        this.stats.firstOutputAt = Date.now();
        this.stats.lastOutputAt = Date.now();
        this.emit('firstAudio');
      }, 5);
    }
    this.#ticker = setInterval(() => {
      this.stats.lastOutputAt = Date.now();
    }, 5);
  }
  stop(): void {
    this.stopped = true;
    clearInterval(this.#ticker);
  }
}

const FAST: Partial<SessionTimings> = {
  stallMs: 5_000,
  firstAudioTimeoutMs: 1_000,
  lagMs: 60_000,
  stableMs: 60_000,
  noSourceRetryMs: 200,
  stoppedIdleLeaveMs: 60_000,
  emptyLeaveMs: 60_000,
  emptyPauseMs: 60_000,
  watchdogIntervalMs: 20,
  backoff: [5, 5, 5],
  reconnectBackoff: [5, 5],
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(5);
  }
}

const sessions: GuildSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.destroy();
  vi.useRealTimers();
});

interface Options {
  timings?: Partial<SessionTimings>;
  connect?: (channelId: string, n: number) => Promise<void> | void;
  openInput?: (n: number) => Promise<void> | void;
  pipeline?: (n: number) => 'ok' | 'audio-already' | 'throws';
  /** Receives every info-level log line, parsed. */
  logs?: Array<Record<string, unknown>>;
}

function setup(opts: Options = {}) {
  const { guilds } = memoryDb();
  const sources = [
    makeSource({ id: 'primary', stationId: 'mypack:my-station', url: 'https://a.example.com/p' }),
    makeSource({ id: 'second', stationId: 'mypack:other-station', url: 'https://b.example.com/s' }),
  ];
  const links: FakeLink[] = [];
  const pipelines: FakePipeline[] = [];
  const inputs: Array<{ closed: boolean; stats: { skippedSegments: number; liveEdgeSkips: number } }> = [];
  const notices: SessionNotice[] = [];
  const failures: string[] = [];
  const metrics = new Metrics();
  let connects = 0;
  let opens = 0;
  let prepares = 0;
  const session = new GuildSession({
    guildId: 'g1',
    sources: {
      prepareForPlayback: async (_g, stationId, o) => {
        if (o.signal?.aborted) throw new RadioError('CANCELLED', 'superseded');
        prepares++;
        return selectSource(
          sources.filter((s) => s.stationId === stationId),
          null,
          { exclude: o.exclude },
        );
      },
      recordPlaybackSuccess: () => {},
      recordPlaybackFailure: (id, code) => {
        failures.push(`${id}:${code}`);
        return false;
      },
    },
    stations: {
      getStation: (id) => ({ id, displayName: id }) as never,
      getSource: (id) => sources.find((s) => s.id === id) ?? null,
    },
    guilds,
    openInput: async (source, signal) => {
      if (signal.aborted) throw new RadioError('CANCELLED', 'aborted');
      await opts.openInput?.(opens);
      opens++;
      const stats = {
        segmentHost: null,
        segmentsFetched: 0,
        segmentFailures: 0,
        skippedSegments: 0,
        liveEdgeSkips: 0,
      };
      const record = { closed: false, stats };
      inputs.push(record);
      return {
        info: { transport: source.transport, finalHost: 'stream.example.com', hls: null },
        stats,
        close() {
          record.closed = true;
        },
      } as unknown as SourceInput;
    },
    createPipeline: (input, plan) => {
      const kind = opts.pipeline?.(pipelines.length) ?? 'ok';
      if (kind === 'throws') throw new RadioError('FFMPEG_SPAWN', 'FFmpeg could not be started.');
      const p = new FakePipeline(input, plan, kind === 'audio-already');
      pipelines.push(p);
      return p as never;
    },
    connect: async (channelId) => {
      const n = connects++;
      await opts.connect?.(channelId, n);
      const l = new FakeLink(channelId);
      links.push(l);
      return l;
    },
    channelBitrate: () => 96_000,
    notify: (n) => notices.push(n),
    logger: opts.logs
      ? pino({ level: 'info' }, { write: (line: string) => opts.logs!.push(JSON.parse(line)) })
      : silentLogger(),
    metrics,
    timings: { ...FAST, ...opts.timings },
    random: () => 0.5,
  });
  sessions.push(session);
  return {
    session,
    guilds,
    links,
    pipelines,
    inputs,
    notices,
    failures,
    metrics,
    connects: () => connects,
    prepares: () => prepares,
  };
}

describe('GuildSession: connection state', () => {
  it('reports whether it holds a voice connection and which source a listener chose', async () => {
    const t = setup();
    expect(t.session.connected).toBe(false);
    expect(t.session.manualSourceId).toBeNull();
    expect((await t.session.play('mypack:my-station', 'voice-1', 'u1')).ok).toBe(true);
    expect(t.session.connected).toBe(true);
    expect((await t.session.useSource('mypack:my-station', 'primary')).ok).toBe(true);
    expect(t.session.manualSourceId).toBe('primary');
    t.session.leave();
    expect(t.session.connected).toBe(false);
  });

  it('counts a voice reconnect', async () => {
    const t = setup();
    await t.session.play('mypack:my-station', 'voice-1', 'u1');
    t.links[0]!.emit('reconnected');
    t.links[0]!.emit('reconnected');
    expect(t.session.status().reconnects).toBe(2);
    expect(t.metrics.get('voice.reconnected')).toBe(2);
    // Connection errors are logged and recovered from by the link itself.
    t.links[0]!.emit('connectionError', new Error('udp socket closed'));
    expect(t.session.state).toBe('PLAYING');
  });

  it('logs a voice interruption and its recovery at info level, and counts it', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const t = setup({ logs });
    await t.session.play('mypack:my-station', 'voice-1', 'u1');
    t.links[0]!.emit('interrupted', { status: 'connecting', resuming: true, closeCode: 1006 });
    t.links[0]!.emit('restored', { afterMs: 120, skippedMs: 100, caughtUpMs: 240 });
    t.links[0]!.emit('interrupted', { status: 'signalling', resuming: false, closeCode: 4006 });
    const voice = logs.filter((l) => String(l.msg).startsWith('voice connection'));
    expect(voice).toMatchObject([
      { level: 30, msg: 'voice connection resuming', closeCode: 1006, guildId: 'g1' },
      { level: 30, msg: 'voice connection ready again', afterMs: 120, skippedMs: 100, caughtUpMs: 240 },
      { level: 30, msg: 'voice connection interrupted; reconnecting', closeCode: 4006, resuming: false },
    ]);
    // A resume drops audio now; nothing is held.
    for (const line of voice) expect(Object.keys(line)).not.toContain('held');
    expect(Object.keys(voice[1]!)).not.toContain('heldMs');
    expect(t.metrics.get('voice.interrupted')).toBe(2);
    // Brief interruptions are the link's to ride out: playback carries on.
    expect(t.session.state).toBe('PLAYING');
  });

  it('warns once per step when the link recovers a voice connection that stays stuck', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const t = setup({ logs });
    await t.session.play('mypack:my-station', 'voice-1', 'u1');
    t.links[0]!.emit('interrupted', { status: 'connecting', resuming: true, closeCode: 1006 });
    t.links[0]!.emit('recovering', { step: 'rejoin', status: 'signalling', afterMs: 30_000 });
    t.links[0]!.emit('recovering', { step: 'fresh', status: 'signalling', afterMs: 45_000 });
    const stuck = logs.filter((l) => String(l.msg).includes('stuck'));
    expect(stuck).toMatchObject([
      { level: 40, msg: 'voice connection stuck; rejoining', status: 'signalling', afterMs: 30_000 },
      { level: 40, msg: 'voice connection still stuck; joining again from scratch', afterMs: 45_000 },
    ]);
    expect(t.metrics.get('voice.stuck')).toBe(2);
  });

  it('logs each catch-up with live at info level, and counts it', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const t = setup({ logs });
    await t.session.play('mypack:my-station', 'voice-1', 'u1');
    t.links[0]!.emit('caughtUp', { reason: 'start', droppedMs: 3_200, cushionMs: 1_000 });
    t.links[0]!.emit('caughtUp', { reason: 'settle', droppedMs: 300, cushionMs: 1_000 });
    t.links[0]!.emit('caughtUp', { reason: 'gap', droppedMs: 4_500, cushionMs: 1_500 });
    t.links[0]!.emit('caughtUp', { reason: 'resume', droppedMs: 400, cushionMs: 1_500 });
    const caught = logs.filter((l) => l.reason !== undefined && typeof l.droppedMs === 'number');
    expect(caught).toEqual([
      expect.objectContaining({
        level: 30,
        msg: 'started behind live by the cushion; dropped the connect burst',
        reason: 'start',
        droppedMs: 3_200,
        cushionMs: 1_000,
        guildId: 'g1',
      }),
      expect.objectContaining({ level: 30, msg: 'caught up with live', reason: 'settle', droppedMs: 300 }),
      expect.objectContaining({ level: 30, msg: 'caught up with live', reason: 'gap', droppedMs: 4_500 }),
      // A resume's catch-up is logged once, in 'voice connection ready again' (its caughtUpMs).
    ]);
    expect(t.metrics.get('playback.caught_up')).toBe(4);
    expect(t.session.state).toBe('PLAYING');
  });

  it('logs a listener’s Stop and Leave, and why the bot left by itself', async () => {
    const logs: Array<Record<string, unknown>> = [];
    const t = setup({ logs });
    await t.session.play('mypack:my-station', 'voice-1', 'u1');
    t.session.stop();
    t.session.leave();
    t.session.leave('idle', 'channel_deleted');
    expect(logs.filter((l) => l.msg === 'stopping playback')).toMatchObject([
      { reason: 'command', state: 'PLAYING', stationId: 'mypack:my-station' },
    ]);
    expect(logs.filter((l) => l.msg === 'leaving the voice channel')).toMatchObject([
      { reason: 'command', desired: 'left', state: 'CONNECTED', channelId: 'voice-1' },
      { reason: 'channel_deleted', desired: 'idle', state: 'IDLE' },
    ]);
  });

  it('releases a connection that arrives after the session was destroyed', async () => {
    let arrive!: () => void;
    const t = setup({ connect: () => new Promise<void>((resolve) => (arrive = resolve)) });
    const playing = t.session.play('mypack:my-station', 'voice-1', 'u1');
    await until(() => t.connects() === 1);
    t.session.destroy();
    arrive();
    expect((await playing).code).toBe('CANCELLED');
    expect(t.links[0]!.destroyed).toBe(true);
    expect(t.session.connected).toBe(false);
    expect(t.session.state).toBe('IDLE');
    expect(t.pipelines).toEqual([]);
  });

  it('closes the stream it opened when a newer request replaced it meanwhile', async () => {
    let open!: () => void;
    const t = setup({
      openInput: (n) => (n === 0 ? new Promise<void>((resolve) => (open = resolve)) : undefined),
    });
    const first = t.session.play('mypack:my-station', 'voice-1', 'u1');
    await until(() => open !== undefined);
    const second = t.session.play('mypack:other-station', 'voice-1', 'u1');
    open();
    expect((await first).code).toBe('CANCELLED');
    expect((await second).ok).toBe(true);
    expect(t.inputs[0]!.closed).toBe(true);
    expect(t.pipelines).toHaveLength(1);
    expect(t.session.stationId).toBe('mypack:other-station');
  });

  it('plays at once when the encoder already has audio', async () => {
    const t = setup({ pipeline: () => 'audio-already' });
    const r = await t.session.play('mypack:my-station', 'voice-1', 'u1');
    expect(r.ok).toBe(true);
    expect(t.session.state).toBe('PLAYING');
  });
});

describe('GuildSession: audio ending in the player', () => {
  it('restarts the same source when the player runs out of audio', async () => {
    const t = setup();
    await t.session.play('mypack:my-station', 'voice-1', 'u1');
    t.links[0]!.emit('audioEnded', null);
    await until(() => t.pipelines.length === 2 && t.session.state === 'PLAYING');
    expect(t.failures).toEqual(['primary:STREAM_EOF']);
    expect(t.pipelines[0]!.stopped).toBe(true);
  });

  it('treats a player error as an encoder fault', async () => {
    const t = setup();
    await t.session.play('mypack:my-station', 'voice-1', 'u1');
    t.links[0]!.emit('audioEnded', new Error('resource error'));
    await until(() => t.pipelines.length === 2 && t.session.state === 'PLAYING');
    expect(t.failures).toEqual(['primary:FFMPEG_EXIT']);
  });
});

describe('GuildSession: voice connection failures', () => {
  it('retries a voice connect that timed out, says so once, then keeps trying slowly', async () => {
    const t = setup({
      connect: () => {
        throw new RadioError('VOICE_CONNECT_TIMEOUT', 'Could not connect to the voice channel in time.');
      },
    });
    const r = await t.session.play('mypack:my-station', 'voice-1', 'u1');
    expect(r).toMatchObject({ ok: false, code: 'VOICE_CONNECT_TIMEOUT' });
    expect(t.guilds.getIntent('g1')).toMatchObject({
      desiredState: 'playing',
      lastErrorCode: 'VOICE_CONNECT_TIMEOUT',
    });
    expect(t.notices).toEqual([]);
    // Two retries (reconnectBackoff has two steps), then an error the server sees.
    await until(() => t.session.state === 'ERROR');
    expect(t.connects()).toBe(3);
    expect(t.notices).toHaveLength(1);
    expect(t.notices[0]).toMatchObject({ kind: 'error', code: 'VOICE_CONNECT_TIMEOUT' });
    expect(t.notices[0]!.message).toMatch(
      /I’ll keep trying every couple of minutes\. \/radio stop cancels it\.$/,
    );
    // Every noSourceRetryMs (here 200 ms) it tries again, without another notice.
    await until(() => t.connects() >= 5);
    expect(t.session.state).toBe('ERROR');
    expect(t.notices).toHaveLength(1);
    await t.session.stop();
    const after = t.connects();
    await wait(300);
    expect(t.connects()).toBe(after);
  });

  it('does not retry a voice failure that a retry cannot fix', async () => {
    const t = setup({
      connect: () => {
        throw new RadioError('VOICE_PERMISSION', 'I need Connect in that channel.');
      },
    });
    const r = await t.session.play('mypack:my-station', 'voice-1', 'u1');
    expect(r).toMatchObject({
      ok: false,
      code: 'VOICE_PERMISSION',
      message: 'I need Connect in that channel.',
    });
    expect(t.session.state).toBe('ERROR');
    expect(t.notices.map((n) => n.code)).toEqual(['VOICE_PERMISSION']);
    await wait(50);
    expect(t.connects()).toBe(1);
  });

  it('stays idle when the connection is lost after a stop', async () => {
    const t = setup();
    await t.session.play('mypack:my-station', 'voice-1', 'u1');
    t.session.stop();
    expect(t.session.state).toBe('CONNECTED');
    t.links[0]!.emit('lost', 'destroyed');
    expect(t.session.state).toBe('IDLE');
    await wait(50);
    expect(t.connects()).toBe(1);
    expect(t.notices).toEqual([]);
    expect(t.metrics.recentIncidents('g1')).toEqual([]);
  });

  it('does not reconnect to play nothing when a joined-only connection is lost', async () => {
    const t = setup();
    // Playback was wanted before (say, before a restart), but this session only joined.
    t.guilds.setIntent('g1', { desiredState: 'playing' });
    await t.session.join('voice-1');
    expect(t.session.state).toBe('CONNECTED');
    t.links[0]!.emit('lost', 'reconnect_failed');
    await wait(50);
    expect(t.connects()).toBe(1);
    expect(t.prepares()).toBe(0);
    expect(t.session.state).toBe('IDLE');
  });
});

describe('GuildSession: the bot’s own faults', () => {
  it('retries an encoder that will not start, without blaming the source, then waits', async () => {
    let throwing = true;
    const t = setup({ pipeline: () => (throwing ? 'throws' : 'ok') });
    const r = await t.session.play('mypack:my-station', 'voice-1', 'u1');
    expect(r).toMatchObject({ ok: false, code: 'FFMPEG_SPAWN', retrying: true });
    await until(() => t.session.state === 'ERROR');
    // The first try and three retries of the same source, none of them held against it.
    expect(t.inputs).toHaveLength(4);
    expect(t.inputs.every((i) => i.closed)).toBe(true);
    expect(t.failures).toEqual([]);
    expect(t.notices).toEqual([
      {
        guildId: 'g1',
        kind: 'error',
        code: 'FFMPEG_SPAWN',
        message: 'FFmpeg could not be started. I will try again in a couple of minutes.',
      },
    ]);
    // A couple of minutes later (here 200 ms), it tries again and plays.
    throwing = false;
    await until(() => t.session.state === 'PLAYING');
    expect(t.session.status().source?.id).toBe('primary');
  });
});

describe('GuildSession: watchdog', () => {
  it('resynchronises a player that has drifted behind live', async () => {
    const t = setup({ timings: { lagMs: 100 } });
    await t.session.play('mypack:my-station', 'voice-1', 'u1');
    // The player reports no audio sent while the encoder keeps producing it.
    await until(() => t.metrics.get('playback.resync') >= 1);
    await until(() => t.pipelines.length >= 2 && t.session.state === 'PLAYING');
    expect(t.pipelines[0]!.stopped).toBe(true);
    expect(t.failures).toEqual([]);
  });

  it('does not count audio the live queue dropped to stay live as lag', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const t = setup({ timings: { lagMs: 45_000, stallMs: 600_000, watchdogIntervalMs: 1_000 } });
    const playing = t.session.play('mypack:my-station', 'voice-1', 'u1');
    await vi.advanceTimersByTimeAsync(10);
    expect((await playing).ok).toBe(true);
    const link = t.links[0]!;
    const since = Date.now();
    // 45 s of network gaps: the player sent nothing for them. The server then sent what it held
    // back, and the queue dropped it (45 s caught up): playback is back at live.
    let silentMs = 45_000;
    link.sentMs = () => Date.now() - since - silentMs;
    link.caughtUp = () => 45_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.metrics.get('playback.resync')).toBe(0);
    expect(t.pipelines).toHaveLength(1);
    // A little more silence with nothing caught up is past 45 s behind live: the safety net acts.
    silentMs = 46_000;
    link.caughtUp = () => 0;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.metrics.get('playback.resync')).toBe(1);
  });

  it('does not count the gap an HLS skip to the live edge left as drift', async () => {
    const t = setup({ timings: { lagMs: 100, watchdogIntervalMs: 20 } });
    await t.session.play('mypack:my-station', 'voice-1', 'u1');
    // The player reports no audio sent, but the reader keeps skipping forward to the live edge.
    const skipping = setInterval(() => t.inputs[0]!.stats.liveEdgeSkips++, 10);
    await wait(300);
    clearInterval(skipping);
    expect(t.metrics.get('playback.resync')).toBe(0);
    expect(t.pipelines).toHaveLength(1);
    // Once it stops skipping, real drift is caught again.
    await until(() => t.metrics.get('playback.resync') >= 1);
  });

  it('measures packets per second for the stats panel', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const t = setup({ timings: { watchdogIntervalMs: 1_000 } });
    const playing = t.session.play('mypack:my-station', 'voice-1', 'u1');
    await vi.advanceTimersByTimeAsync(10);
    expect((await playing).ok).toBe(true);
    const since = Date.now();
    const link = t.links[0]!;
    link.sentMs = () => Date.now() - since;
    link.packets = () => Math.floor((Date.now() - since) / 20);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.session.liveStats().voice?.packetsPerSecond).toBeNull(); // not enough samples yet
    await vi.advanceTimersByTimeAsync(3_000);
    expect(t.session.liveStats().voice?.packetsPerSecond).toBe(50);
  });

  it('starts the packet rate again after a voice reconnect, never showing a wrong one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const t = setup({ timings: { watchdogIntervalMs: 1_000 } });
    const playing = t.session.play('mypack:my-station', 'voice-1', 'u1');
    await vi.advanceTimersByTimeAsync(10);
    expect((await playing).ok).toBe(true);
    const link = t.links[0]!;
    let since = Date.now();
    link.sentMs = () => Date.now() - since;
    link.packets = () => 100_000 + Math.floor((Date.now() - since) / 20);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.session.liveStats().voice?.packetsPerSecond).toBe(50);
    // A new voice connection counts its packets from zero.
    since = Date.now();
    link.packets = () => Math.floor((Date.now() - since) / 20);
    link.emit('reconnected');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.session.liveStats().voice?.packetsPerSecond).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.session.liveStats().voice?.packetsPerSecond).toBe(50);
  });

  it('never shows a rate across a packet counter that went down, even without a reconnect event', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const t = setup({ timings: { watchdogIntervalMs: 1_000 } });
    const playing = t.session.play('mypack:my-station', 'voice-1', 'u1');
    await vi.advanceTimersByTimeAsync(10);
    expect((await playing).ok).toBe(true);
    const link = t.links[0]!;
    let since = Date.now();
    link.packets = () => 100_000 + Math.floor((Date.now() - since) / 20);
    await vi.advanceTimersByTimeAsync(30_000);
    since = Date.now();
    link.packets = () => Math.floor((Date.now() - since) / 20);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.session.liveStats().voice?.packetsPerSecond).toBeNull();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(t.session.liveStats().voice?.packetsPerSecond).toBe(50);
  });

  it('reports the silence the voice player filled in, over the last minute of this stream', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    const t = setup({ timings: { watchdogIntervalMs: 1_000 } });
    const playing = t.session.play('mypack:my-station', 'voice-1', 'u1');
    await vi.advanceTimersByTimeAsync(10);
    expect((await playing).ok).toBe(true);
    const link = t.links[0]!;
    const since = Date.now();
    link.sentMs = () => Date.now() - since;
    link.packets = () => 1;
    expect(t.session.liveStats().voice).toMatchObject({ silenceMs: null, recentSilenceMs: null });
    let silence = 500;
    link.silence = () => silence;
    await vi.advanceTimersByTimeAsync(2_000);
    silence = 740;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.session.liveStats().voice).toMatchObject({ silenceMs: 740, recentSilenceMs: 240 });
    // A minute later the old samples have gone: only what was filled in since counts.
    await vi.advanceTimersByTimeAsync(70_000);
    expect(t.session.liveStats().voice?.recentSilenceMs).toBe(0);
    // Not playing: no figure.
    link.silence = () => null;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.session.liveStats().voice).toMatchObject({ silenceMs: null, recentSilenceMs: null });
  });
});
