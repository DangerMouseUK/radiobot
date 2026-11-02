import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import type { EncoderPlan } from '../../src/audio/encoder.ts';
import type { PipelineStats } from '../../src/audio/pipeline.ts';
import type { StationSource } from '../../src/catalogue/types.ts';
import { Metrics } from '../../src/observability/metrics.ts';
import { RadioError } from '../../src/shared/errors.ts';
import type { SourceInput } from '../../src/streams/input.ts';
import { selectSource } from '../../src/streams/ranking.ts';
import { CIRCUIT_BREAK_FAILURES } from '../../src/streams/source-service.ts';
import type { VoiceLink, VoiceLinkEvents } from '../../src/voice/link.ts';
import {
  DEFAULT_TIMINGS,
  GuildSession,
  type SessionNotice,
  type SessionTimings,
  withOpenedBitrate,
} from '../../src/voice/session.ts';
import { makeSource, memoryDb, silentLogger } from '../helpers.ts';

class FakeLink extends EventEmitter<VoiceLinkEvents> implements VoiceLink {
  ready = true;
  played: unknown[] = [];
  destroyed = false;
  readonly channelId: string;
  constructor(channelId: string) {
    super();
    this.channelId = channelId;
  }
  play(stream: unknown): void {
    this.played.push(stream);
  }
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
      endpoint: 'c-lhr05-test.discord.media:443',
      packetsPlayed: 0,
      packetTiming: { late: 2, worstGapMs: 57 },
      encryptionMode: 'aead',
      status: 'ready',
    };
  }
  detached = false;
  detach(): void {
    this.detached = true;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

type Behaviour = 'ok' | 'silent' | 'stall-after-start' | 'fail-early';

class FakePipeline extends EventEmitter {
  readonly output = new PassThrough();
  readonly stats: PipelineStats = {
    startedAt: Date.now(),
    firstOutputAt: null,
    lastOutputAt: null,
    outputBytes: 0,
    inputBytes: 0,
    pid: 1,
  };
  stopped = false;
  readonly stderrTail: string[] = [];
  #ticker: NodeJS.Timeout | null = null;
  readonly input: SourceInput;
  readonly plan: EncoderPlan;
  constructor(input: SourceInput, plan: EncoderPlan, behaviour: Behaviour) {
    super();
    this.input = input;
    this.plan = plan;
    if (behaviour === 'silent') return;
    if (behaviour === 'fail-early') {
      setTimeout(() => this.fail(), 5);
      return;
    }
    setTimeout(() => {
      if (this.stopped) return;
      this.stats.firstOutputAt = Date.now();
      this.stats.lastOutputAt = Date.now();
      this.emit('firstAudio');
      if (behaviour === 'ok') {
        this.#ticker = setInterval(() => {
          this.stats.lastOutputAt = Date.now();
          this.stats.outputBytes += 100;
        }, 5);
      }
    }, 5);
  }
  fail(
    code:
      | 'STREAM_EOF'
      | 'FFMPEG_EXIT'
      | 'NOT_FOUND'
      | 'ACCESS_DENIED'
      | 'FFMPEG_SPAWN'
      | 'INTERNAL' = 'STREAM_EOF',
  ): void {
    this.emit('failed', new RadioError(code, 'boom'));
  }
  stop(): void {
    this.stopped = true;
    if (this.#ticker) clearInterval(this.#ticker);
  }
}

const FAST: Partial<SessionTimings> = {
  stallMs: 80,
  firstAudioTimeoutMs: 150,
  lagMs: 60_000,
  stableMs: 50,
  noSourceRetryMs: 60_000,
  stoppedIdleLeaveMs: 60_000,
  emptyLeaveMs: 40,
  emptyPauseMs: 40,
  watchdogIntervalMs: 20,
  backoff: [5, 5, 5],
  reconnectBackoff: [5, 5],
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await wait(5);
  }
}

const sessions: GuildSession[] = [];
afterEach(() => {
  for (const s of sessions.splice(0)) s.destroy();
});

