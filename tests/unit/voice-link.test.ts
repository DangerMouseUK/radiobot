import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
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

const voice = vi.hoisted(() => ({
  connection: null as unknown,
  playerOptions: null as unknown,
  joinOptions: null as unknown,
  played: [] as unknown[],
  stops: 0,
  stopThrows: false,
}));

vi.mock('@discordjs/voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@discordjs/voice')>();
  const { EventEmitter: Emitter } = await import('node:events');
  return {
    ...actual,
    joinVoiceChannel: (options: unknown) => {
      voice.joinOptions = options;
      return voice.connection;
    },
    createAudioPlayer: (options: unknown) => {
      voice.playerOptions = options;
      return Object.assign(new Emitter(), {
        state: { status: 'idle' } as { status: string },
        pause(this: { state: { status: string } }) {
          if (this.state.status !== 'playing') return false;
          this.state = { status: 'paused' };
          return true;
        },
        unpause(this: { state: { status: string } }) {
          if (this.state.status !== 'paused') return false;
          this.state = { status: 'playing' };
          return true;
        },
        stop() {
          voice.stops++;
          if (voice.stopThrows) throw new Error('player already gone');
        },
        play(resource: unknown) {
          voice.played.push(resource);
        },
      });
    },
  };
});
// The reconnect loop waits between attempts; tests don't need the real delays.
vi.mock('../../src/shared/async.ts', () => ({ delay: () => Promise.resolve() }));

const {
  DiscordVoiceLink,
  MAX_MISSED_FRAMES,
  VOICE_HOLD_MS,
  discordVoiceLinkFactory,
  guardConnection,
  timePackets,
} = await import('../../src/voice/link.ts');
const { NetworkingStatusCode } = await import('@discordjs/voice');
const { DEFAULT_TIMINGS } = await import('../../src/voice/session.ts');

const adapterCreator = () => ({}) as never;
const target = { guildId: 'g1', channelId: 'voice-1', adapterCreator };

async function connect() {
  const connection = new FakeConnection();
  voice.connection = connection;
  const link = await DiscordVoiceLink.connect(target);
  return { connection, link };
}

