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
      if (behaviour === 'ok') {
        this.#ticker = setInterval(() => {
          this.stats.lastOutputAt = Date.now();
          this.stats.outputBytes += 100;
        }, 5);
      }
    }, 5);
  }
  fail(code: 'STREAM_EOF' | 'FFMPEG_EXIT' = 'STREAM_EOF'): void {
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
    onLeaving?: (channelId: string) => void;
    mayStream?: () => boolean;
    pipelineThrows?: boolean;
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
  const session = new GuildSession({
    guildId: 'g1',
    sources: {
      prepareForPlayback: async (_g, _s, o) => {
        // Like SourceService: probing under an aborted signal is cancelled.
        if (o.signal?.aborted) throw new RadioError('CANCELLED', 'Playback request superseded.');
        return selectSource(sources, null, { exclude: o.exclude });
      },
      recordPlaybackSuccess: () => {},
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
    opened: () => opened,
    closed: () => closed,
    connects: () => connects,
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

  it('still reports superseded when a newer command replaces a failing start', async () => {
    const t = setup({ behaviour: (_u, n) => (n === 0 ? 'fail-early' : 'ok'), timings: { backoff: [200] } });
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

  it('closes the opened input when the encoder cannot be created', async () => {
    const t = setup({ pipelineThrows: true, timings: { backoff: [60_000] } });
    await t.session.play('fg:fg-dj-radio', 'voice-1', null);
    expect(t.opened()).toBe(1);
    expect(t.closed()).toBe(1);
  });
});