function setup(
  opts: {
    sources?: StationSource[];
    behaviour?: (url: string, n: number) => Behaviour;
    bitrate?: () => number;
    connectDelayMs?: number;
    connectFails?: boolean;
    timings?: Partial<SessionTimings>;
    listeners?: () => number | null;
    onLeaving?: (channelId: string) => Promise<void> | void;
    mayStream?: () => boolean;
    pipelineThrows?: boolean;
    prepareThrows?: boolean | (() => boolean);
  } = {},
) {
  const { guilds } = memoryDb();
  const sources = opts.sources ?? [
    makeSource({ id: 'primary', url: 'https://a.example.com/p', priority: 10 }),
    makeSource({ id: 'fallback', url: 'https://b.example.com/f', priority: 20, transport: 'hls' }),
  ];
  const failures = new Map<string, number>();
  const pipelines: FakePipeline[] = [];
  const links: FakeLink[] = [];
  const notices: SessionNotice[] = [];
  let opened = 0;
  let closed = 0;
  let connects = 0;
  let prepares = 0;
  const refreshed: Array<{ stationId: string; at: number }> = [];
  const holds: number[] = [];
  const session = new GuildSession({
    guildId: 'g1',
    sources: {
      prepareForPlayback: async (_g, _s, o) => {
        // Like SourceService: probing under an aborted signal is cancelled.
        if (o.signal?.aborted) throw new RadioError('CANCELLED', 'Playback request superseded.');
        prepares++;
        const throws = typeof opts.prepareThrows === 'function' ? opts.prepareThrows() : opts.prepareThrows;
        if (throws) throw new Error('database is locked');
        return selectSource(sources, null, { exclude: o.exclude });
      },
      recordPlaybackSuccess: () => {},
      refreshStation: (stationId) => refreshed.push({ stationId, at: Date.now() }),
      select: () => selectSource(sources, null),
      holdBackground: (ms) => holds.push(ms),
      recordPlaybackFailure: (id) => {
        const n = (failures.get(id) ?? 0) + 1;
        failures.set(id, n);
        return n >= CIRCUIT_BREAK_FAILURES;
      },
    },
    stations: {
      getStation: (id) => ({ id, displayName: id }) as never,
      getSource: (id) => sources.find((s) => s.id === id) ?? null,
    },
    guilds,
    openInput: async (source, signal) => {
      // Like SafeHttpClient: a request whose signal is already aborted never connects.
      if (signal?.aborted) throw new RadioError('CANCELLED', 'Request aborted.');
      opened++;
      return {
        info: {
          transport: source.transport,
          requestedHost: 'stream.example.com',
          finalHost: 'n01-eu1.example.com',
          remoteAddress: '203.0.113.10',
          remotePort: 443,
          redirects: ['n01-eu1.example.com'],
          hls: null,
        },
        stats: { segmentHost: null, segmentsFetched: 0, segmentFailures: 0, skippedSegments: 0 },
        close() {
          closed++;
        },
      } as unknown as SourceInput;
    },
    createPipeline: (input, plan) => {
      if (opts.pipelineThrows) throw new RadioError('FFMPEG_SPAWN', 'spawn failed');
      const url = sources.find((s) => s.transport === input.info.transport)?.url ?? '';
      const p = new FakePipeline(input, plan, opts.behaviour?.(url, pipelines.length) ?? 'ok');
      pipelines.push(p);
      return p as never;
    },
    connect: async (channelId) => {
      connects++;
      if (opts.connectDelayMs) await wait(opts.connectDelayMs);
      if (opts.connectFails) throw new RadioError('VOICE_PERMISSION', 'missing Connect');
      const l = new FakeLink(channelId);
      links.push(l);
      return l;
    },
    channelBitrate: () => opts.bitrate?.() ?? 256_000,
    ...(opts.listeners ? { countListeners: opts.listeners } : {}),
    ...(opts.mayStream ? { mayStream: opts.mayStream } : {}),
    ...(opts.onLeaving ? { onLeaving: opts.onLeaving } : {}),
    notify: (n) => notices.push(n),
    logger: silentLogger(),
    metrics: new Metrics(),
    timings: { ...FAST, ...opts.timings },
    random: () => 0.5,
  });
  sessions.push(session);
  return {
    session,
    guilds,
    pipelines,
    links,
    notices,
    failures,
    sources,
    refreshed,
    opened: () => opened,
    closed: () => closed,
    connects: () => connects,
    prepares: () => prepares,
    holds,
  };
}

const active = (ps: FakePipeline[]) => ps.filter((p) => !p.stopped);