afterEach(() => {
  vi.useRealTimers();
  voice.connection = null;
  voice.played = [];
  voice.stops = 0;
  voice.stopThrows = false;
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
      expect(link.stats().packetTiming).toMatchObject({ late: 1, worstGapMs: 70 });
      // The player stops playing: the gap until it plays again is not lateness.
      link.player.emit('stateChange', { status: 'playing' }, { status: 'idle' });
      send(5_000);
      // Nor is a gap across a voice reconnect.
      connection.setState({ status: 'connecting' });
      connection.setState({ status: 'ready', networking: { state: {} } });
      send(9_000);
      send(9_020);
      expect(link.stats().packetTiming).toMatchObject({ late: 1, worstGapMs: 70 });
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

describe('DiscordVoiceLink: joining', () => {
  it('joins self-deafened and unmuted, with DAVE end-to-end encryption', async () => {
    const { link } = await connect();
    expect(voice.joinOptions).toMatchObject({
      channelId: 'voice-1',
      guildId: 'g1',
      selfDeaf: true,
      selfMute: false,
      daveEncryption: true,
    });
    expect(link.ready).toBe(true);
    expect(link.channelId).toBe('voice-1');
  });

  it('joins a discord.js channel through its guild adapter on the main thread', async () => {
    const connection = new FakeConnection();
    voice.connection = connection;
    const voiceAdapterCreator = () => ({}) as never;
    const link = await discordVoiceLinkFactory({
      id: 'voice-3',
      guild: { id: 'g2', voiceAdapterCreator },
    } as never);
    expect(voice.joinOptions).toMatchObject({
      channelId: 'voice-3',
      guildId: 'g2',
      adapterCreator: voiceAdapterCreator,
    });
    expect(link).toBeInstanceOf(DiscordVoiceLink);
  });

  it('gives up and releases the connection when it never becomes ready', async () => {
    vi.useFakeTimers();
    const connection = new FakeConnection();
    connection.state = { status: 'signalling' };
    voice.connection = connection;
    const joining = DiscordVoiceLink.connect(target, 20_000);
    const outcome = joining.then(
      () => null,
      (err: unknown) => err,
    );
    await vi.advanceTimersByTimeAsync(19_999);
    expect(connection.state.status).toBe('signalling');
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toMatchObject({ code: 'VOICE_CONNECT_TIMEOUT' });
    expect(connection.state.status).toBe('destroyed');
  });

  it('follows a move by a moderator, and remembers the channel it joined', async () => {
    const { connection, link } = await connect();
    connection.joinConfig.channelId = 'voice-2';
    expect(link.channelId).toBe('voice-2');
    (connection.joinConfig as { channelId: string | null }).channelId = null;
    expect(link.channelId).toBe('voice-1');
  });
});

describe('DiscordVoiceLink: audio', () => {
  it('plays Ogg Opus as it is, and reports how much it has sent', async () => {
    const { link } = await connect();
    expect(link.playbackMs()).toBe(0);
    link.play(new PassThrough());
    expect(voice.played).toHaveLength(1);
    const resource = voice.played[0] as { edges: Array<{ type: string }>; playbackDuration: number };
    // Only a demuxer: no second encode, no volume transform.
    expect(resource.edges.map((e) => e.type)).toEqual(['ogg/opus demuxer']);
    resource.playbackDuration = 1_240;
    expect(link.playbackMs()).toBe(1_240);
    expect(link.playerStatus()).toBe('idle');
    link.stopAudio();
    expect(link.playbackMs()).toBe(0);
  });

  it('reports the end of the audio once while audio was expected', async () => {
    const { link } = await connect();
    const ended: Array<Error | null> = [];
    link.on('audioEnded', (err) => ended.push(err));
    link.play(new PassThrough());
    link.player.emit('stateChange', { status: 'buffering' }, { status: 'playing' });
    link.player.emit('stateChange', { status: 'playing' }, { status: 'idle' });
    link.player.emit('stateChange', { status: 'idle' }, { status: 'idle' });
    expect(ended).toEqual([null]);
    // A player error while playing is passed on, once.
    link.play(new PassThrough());
    const err = new Error('resource error');
    link.player.emit('error', err);
    link.player.emit('error', new Error('again'));
    expect(ended).toEqual([null, err]);
  });

  it('does not report an end the session asked for', async () => {
    const { link } = await connect();
    const ended: Array<Error | null> = [];
    link.on('audioEnded', (err) => ended.push(err));
    link.play(new PassThrough());
    link.stopAudio();
    link.player.emit('stateChange', { status: 'playing' }, { status: 'idle' });
    link.player.emit('error', new Error('after stop'));
    expect(ended).toEqual([]);
  });
});

describe('DiscordVoiceLink: losing the connection', () => {
  it('waits for a moved bot to reconnect by itself (close code 4014)', async () => {
    vi.useFakeTimers();
    const { connection, link } = await connect();
    let reconnected = 0;
    link.on('reconnected', () => reconnected++);
    connection.setState({ status: 'disconnected', reason: 0, closeCode: 4014 });
    await vi.advanceTimersByTimeAsync(1_000);
    connection.setState({ status: 'connecting' });
    await vi.advanceTimersByTimeAsync(0);
    expect(reconnected).toBe(1);
    expect(connection.rejoins).toBe(0);
  });

  it('waits for a connection that is reconnecting by itself instead of rejoining', async () => {
    const { connection, link } = await connect();
    let reconnected = 0;
    link.on('reconnected', () => reconnected++);
    connection.setState({ status: 'disconnected', reason: 0 });
    connection.setState({ status: 'connecting' });
    await new Promise((r) => setTimeout(r, 5));
    connection.setState({ status: 'ready' });
    await vi.waitFor(() => expect(reconnected).toBe(1));
    expect(connection.rejoins).toBe(0);
  });

  it('treats a 4014 close without a reconnect as a kick and lets go', async () => {
    vi.useFakeTimers();
    const { connection, link } = await connect();
    const lost: string[] = [];
    link.on('lost', (reason) => lost.push(reason));
    connection.setState({ status: 'disconnected', reason: 0, closeCode: 4014 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(lost).toEqual(['kicked']);
    expect(connection.state.status).toBe('destroyed');
    expect(connection.rejoins).toBe(0);
  });

  it('rejoins up to five times, then reports the connection lost', async () => {
    vi.useFakeTimers();
    const { connection, link } = await connect();
    // Every rejoin stalls in signalling.
    connection.rejoin = () => {
      connection.rejoins++;
      connection.setState({ status: 'signalling' });
    };
    const lost: string[] = [];
    link.on('lost', (reason) => lost.push(reason));
    connection.setState({ status: 'disconnected', reason: 0 });
    for (let i = 0; i < 12 && lost.length === 0; i++) await vi.advanceTimersByTimeAsync(15_000);
    expect(lost).toEqual(['reconnect_failed']);
    expect(connection.rejoins).toBe(5);
    expect(connection.state.status).toBe('destroyed');
  });

  it('stops trying once the connection is destroyed elsewhere', async () => {
    const { connection, link } = await connect();
    const lost: string[] = [];
    link.on('lost', (reason) => lost.push(reason));
    connection.setState({ status: 'disconnected', reason: 0 });
    connection.setState({ status: 'destroyed' });
    await new Promise((r) => setTimeout(r, 10));
    expect(lost).toEqual(['destroyed']);
    expect(connection.rejoins).toBe(0);
  });

  it('reports a loss once, and only to a listener', async () => {
    const { connection, link } = await connect();
    // With nobody listening, a destroyed connection is simply dropped.
    connection.setState({ status: 'destroyed' });
    const lost: string[] = [];
    link.on('lost', (reason) => lost.push(reason));
    link.destroy();
    link.destroy();
    expect(lost).toEqual(['destroyed']);
  });
});

describe('DiscordVoiceLink: brief interruptions', () => {
  type PlayerLike = { state: { status: string } };
  const playing = (link: { player: unknown }) => {
    (link.player as PlayerLike).state = { status: 'playing' };
  };
  const status = (link: { player: unknown }) => (link.player as PlayerLike).state.status;
  /** The networking state of a voice WebSocket resume, with the socket that replaced the closed one. */
  const resuming = () => ({
    status: 'connecting',
    networking: { state: { code: NetworkingStatusCode.Resuming, ws: new EventEmitter() } },
  });

  it('holds its place while the voice WebSocket resumes, then plays on with nothing skipped', async () => {
    vi.useFakeTimers();
    const { connection, link } = await connect();
    const ws = new EventEmitter();
    connection.setState({ status: 'ready', networking: { state: { code: NetworkingStatusCode.Ready, ws } } });
    playing(link);
    const interrupted: unknown[] = [];
    const restored: unknown[] = [];
    link.on('interrupted', (info) => interrupted.push(info));
    link.on('restored', (info) => restored.push(info));
    // The library hears the close first and moves the connection on from inside it.
    ws.once('close', () => connection.setState(resuming()));
    ws.emit('close', { code: 1006 });
    expect(status(link)).toBe('paused');
    expect(interrupted).toEqual([{ status: 'connecting', resuming: true, closeCode: 1006, held: true }]);
    await vi.advanceTimersByTimeAsync(120);
    connection.setState({ status: 'ready', networking: { state: { code: NetworkingStatusCode.Ready } } });
    expect(status(link)).toBe('playing');
    expect(restored).toEqual([{ afterMs: 120, heldMs: 120, skippedMs: 0 }]);
    // The hold's own timer is gone: nothing unpauses the player later.
    (link.player as PlayerLike).state = { status: 'paused' };
    await vi.advanceTimersByTimeAsync(VOICE_HOLD_MS * 2);
    expect(status(link)).toBe('paused');
  });

  it('stops holding after a second, so a long outage cannot leave playback far behind live', async () => {
    vi.useFakeTimers();
    const { connection, link } = await connect();
    playing(link);
    const restored: unknown[] = [];
    link.on('restored', (info) => restored.push(info));
    connection.setState({ status: 'connecting' });
    expect(status(link)).toBe('paused');
    await vi.advanceTimersByTimeAsync(VOICE_HOLD_MS - 1);
    expect(status(link)).toBe('paused');
    await vi.advanceTimersByTimeAsync(1);
    // Playing again without the connection: it reads on and drops, as the library always did.
    expect(status(link)).toBe('playing');
    await vi.advanceTimersByTimeAsync(3_000);
    connection.setState({ status: 'ready' });
    expect(restored).toEqual([{ afterMs: VOICE_HOLD_MS + 3_000, heldMs: VOICE_HOLD_MS, skippedMs: 3_000 }]);
  });

  it('holds nothing when nothing is playing, and says why the connection went', async () => {
    const { connection, link } = await connect();
    const interrupted: unknown[] = [];
    const restored: Array<{ heldMs: number; skippedMs: number }> = [];
    link.on('interrupted', (info) => interrupted.push(info));
    link.on('restored', (info) => restored.push(info));
    connection.setState({ status: 'signalling' });
    expect(status(link)).toBe('idle');
    // Still not ready: one interruption, not one per state.
    connection.setState({ status: 'connecting' });
    connection.setState({ status: 'ready' });
    expect(interrupted).toEqual([{ status: 'signalling', resuming: false, closeCode: null, held: false }]);
    expect(restored).toMatchObject([{ heldMs: 0, skippedMs: 0 }]);
    // Destroyed is not an interruption: the link is lost.
    connection.setState({ status: 'destroyed' });
    expect(interrupted).toHaveLength(1);
  });

  it('lets go of a hold when it is detached or destroyed', async () => {
    vi.useFakeTimers();
    for (const end of ['detach', 'destroy'] as const) {
      const { connection, link } = await connect();
      playing(link);
      connection.setState({ status: 'connecting' });
      expect(status(link)).toBe('paused');
      link[end]();
      expect(vi.getTimerCount()).toBe(0);
    }
  });
});

describe('DiscordVoiceLink: teardown', () => {
  it('destroys the connection, and survives a player that is already gone', async () => {
    const { connection, link } = await connect();
    voice.stopThrows = true;
    expect(() => link.destroy()).not.toThrow();
    expect(connection.state.status).toBe('destroyed');
    expect(link.listenerCount('audioEnded')).toBe(0);
  });

  it('detaches without destroying the shared connection, once', async () => {
    const { connection, link } = await connect();
    voice.stopThrows = true;
    const reconnected: number[] = [];
    link.on('reconnected', () => reconnected.push(1));
    expect(() => link.detach()).not.toThrow();
    link.detach();
    expect(voice.stops).toBe(1);
    expect(connection.state.status).toBe('ready');
    // The connection's later state changes are no longer this link's business.
    connection.setState({ status: 'disconnected', reason: 0 });
    await new Promise((r) => setTimeout(r, 10));
    expect(connection.rejoins).toBe(0);
    expect(reconnected).toEqual([]);
    // Nor does destroying a detached link touch the connection.
    connection.setState({ status: 'ready' });
    link.destroy();
    expect(connection.state.status).toBe('ready');
  });
});

describe('DiscordVoiceLink: stats', () => {
  it('reports the voice endpoint, packets and encryption mode while ready', async () => {
    const { connection, link } = await connect();
    connection.state = {
      status: 'ready',
      networking: {
        state: {
          connectionOptions: { endpoint: 'c-test01.discord.media:443' },
          connectionData: { packetsPlayed: 1_500, encryptionMode: 'aead_aes256_gcm_rtpsize' },
        },
      },
    };
    expect(link.stats()).toEqual({
      wsPingMs: 10,
      endpoint: 'c-test01.discord.media:443',
      packetsPlayed: 1_500,
      packetTiming: { late: 0, worstGapMs: null, recent: [] },
      silenceMs: null,
      encryptionMode: 'aead_aes256_gcm_rtpsize',
      status: 'ready',
    });
    connection.state = {
      status: 'ready',
      networking: { state: { connectionOptions: {}, connectionData: { packetsPlayed: 'n/a' } } },
    };
    expect(link.stats()).toMatchObject({ endpoint: null, packetsPlayed: null, encryptionMode: null });
  });

  it('reports nothing it cannot know while not ready', async () => {
    const { connection, link } = await connect();
    connection.ping = { ws: undefined as unknown as number };
    connection.state = { status: 'connecting' };
    expect(link.ready).toBe(false);
    expect(link.stats()).toMatchObject({
      wsPingMs: null,
      endpoint: null,
      packetsPlayed: null,
      encryptionMode: null,
      status: 'connecting',
    });
  });

  it('reports the silence the player filled in for the current resource, only while playing', async () => {
    const { link } = await connect();
    const player = link.player as unknown as { state: object };
    expect(link.stats().silenceMs).toBeNull();
    // 5 s of frames sent, 4.2 s of them audio: 0.8 s of silence.
    player.state = { status: 'playing', playbackDuration: 5_000, resource: { playbackDuration: 4_200 } };
    expect(link.stats().silenceMs).toBe(800);
    player.state = { status: 'playing', playbackDuration: 0, resource: { playbackDuration: 20 } };
    expect(link.stats().silenceMs).toBe(0);
    player.state = { status: 'buffering' };
    expect(link.stats().silenceMs).toBeNull();
  });

  it('tells observers when the connection or the player changes state', async () => {
    const { connection, link } = await connect();
    let changes = 0;
    link.on('changed', () => changes++);
    link.player.emit('stateChange', { status: 'buffering' }, { status: 'playing' });
    connection.setState({ status: 'connecting' });
    expect(changes).toBe(2);
  });

  it('says whether DAVE end-to-end encryption was negotiated', async () => {
    const { connection, link } = await connect();
    expect(link.encryption()).toBe('Encrypted in transit; DAVE end-to-end encryption not used for this call');
    (connection as unknown as { voicePrivacyCode: string }).voicePrivacyCode = '12345 67890';
    expect(link.encryption()).toBe('DAVE end-to-end encrypted (privacy code 12345 67890)');
  });
});

describe('connection guards', () => {
  it('adds one fallback error listener per connection, however often it is asked', () => {
    const connection = new FakeConnection();
    guardConnection(connection as never);
    guardConnection(connection as never);
    expect(connection.listenerCount('error')).toBe(1);
    expect(() => connection.emit('error', new Error('ws closed'))).not.toThrow();
  });

  it('leaves a connection without dispatchAudio alone, so playback never breaks', () => {
    const connection = { dispatchAudio: undefined } as unknown as { dispatchAudio: () => boolean };
    expect(() => timePackets(connection as never)).not.toThrow();
    expect(connection.dispatchAudio).toBeUndefined();
    // And wraps a real one only once.
    const real = new FakeConnection();
    timePackets(real as never);
    const wrapped = real.dispatchAudio;
    timePackets(real as never);
    expect(real.dispatchAudio).toBe(wrapped);
    expect(real.dispatchAudio()).toBe(true);
  });
});
