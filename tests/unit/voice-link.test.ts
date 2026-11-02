import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** A stand-in for @discordjs/voice's VoiceConnection: a state plus status events. */
class FakeConnection extends EventEmitter {
  state: { status: string; reason?: number; closeCode?: number; networking?: { state: object } } = {
    status: 'ready',
    networking: { state: {} },
  };
  ping = { ws: 10 };
  joinConfig = { channelId: 'voice-1' };
  rejoins = 0;
  /** What the next dispatchAudio calls report: true when a packet went out. */
  sends: boolean[] = [];
  dispatchAudio(): boolean {
    return this.sends.shift() ?? true;
  }
  subscribe() {
    return { unsubscribe() {} };
  }
  setState(state: FakeConnection['state']) {
    const old = this.state;
    this.state = state;
    this.emit('stateChange', old, state);
    this.emit(state.status, old, state);
  }
  rejoin() {
    this.rejoins++;
    this.setState({ status: 'ready' });
  }
  destroy() {
    this.setState({ status: 'destroyed' });
  }
}

const voice = vi.hoisted(() => ({ connection: null as unknown, playerOptions: null as unknown }));

vi.mock('@discordjs/voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@discordjs/voice')>();
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    ...actual,
    joinVoiceChannel: () => voice.connection,
    createAudioPlayer: (options: unknown) => {
      voice.playerOptions = options;
      return Object.assign(new Emitter(), { state: { status: 'idle' }, stop() {}, play() {} });
    },
  };
});
// The reconnect loop waits between attempts; tests don't need the real delays.
vi.mock('../../src/shared/async.ts', () => ({ delay: () => Promise.resolve() }));

const { DiscordVoiceLink, MAX_MISSED_FRAMES } = await import('../../src/voice/link.ts');
const { DEFAULT_TIMINGS } = await import('../../src/voice/session.ts');

const channel = { id: 'voice-1', guild: { id: 'g1', voiceAdapterCreator: () => ({}) } } as never;

async function connect() {
  const connection = new FakeConnection();
  voice.connection = connection;
  const link = await DiscordVoiceLink.connect(channel);
  return { connection, link };
}

afterEach(() => {
  voice.connection = null;
});

describe('DiscordVoiceLink', () => {
  it('turns voice connection errors into an event instead of crashing the process', async () => {
    const { connection, link } = await connect();
    const seen: Error[] = [];
    link.on('connectionError', (err) => seen.push(err));
    expect(() => connection.emit('error', new Error('udp socket closed'))).not.toThrow();
    expect(seen.map((e) => e.message)).toEqual(['udp socket closed']);
    // The connection is shared per guild and outlives a detached link: still guarded.
    link.detach();
    expect(() => connection.emit('error', new Error('dave failure'))).not.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('runs one reconnect loop however many disconnects arrive during an outage', async () => {
    const { connection, link } = await connect();
    let reconnected = 0;
    link.on('reconnected', () => reconnected++);
    for (let i = 0; i < 5; i++) connection.setState({ status: 'disconnected', reason: 0 });
    await vi.waitFor(() => expect(reconnected).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(connection.rejoins).toBe(1);
    expect(reconnected).toBe(1);
  });

  it('can reconnect again after an earlier outage has recovered', async () => {
    const { connection, link } = await connect();
    let reconnected = 0;
    link.on('reconnected', () => reconnected++);
    connection.setState({ status: 'disconnected', reason: 0 });
    await vi.waitFor(() => expect(reconnected).toBe(1));
    connection.setState({ status: 'disconnected', reason: 0 });
    await vi.waitFor(() => expect(reconnected).toBe(2));
  });

  it('does not rejoin after being detached while it waits for a reconnect', async () => {
    const { connection, link } = await connect();
    vi.useFakeTimers();
    try {
      connection.setState({ status: 'disconnected', reason: 0 });
      // Reconnecting by itself: the link waits for Ready rather than rejoining at once.
      connection.setState({ status: 'connecting' });
      await vi.advanceTimersByTimeAsync(0);
      link.detach();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(connection.rejoins).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tolerates output gaps longer than the watchdog stall threshold', async () => {
    await connect();
    const { behaviors } = voice.playerOptions as { behaviors: { maxMissedFrames: number } };
    expect(behaviors.maxMissedFrames).toBe(MAX_MISSED_FRAMES);
    // 20 ms per frame: the player must not end the resource before the watchdog reports a stall.
    expect(MAX_MISSED_FRAMES * 20).toBeGreaterThan(
      DEFAULT_TIMINGS.stallMs + DEFAULT_TIMINGS.watchdogIntervalMs,
    );
  });

  it('times the packets it sends, ignoring gaps across a pause or a reconnect', async () => {
    const { connection, link } = await connect();
    let t = 0;
    const now = vi.spyOn(performance, 'now').mockImplementation(() => t);
    const send = (at: number) => {
      t = at;
      connection.dispatchAudio();
    };
    try {
      send(0);
      send(20);
      send(90); // 70 ms late
      expect(link.stats().packetTiming).toEqual({ late: 1, worstGapMs: 70 });
      // The player stops playing: the gap until it plays again is not lateness.
      link.player.emit('stateChange', { status: 'playing' }, { status: 'idle' });
      send(5_000);
      // Nor is a gap across a voice reconnect.
      connection.setState({ status: 'connecting' });
      connection.setState({ status: 'ready', networking: { state: {} } });
      send(9_000);
      send(9_020);
      expect(link.stats().packetTiming).toEqual({ late: 1, worstGapMs: 70 });
      // A packet that wasn't sent isn't timed.
      connection.sends.push(false);
      send(9_500);
      send(9_520);
      expect(link.stats().packetTiming.late).toBe(2);
      // Once the link is gone, its timer stops counting.
      link.destroy();
      send(20_000);
      expect(link.stats().packetTiming.late).toBe(2);
    } finally {
      now.mockRestore();
    }
  });
});