describe('GuildSession', () => {
  it('plays a station and persists desired state', async () => {
    const t = setup();
    const r = await t.session.play('fg:fg-dj-radio', 'voice-1', 'user-1');
    expect(r.ok).toBe(true);
    expect(t.session.state).toBe('PLAYING');
    // maximum follows the source's own 128 kbps rather than padding it to 510.
    expect(r.plan?.targetKbps).toBe(128);
    const intent = t.guilds.getIntent('g1')!;
    expect(intent).toMatchObject({
      desiredState: 'playing',
      desiredStationId: 'fg:fg-dj-radio',
      desiredVoiceChannelId: 'voice-1',
      lastRequestedById: 'user-1',
      lastSuccessfulSourceId: 'primary',
    });
    expect(t.session.status().source?.id).toBe('primary');
  });

  it('shows the latest stream title and drops it when the station clears it', async () => {
    const t = setup();
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    const meta = {
      title: 'Artist - Title',
      receivedAt: new Date().toISOString(),
      source: 'icy-stream-title',
    };
    t.pipelines[0]!.emit('metadata', meta);
    expect(t.session.status().nowPlaying).toEqual(meta);
    t.pipelines[0]!.emit('metadata', null);
    expect(t.session.status().nowPlaying).toBeNull();
  });

  it('switches stations without leaving two pipelines running', async () => {
    const t = setup();
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    await t.session.play('fg:fg-chic', 'voice-1', null);
    expect(active(t.pipelines)).toHaveLength(1);
    expect(t.links).toHaveLength(1);
    expect(t.session.stationId).toBe('fg:fg-chic');
  });

  it('keeps playing, without a restart, when the station already playing is asked for again', async () => {
    const t = setup();
    await t.session.play('mypack:my-station', 'voice-1', null);
    await t.session.useSource('mypack:my-station', 'fallback');
    const again = await t.session.play('mypack:my-station', 'voice-1', 'u2');
    expect(again).toMatchObject({ ok: true, message: 'Already playing.' });
    expect(t.pipelines).toHaveLength(2);
    expect(t.session.status().manualSourceId).toBe('fallback');
    // Another channel is a real move, so it does start again there.
    await t.session.play('mypack:my-station', 'voice-2', null);
    expect(t.pipelines).toHaveLength(3);
  });

  it('lets a newer request supersede a pending one', async () => {
    const t = setup();
    const first = t.session.play('fg:fg-dj-radio', 'voice-1', null);
    const second = t.session.play('fg:fg-chic', 'voice-1', null);
    const [a, b] = await Promise.all([first, second]);
    expect(a.code).toBe('CANCELLED');
    expect(b.ok).toBe(true);
    expect(t.session.stationId).toBe('fg:fg-chic');
    expect(active(t.pipelines)).toHaveLength(1);
  });

  it('stop is authoritative: audio stops and desired state is stopped', async () => {
    const t = setup();
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.session.stop();
    expect(active(t.pipelines)).toHaveLength(0);
    expect(t.session.state).toBe('CONNECTED');
    expect(t.guilds.getIntent('g1')?.desiredState).toBe('stopped');
  });

  it('announces a leave while still connected, and disconnects at once when the hook returns nothing', async () => {
    const seen: Array<{ channelId: string; destroyed: boolean }> = [];
    const t = setup({
      onLeaving: (channelId) => {
        seen.push({ channelId, destroyed: t.links[0]!.destroyed });
      },
    });
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.session.leave();
    expect(seen).toEqual([{ channelId: 'voice-1', destroyed: false }]);
    expect(t.links[0]!.destroyed).toBe(true);
    t.session.leave();
    expect(seen).toHaveLength(1); // nothing to announce once it has left
  });

  it('keeps the voice connection until the leave hook finishes, so the channel status clears first', async () => {
    let finish!: () => void;
    const t = setup({ onLeaving: () => new Promise<void>((r) => (finish = r)) });
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.session.leave();
    // Audio stops and the session has left at once; only the disconnect waits.
    expect(t.session.state).toBe('IDLE');
    expect(active(t.pipelines)).toHaveLength(0);
    expect(t.guilds.getIntent('g1')?.desiredState).toBe('left');
    expect(t.links[0]!.destroyed).toBe(false);
    finish();
    await until(() => t.links[0]!.destroyed);
  });

  it('lets a play during the leave grace period take over the open connection', async () => {
    let finish!: () => void;
    const t = setup({ onLeaving: () => new Promise<void>((r) => (finish = r)) });
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.session.leave();
    const r = await t.session.play('fg:fg-chic', 'voice-1', null);
    expect(r.ok).toBe(true);
    finish();
    await wait(20);
    expect(t.links[0]!.destroyed).toBe(false);
    expect(t.connects()).toBe(1);
    expect(t.session.state).toBe('PLAYING');
  });

  it('disconnects anyway when the leave hook never finishes', async () => {
    const t = setup({ onLeaving: () => new Promise<void>(() => {}) });
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.session.leave();
    expect(t.links[0]!.destroyed).toBe(false);
    await until(() => t.links[0]!.destroyed, 3_000);
  });

  it('leave disconnects and records left', async () => {
    const t = setup();
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.session.leave();
    expect(t.links[0]!.destroyed).toBe(true);
    expect(t.session.state).toBe('IDLE');
    expect(t.guilds.getIntent('g1')?.desiredState).toBe('left');
  });

  it('reconnects the same source after a transient failure', async () => {
    const t = setup();
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.pipelines[0]!.fail();
    await until(() => t.pipelines.length === 2 && t.session.state === 'PLAYING');
    expect(t.session.status().source?.id).toBe('primary');
    expect(active(t.pipelines)).toHaveLength(1);
  });

  it('runs every same-source retry step before the circuit breaker trips', () => {
    expect(CIRCUIT_BREAK_FAILURES).toBe(DEFAULT_TIMINGS.backoff.length + 1);
  });

  it('starts background re-checks only once the stream has played steadily', async () => {
    const t = setup();
    const started = Date.now();
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    expect(t.refreshed).toEqual([]); // nothing competes with a stream that is starting up
    await until(() => t.refreshed.length === 1);
    expect(t.refreshed[0]!.stationId).toBe('fg:fg-dj-radio');
    expect(t.refreshed[0]!.at - started).toBeGreaterThanOrEqual(FAST.stableMs!);
  });

  it('fails over at once when the station refuses access (no retries on the same source)', async () => {
    const t = setup();
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.pipelines[0]!.fail('ACCESS_DENIED');
    await until(() => t.session.state === 'PLAYING' && t.session.status().source?.id === 'fallback');
    expect(t.pipelines).toHaveLength(2);
    expect(t.session.status().failovers).toBe(1);
  });

  it('retries a 404 on the same source, as a station reconnecting its encoder sends for a moment', async () => {
    const t = setup();
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.pipelines[0]!.fail('NOT_FOUND');
    await until(() => t.pipelines.length === 2 && t.session.state === 'PLAYING');
    expect(t.session.status().source?.id).toBe('primary');
    expect(t.session.status().failovers).toBe(0);
  });

  it('fails over to a verified fallback after repeated failures and says so', async () => {
    const t = setup();
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    for (let i = 0; i < CIRCUIT_BREAK_FAILURES; i++) {
      // Every failure before the last is retried on the same source, one backoff step each.
      await until(() => t.session.state === 'PLAYING');
      expect(t.session.status().source?.id).toBe('primary');
      t.pipelines[t.pipelines.length - 1]!.fail();
      await wait(15);
    }
    await until(() => t.session.state === 'PLAYING' && t.session.status().source?.id === 'fallback');
    expect(t.notices.some((n) => n.kind === 'failover')).toBe(true);
    expect(t.session.status().failovers).toBe(1);
  });

  it('never claims to play when every source fails (FR-008 acceptance)', async () => {
    const t = setup({ behaviour: () => 'silent' });
    const r = await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    expect(r.ok).toBe(false);
    await until(() => t.session.state === 'ERROR', 5000);
    expect(t.notices.some((n) => n.kind === 'error' && n.code === 'NO_ELIGIBLE_SOURCE')).toBe(true);
    expect(active(t.pipelines)).toHaveLength(0);
  });

  it('detects a stall from missing output progress', async () => {
    const t = setup({ behaviour: (_u, n) => (n === 0 ? 'stall-after-start' : 'ok') });
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    expect(t.session.state).toBe('PLAYING');
    await until(() => t.pipelines.length >= 2 && t.session.state === 'PLAYING', 3000);
    expect(t.session.status().lastError?.code ?? 'STREAM_STALLED').toBe('STREAM_STALLED');
  });

  it('does not auto-rejoin after being kicked', async () => {
    const t = setup();
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.links[0]!.emit('lost', 'kicked');
    await wait(30);
    expect(t.session.state).toBe('IDLE');
    expect(t.guilds.getIntent('g1')?.desiredState).toBe('kicked');
    expect(t.links).toHaveLength(1);
    expect(t.notices.some((n) => n.kind === 'kicked')).toBe(true);
  });

  it('reconnects voice after an unexpected disconnect', async () => {
    const t = setup();
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.links[0]!.emit('lost', 'reconnect_failed');
    await until(() => t.links.length === 2 && t.session.state === 'PLAYING');
    expect(active(t.pipelines)).toHaveLength(1);
  });

  it('leaves an empty channel in leave_when_empty mode', async () => {
    const t = setup();
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.session.onListenersChanged(0);
    await until(() => t.session.state === 'IDLE');
    expect(t.guilds.getIntent('g1')?.desiredState).toBe('idle');
  });

  it('pauses and resumes in pause_when_empty mode', async () => {
    const t = setup();
    t.guilds.updateSettings('g1', { idleMode: 'pause_when_empty' });
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.session.onListenersChanged(0);
    await until(() => t.session.state === 'CONNECTED');
    expect(active(t.pipelines)).toHaveLength(0);
    expect(t.guilds.getIntent('g1')?.desiredState).toBe('paused_empty');
    t.session.onListenersChanged(2);
    await until(() => t.session.state === 'PLAYING');
    expect(t.guilds.getIntent('g1')?.desiredState).toBe('playing');
  });

  it('drops a pending empty-channel timer when the idle mode changes', async () => {
    const t = setup();
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.session.onListenersChanged(0); // leave_when_empty: the leave timer is armed
    t.guilds.updateSettings('g1', { idleMode: '24x7' });
    t.session.onListenersChanged(0); // what the settings menu does after a change
    await wait(80);
    expect(t.session.state).toBe('PLAYING');

    t.guilds.updateSettings('g1', { idleMode: 'leave_when_empty' });
    t.session.onListenersChanged(0);
    t.guilds.updateSettings('g1', { idleMode: 'pause_when_empty' });
    t.session.onListenersChanged(0);
    await until(() => t.session.state === 'CONNECTED');
    expect(t.guilds.getIntent('g1')?.desiredState).toBe('paused_empty');
  });

  it('stays in 24x7 mode', async () => {
    const t = setup();
    t.guilds.updateSettings('g1', { idleMode: '24x7' });
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.session.onListenersChanged(0);
    await wait(80);
    expect(t.session.state).toBe('PLAYING');
  });

  it('encodes above the channel setting and rebuilds when the quality mode changes', async () => {
    const t = setup({ bitrate: () => 96_000 });
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    expect(t.pipelines[0]!.plan.targetKbps).toBe(128);
    expect(t.pipelines[0]!.plan.channelBitrateKbps).toBe(96);
    t.guilds.updateSettings('g1', { qualityMode: 'manual', manualBitrateKbps: 256 });
    t.session.refreshEncoder();
    await until(() => t.pipelines.length === 2 && t.session.state === 'PLAYING');
    expect(t.pipelines[1]!.plan.targetKbps).toBe(256);
    expect(active(t.pipelines)).toHaveLength(1);
  });

  it('shares one connect between overlapping requests and never destroys the live link (review #1)', async () => {
    const t = setup({ connectDelayMs: 40 });
    const a = t.session.play('fg:fg-dj-radio', 'voice-1', null);
    const b = t.session.play('fg:fg-chic', 'voice-1', null);
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.code).toBe('CANCELLED');
    expect(rb.ok).toBe(true);
    expect(t.connects()).toBe(1);
    expect(t.links[0]!.destroyed).toBe(false);
    expect(t.session.state).toBe('PLAYING');
  });

  it('honours stop while still joining (review #3)', async () => {
    const t = setup({ connectDelayMs: 40 });
    const p = t.session.play('fg:fg-dj-radio', 'voice-1', null);
    await wait(5);
    t.session.stop();
    const r = await p;
    expect(r.code).toBe('CANCELLED');
    expect(t.guilds.getIntent('g1')?.desiredState).toBe('stopped');
    expect(active(t.pipelines)).toHaveLength(0);
    expect(t.links[0]?.destroyed).toBe(true);
    expect(t.session.state).toBe('IDLE');
  });

  it('does not stay JOINING when the connect fails (review #7)', async () => {
    const t = setup({ connectFails: true });
    await expect(t.session.join('voice-1')).rejects.toMatchObject({ code: 'VOICE_PERMISSION' });
    expect(t.session.state).toBe('IDLE');
    expect(t.session.isStreaming).toBe(false);
  });

  it('brings the station along when joining another channel (review #6)', async () => {
    const t = setup();
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    await t.session.join('voice-2');
    expect(t.session.state).toBe('PLAYING');
    expect(t.session.channelId).toBe('voice-2');
    expect(active(t.pipelines)).toHaveLength(1);
  });

  it('keeps the post-stop leave timer when listeners change (review #8)', async () => {
    const t = setup({ timings: { stoppedIdleLeaveMs: 60 } });
    t.guilds.updateSettings('g1', { idleMode: 'pause_when_empty' });
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.session.stop();
    t.session.onListenersChanged(3);
    await until(() => t.session.state === 'IDLE');
    expect(t.guilds.getIntent('g1')?.desiredState).toBe('stopped');
  });

  it('exposes live stats for the admin panel', async () => {
    const t = setup();
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    const live = t.session.liveStats();
    expect(live.voice?.endpoint).toBe('c-lhr05-test.discord.media:443');
    expect(live.output?.targetKbps).toBe(128);
    expect(live.connectedSince).not.toBeNull();
    expect(live.input?.finalHost).toBe('n01-eu1.example.com');
    expect(live.input?.remoteAddress).toBe('203.0.113.10');
    await wait(60);
    expect(t.session.liveStats().voice?.ws?.samples).toBeGreaterThan(0);
    t.session.leave();
    expect(t.session.liveStats().voice).toBeNull();
  });

  it('keeps playing when /radio join targets the channel it is already in', async () => {
    const t = setup();
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    await t.session.join('voice-1');
    expect(t.session.state).toBe('PLAYING');
    expect(active(t.pipelines)).toHaveLength(1);
    expect(t.links).toHaveLength(1);
    expect(t.guilds.getIntent('g1')?.desiredState).toBe('playing');
  });

  it('stays connected when joining its own channel while idle', async () => {
    const t = setup();
    await t.session.join('voice-1');
    await t.session.join('voice-1');
    expect(t.session.state).toBe('CONNECTED');
    expect(t.links).toHaveLength(1);
  });

  it('does not let a pending pause undo an explicit stop', async () => {
    const t = setup();
    t.guilds.updateSettings('g1', { idleMode: 'pause_when_empty' });
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.session.onListenersChanged(0);
    t.session.stop();
    await wait(80);
    expect(t.guilds.getIntent('g1')?.desiredState).toBe('stopped');
    t.session.onListenersChanged(2);
    await wait(30);
    expect(t.pipelines).toHaveLength(1);
    expect(t.session.state).toBe('CONNECTED');
  });

  it('keeps an explicit stop when leaving an empty channel, so autostart stays off', async () => {
    const t = setup();
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.session.stop();
    t.session.onListenersChanged(0);
    await until(() => t.session.state === 'IDLE');
    expect(t.guilds.getIntent('g1')?.desiredState).toBe('stopped');
  });

  it('applies the idle mode when it starts playing in an empty channel', async () => {
    const t = setup({ listeners: () => 0 });
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    await until(() => t.session.state === 'IDLE');
    expect(t.guilds.getIntent('g1')?.desiredState).toBe('idle');
    expect(t.notices.some((n) => n.kind === 'idle-left')).toBe(true);
  });

  it('applies the idle mode after joining an empty channel', async () => {
    const t = setup({ listeners: () => 0 });
    await t.session.join('voice-1');
    await until(() => t.session.state === 'IDLE');
  });

  it('reports a failure before the first audio as retrying, not superseded', async () => {
    const t = setup({ behaviour: (_u, n) => (n === 0 ? 'fail-early' : 'ok') });
    const r = await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    expect(r.ok).toBe(false);
    expect(r.retrying).toBe(true);
    expect(r.code).toBe('STREAM_EOF');
    expect(r.message).toMatch(/Retrying/);
    await until(() => t.session.state === 'PLAYING');
  });

  it('still reports superseded when a newer command replaces a start that is waiting for audio', async () => {
    const t = setup({ behaviour: () => 'silent', timings: { backoff: [200] } });
    const first = t.session.play('fg:fg-dj-radio', 'voice-1', null);
    await wait(20);
    t.session.stop();
    expect((await first).code).toBe('CANCELLED');
  });

  it('respects the stream limit when resuming after a pause', async () => {
    let allowed = true;
    const t = setup({ mayStream: () => allowed });
    t.guilds.updateSettings('g1', { idleMode: 'pause_when_empty' });
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    t.session.onListenersChanged(0);
    await until(() => t.guilds.getIntent('g1')?.desiredState === 'paused_empty');
    allowed = false;
    t.session.onListenersChanged(2);
    await until(() => t.session.state === 'ERROR');
    expect(t.pipelines).toHaveLength(1);
    expect(t.session.isStreaming).toBe(false);
    expect(t.notices.filter((n) => n.code === 'STREAM_LIMIT')).toHaveLength(1);
  });

  it('waits before trying again when a start fails before any source is chosen', async () => {
    const t = setup({ prepareThrows: true, timings: { noSourceRetryMs: 150 } });
    const r = await t.session.play('mypack:my-station', 'voice-1', null);
    expect(r.ok).toBe(false);
    // Once, not in a tight loop that would starve the thread sending voice packets.
    expect(t.prepares()).toBe(1);
    expect(t.session.state).toBe('ERROR');
    expect(t.failures.size).toBe(0);
    // ...and it does try again, later.
    await until(() => t.prepares() === 2);
  });

  it('does not retry after a stop that comes before the delayed retry', async () => {
    const t = setup({ prepareThrows: true, timings: { noSourceRetryMs: 100 } });
    await t.session.play('mypack:my-station', 'voice-1', null);
    t.session.stop();
    await wait(200);
    expect(t.prepares()).toBe(1);
  });

  it('waits before trying again when a playing stream fails and its restart fails before choosing a source', async () => {
    let failNext = false;
    const t = setup({ prepareThrows: () => failNext, timings: { noSourceRetryMs: 60_000 } });
    await t.session.play('mypack:my-station', 'voice-1', null);
    expect(t.session.state).toBe('PLAYING');
    failNext = true;
    t.pipelines[0]!.fail('FFMPEG_EXIT');
    await wait(150);
    // A same-source retry or two with back-off, then a wait: never a burst of restarts.
    expect(t.prepares()).toBeLessThan(5);
    expect(t.session.state).toBe('ERROR');
  });

  it("does not blame the previous station's source when the next station fails to start", async () => {
    let failNext = false;
    const t = setup({ prepareThrows: () => failNext, timings: { noSourceRetryMs: 60_000 } });
    await t.session.play('mypack:first', 'voice-1', null);
    expect(t.session.state).toBe('PLAYING');
    failNext = true;
    await t.session.play('mypack:second', 'voice-1', null);
    expect(t.session.state).toBe('ERROR');
    expect(t.failures.size).toBe(0);
  });

  it('waits for first audio by event, holds background checks at each start, and leaves no listener behind', async () => {
    const t = setup();
    await t.session.play('mypack:my-station', 'voice-1', null);
    // Once when the start begins and again when audio flows, so checks wait for it to settle.
    expect(t.holds).toEqual([FAST.stableMs, FAST.stableMs]);
    expect(t.pipelines[0]!.listenerCount('firstAudio')).toBe(0);
    await t.session.play('mypack:other', 'voice-1', null);
    expect(t.holds).toHaveLength(4);
    // A start stopped while waiting for audio leaves no listener either.
    const silent = setup({ behaviour: () => 'silent' });
    const pending = silent.session.play('mypack:my-station', 'voice-1', null);
    await until(() => silent.pipelines.length === 1);
    silent.session.stop();
    await pending;
    expect(silent.pipelines[0]!.listenerCount('firstAudio')).toBe(0);
  });

  it('reports superseded when a newer command replaces a start before its failure is known', async () => {
    const t = setup({ behaviour: (_u, n) => (n === 0 ? 'fail-early' : 'ok'), timings: { backoff: [200] } });
    const first = t.session.play('mypack:my-station', 'voice-1', null);
    t.session.stop();
    expect((await first).code).toBe('CANCELLED');
  });

  it("plays a listener's chosen source until the station changes", async () => {
    const t = setup();
    await t.session.play('mypack:my-station', 'voice-1', null);
    expect(t.session.status().source?.id).toBe('primary');
    const r = await t.session.useSource('mypack:my-station', 'fallback');
    expect(r.ok).toBe(true);
    expect(t.session.status().source?.id).toBe('fallback');
    expect(t.session.status().manualSourceId).toBe('fallback');
    expect(active(t.pipelines)).toHaveLength(1);
    // A brief failure is retried on the chosen source, not the automatic one.
    t.pipelines.at(-1)!.fail('STREAM_EOF');
    await until(() => t.session.state === 'PLAYING' && t.pipelines.length === 3);
    expect(t.session.status().source?.id).toBe('fallback');
    expect(t.session.status().manualSourceId).toBe('fallback');
    // A new station goes back to the automatic choice.
    await t.session.play('mypack:other', 'voice-1', null);
    expect(t.session.status().manualSourceId).toBeNull();
    expect(t.session.status().source?.id).toBe('primary');
  });

  it("goes back to the automatic choice when a listener's chosen source fails", async () => {
    const t = setup({ timings: { backoff: [5] } });
    await t.session.play('mypack:my-station', 'voice-1', null);
    await t.session.useSource('mypack:my-station', 'fallback');
    t.pipelines.at(-1)!.fail('ACCESS_DENIED');
    await until(() => t.session.state === 'PLAYING' && t.session.status().source?.id === 'primary');
    expect(t.session.status().manualSourceId).toBeNull();
  });

  it('never restarts playback for a source choice after a stop, or for another station', async () => {
    const t = setup();
    await t.session.play('mypack:my-station', 'voice-1', null);
    t.session.stop();
    const started = t.pipelines.length;
    const afterStop = await t.session.useSource('mypack:my-station', 'fallback');
    expect(afterStop.ok).toBe(false);
    expect(t.pipelines.length).toBe(started);
    expect(t.guilds.getIntent('g1')?.desiredState).toBe('stopped');
    await t.session.play('mypack:other', 'voice-1', null);
    const stale = await t.session.useSource('mypack:my-station', 'fallback');
    expect(stale.ok).toBe(false);
    expect(t.session.status().manualSourceId).toBeNull();
  });

  it('forgets a chosen source once it can no longer be used', async () => {
    const t = setup({ timings: { backoff: [5] } });
    await t.session.play('mypack:my-station', 'voice-1', null);
    await t.session.useSource('mypack:my-station', 'fallback');
    // The chosen source drops out (here: it is no longer offered at all) before a restart.
    t.sources.splice(
      t.sources.findIndex((s) => s.id === 'fallback'),
      1,
    );
    t.pipelines.at(-1)!.fail('STREAM_EOF');
    await until(() => t.session.state === 'PLAYING' && t.session.status().source?.id === 'primary');
    expect(t.session.status().manualSourceId).toBeNull();
  });

  it('closes the opened input when the encoder cannot be created', async () => {
    const t = setup({ pipelineThrows: true, timings: { backoff: [60_000] } });
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    expect(t.opened()).toBe(1);
    expect(t.closed()).toBe(1);
  });

  it('detects a stall when a play takes over a link that a leave is still holding open', async () => {
    let release = () => {};
    const t = setup({
      onLeaving: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      behaviour: (_u, n) => (n === 1 ? 'stall-after-start' : 'ok'),
    });
    await t.session.play('mypack:my-station', 'voice-1', null);
    t.session.leave();
    const r = await t.session.play('mypack:my-station', 'voice-1', null);
    expect(r.ok).toBe(true);
    expect(t.connects()).toBe(1); // the link the leave held open was reused
    // The second stream stalls: the watchdog must notice and restart it.
    await until(() => t.failures.get('primary') === 1 && t.pipelines.length === 3);
    release();
  });

  it("does not hold the bot's own faults against the source, and never fails over for them", async () => {
    const t = setup({ timings: { backoff: [5], stableMs: 60_000, noSourceRetryMs: 60_000 } });
    await t.session.play('mypack:my-station', 'voice-1', null);
    t.pipelines[0]!.fail('FFMPEG_SPAWN');
    // Retried on the same source after a back-off.
    await until(() => t.pipelines.length === 2 && t.session.state === 'PLAYING');
    expect(t.session.status().source?.id).toBe('primary');
    expect(t.failures.size).toBe(0);
    // Once the quick retries are used up it waits and tries again later, on no other source.
    t.pipelines[1]!.fail('FFMPEG_SPAWN');
    await until(() => t.session.state === 'ERROR');
    expect(t.pipelines).toHaveLength(2);
    expect(t.failures.size).toBe(0);
    expect(t.notices.some((n) => n.kind === 'failover')).toBe(false);
    expect(t.notices.at(-1)?.code).toBe('FFMPEG_SPAWN');
  });

  it('does not hold an internal error against the source, but fails over once its retries run out', async () => {
    const t = setup({ timings: { backoff: [5], stableMs: 60_000, noSourceRetryMs: 60_000 } });
    await t.session.play('mypack:my-station', 'voice-1', null);
    t.pipelines[0]!.fail('INTERNAL');
    await until(() => t.pipelines.length === 2 && t.session.state === 'PLAYING');
    expect(t.session.status().source?.id).toBe('primary');
    // An unexpected error may be specific to this source's data, so a working fallback plays.
    t.pipelines[1]!.fail('INTERNAL');
    await until(() => t.session.state === 'PLAYING' && t.session.status().source?.id === 'fallback');
    expect(t.failures.size).toBe(0);
    expect(t.notices.some((n) => n.kind === 'failover')).toBe(true);
  });
});

describe('GuildSession: back to the best quality', () => {
  const later = (ms: number) => new Date(Date.now() + ms).toISOString();

  it('moves back to the better source once a check shows it works again, at most once per interval', async () => {
    const t = setup({ timings: { upgradeCheckMs: 10, autoSwitchMinIntervalMs: 150 } });
    await t.session.play('mypack:my-station', 'voice-1', null);
    const primary = t.sources[0]!;
    t.pipelines[0]!.fail('ACCESS_DENIED');
    primary.lastFailureAt = new Date().toISOString();
    await until(() => t.session.state === 'PLAYING' && t.session.status().source?.id === 'fallback');
    // It failed after its last good check, so the bot stays on the fallback.
    await wait(250);
    expect(t.session.status().source?.id).toBe('fallback');
    // A background check shows it works again: the next look moves back to it.
    primary.lastSuccessAt = later(1);
    await until(() => t.session.state === 'PLAYING' && t.session.status().source?.id === 'primary');
    expect(t.notices.at(-1)).toMatchObject({ kind: 'recovered' });
    expect(t.notices.at(-1)!.message).toMatch(/moved back to it/);
    expect(t.pipelines).toHaveLength(3);
  });

  it('goes straight back when a move back fails before it plays steadily, and waits twice as long next time', async () => {
    const t = setup({ timings: { upgradeCheckMs: 10, autoSwitchMinIntervalMs: 300 } });
    await t.session.play('mypack:my-station', 'voice-1', null);
    const primary = t.sources[0]!;
    t.pipelines[0]!.fail('ACCESS_DENIED');
    primary.lastFailureAt = new Date().toISOString();
    await until(() => t.session.state === 'PLAYING' && t.session.status().source?.id === 'fallback');
    primary.lastSuccessAt = later(1);
    await until(() => t.session.status().source?.id === 'primary' && t.pipelines.length === 3);
    // The better source fails before it has played steadily (stableMs is 50 ms): no retries on it,
    // straight back to the source that was working.
    t.pipelines.at(-1)!.fail('STREAM_EOF');
    const failedAt = Date.now();
    await until(() => t.session.state === 'PLAYING' && t.session.status().source?.id === 'fallback');
    expect(t.pipelines).toHaveLength(4);
    // It shows it works again at once, but the next move back waits 600 ms (twice 300 ms).
    primary.lastSuccessAt = later(1);
    await until(() => t.session.status().source?.id === 'primary', 3_000);
    expect(Date.now() - failedAt).toBeGreaterThanOrEqual(550);
  });

  it("does not move for a source that only ranks higher on health, or away from a listener's choice", async () => {
    const t = setup({
      sources: [
        makeSource({ id: 'primary', url: 'https://a.example.com/p', priority: 10, healthScore: 100 }),
        makeSource({ id: 'second', url: 'https://c.example.com/s', priority: 20, healthScore: 40 }),
      ],
      timings: { upgradeCheckMs: 10, autoSwitchMinIntervalMs: 0 },
    });
    await t.session.play('mypack:my-station', 'voice-1', null);
    await t.session.useSource('mypack:my-station', 'second');
    await wait(150);
    expect(t.session.status().source?.id).toBe('second');
    expect(t.pipelines).toHaveLength(2);
  });

  it('re-encodes at a clearly higher bitrate when the playing source now measures one', async () => {
    const t = setup({ timings: { upgradeCheckMs: 10, autoSwitchMinIntervalMs: 0 } });
    await t.session.play('mypack:my-station', 'voice-1', null);
    expect(t.pipelines[0]!.plan.targetKbps).toBe(128);
    const primary = t.sources[0]!;
    primary.measuredBitrateKbps = 130; // within 5 %: not worth a cut
    await wait(100);
    expect(t.pipelines).toHaveLength(1);
    primary.measuredBitrateKbps = 192;
    await until(() => t.pipelines.length === 2 && t.session.state === 'PLAYING');
    expect(t.pipelines[1]!.plan.targetKbps).toBe(192);
    expect(t.session.status().source?.id).toBe('primary');
  });
});

describe('withOpenedBitrate', () => {
  const opened = (kbps: number | null) => ({ info: { advertisedBitrateKbps: kbps } }) as never;
  it('follows a clearly higher HLS rendition than the one the check measured', () => {
    const hls = makeSource({ transport: 'hls', measuredBitrateKbps: 64, codecBitrateKbps: 64 });
    expect(withOpenedBitrate(hls, opened(260))).toMatchObject({
      measuredBitrateKbps: null,
      advertisedBitrateKbps: 260,
      bitrateConfidence: 'manifest',
    });
    // Container overhead alone, an unknown figure, or a direct stream: the stored figures stand.
    expect(withOpenedBitrate(hls, opened(70))).toBe(hls);
    expect(withOpenedBitrate(hls, opened(null))).toBe(hls);
    const direct = makeSource({ measuredBitrateKbps: 64 });
    expect(withOpenedBitrate(direct, opened(320))).toBe(direct);
  });
});
