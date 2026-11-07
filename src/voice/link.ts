import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import {
  type AudioPlayer,
  AudioPlayerStatus,
  type AudioResource,
  createAudioPlayer,
  createAudioResource,
  type DiscordGatewayAdapterCreator,
  entersState,
  joinVoiceChannel,
  NetworkingStatusCode,
  NoSubscriberBehavior,
  type PlayerSubscription,
  StreamType,
  type VoiceConnection,
  VoiceConnectionDisconnectReason,
  type VoiceConnectionState,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import { delay } from '../shared/async.ts';
import { RadioError } from '../shared/errors.ts';
import { PacketTiming, type PacketTimingSummary } from './packet-timing.ts';

export interface VoiceLinkEvents {
  /** The connection is gone for good (destroyed, kicked, or reconnects exhausted). */
  lost: [reason: 'kicked' | 'destroyed' | 'reconnect_failed'];
  /** The audio player went idle while we expected audio (stream ended or errored). */
  audioEnded: [error: Error | null];
  /** Voice connection transiently lost and recovered. */
  reconnected: [];
  /** The voice WebSocket, UDP socket or DAVE session reported an error; recovery is automatic. */
  connectionError: [error: Error];
  /** The voice connection stopped being ready (a resume, a reconnect or a move). */
  interrupted: [info: VoiceInterruption];
  /** The voice connection is ready again after an interruption. */
  restored: [info: VoiceRestore];
  /**
   * The connection or the player changed state. Only for observers that mirror the link (the
   * voice worker pushes a fresh snapshot to the main thread); nothing listens in main-thread mode.
   */
  changed: [];
}

export interface VoiceInterruption {
  /** The connection's new status (`connecting`, `signalling`, `disconnected` …). */
  status: string;
  /** The library is resuming the same voice session (same UDP socket, keys and DAVE state). */
  resuming: boolean;
  /** The voice WebSocket's close code, when the interruption began with one. */
  closeCode: number | null;
  /**
   * Playback was held in place rather than read on and dropped (it was playing, and the stream had
   * some of its hold allowance left).
   */
  held: boolean;
}

export interface VoiceRestore {
  /** How long the connection was not ready, ms. */
  afterMs: number;
  /** Audio held in place, to play on from where it stopped (none of it skipped), ms. */
  heldMs: number;
  /** Audio read and dropped while the connection was not ready, ms (0 when nothing was playing). */
  skippedMs: number;
}

export interface VoiceLinkStats {
  /** Round trip of the voice WebSocket heartbeat, ms. */
  wsPingMs: number | null;
  /** Discord voice server endpoint host (e.g. "c-abc01-….discord.media"). */
  endpoint: string | null;
  /** Opus packets sent to Discord on this connection. */
  packetsPlayed: number | null;
  /** Packets sent late while playing since the bot joined, and the longest gap between two. */
  packetTiming: PacketTimingSummary;
  /**
   * Silence the player has sent in place of audio for the current resource, ms: frames it had to
   * fill because no Opus packet was ready (null when not playing).
   */
  silenceMs: number | null;
  encryptionMode: string | null;
  status: string;
}

/** The minimal voice surface a session needs; faked in tests. */
export interface VoiceLink extends EventEmitter<VoiceLinkEvents> {
  readonly channelId: string;
  readonly ready: boolean;
  play(stream: Readable): void;
  stopAudio(): void;
  /** Milliseconds of audio the player has sent for the current resource. */
  playbackMs(): number;
  playerStatus(): string;
  /** Debug information about the encryption/DAVE state where exposed. */
  encryption(): string;
  stats(): VoiceLinkStats;
  /** Stops using this link without destroying the shared guild voice connection. */
  detach(): void;
  destroy(): void;
}

export type VoiceLinkFactory = (channel: VoiceBasedChannel) => Promise<VoiceLink>;

/** Where to join: plain values plus the gateway adapter, so the join can run on another thread. */
export interface VoiceJoinTarget {
  guildId: string;
  channelId: string;
  adapterCreator: DiscordGatewayAdapterCreator;
}

/**
 * Frames without audio before the player gives up on a resource (20 ms each, so 25 s). It must
 * outlast the session watchdog (15 s stall threshold, checked every 5 s), so an output gap is
 * reported as STREAM_STALLED by the watchdog rather than ending the resource as STREAM_EOF.
 */
export const MAX_MISSED_FRAMES = 1250;

/**
 * How long the player holds its place while the voice connection is not ready. The library sends
 * nothing then (not even during a voice WebSocket resume, usually a fraction of a second), and a player
 * left playing reads the station's audio and drops it, so every resume skipped a little music.
 * Holding plays on from where it stopped instead. Past this limit the player goes back to reading
 * and dropping, so a long outage can't leave playback far behind live, or back the encoder up
 * until the watchdog takes it for a stall.
 */
export const VOICE_HOLD_MS = 1_000;

/**
 * The most a stream may be held in all. Each hold leaves playback that much further behind live
 * and nothing wins it back (the player reads at the rate the station sends), so on a link that
 * resumes often the holds would add up to the session's live-lag limit and force a restart, an
 * audible cut. Once a stream has been held this long, resumes play on and drop as before. A new
 * stream (another station, a source switch or a resync) starts with the full allowance again.
 */
export const VOICE_HOLD_BUDGET_MS = 10_000;

/**
 * Connections that already have a fallback 'error' listener. An EventEmitter 'error' with no
 * listener throws, and @discordjs/voice re-emits WebSocket, UDP and DAVE errors on the
 * connection, so one guild's voice error would otherwise crash the whole process. The fallback
 * stays attached after a link detaches, because the connection is shared per guild.
 */
const guardedConnections = new WeakSet<VoiceConnection>();

export function guardConnection(connection: Pick<VoiceConnection, 'on'>): void {
  const key = connection as VoiceConnection;
  if (guardedConnections.has(key)) return;
  guardedConnections.add(key);
  connection.on('error', () => {
    /* handled by the link's own listener while attached; disconnect handling recovers */
  });
}

/** The timer of the link currently using each connection; a newer link on the same connection takes over. */
const packetTimings = new WeakMap<VoiceConnection, PacketTiming>();
const timedConnections = new WeakSet<VoiceConnection>();

/**
 * The player calls `dispatchAudio` every 20 ms while playing, and it returns true when a packet
 * went out, so wrapping it times every packet for one clock read each. Like the error guard, the
 * wrapper is added once and stays for the life of the shared connection.
 */
export function timePackets(connection: Pick<VoiceConnection, 'dispatchAudio'>): void {
  const key = connection as VoiceConnection;
  // If a library update renames the method, playback must not break; the count just stays at 0.
  if (timedConnections.has(key) || typeof connection.dispatchAudio !== 'function') return;
  timedConnections.add(key);
  const dispatch = connection.dispatchAudio.bind(connection);
  connection.dispatchAudio = () => {
    const sent = dispatch();
    if (sent) packetTimings.get(key)?.sent();
    return sent;
  };
}

/** Test seam: makes `timing` the timer for `connection`, as a new link does. */
export function setPacketTiming(connection: object, timing: PacketTiming): void {
  packetTimings.set(connection as VoiceConnection, timing);
}

/**
 * @discordjs/voice-backed link. Self-deafened (no inbound audio, PRD FR-003), unmuted,
 * DAVE end-to-end encryption enabled. Input is already Ogg Opus, so the library only
 * demuxes packets — there is no second encode (PRD FR-007, NFR-06).
 */
export class DiscordVoiceLink extends EventEmitter<VoiceLinkEvents> implements VoiceLink {
  readonly connection: VoiceConnection;
  readonly player: AudioPlayer;
  readonly #initialChannelId: string;
  #subscription: PlayerSubscription | undefined;
  #onConnectionState: ((oldState: VoiceConnectionState, newState: VoiceConnectionState) => void) | null =
    null;
  #onConnectionError: ((error: Error) => void) | null = null;
  #resource: AudioResource | null = null;
  #expectingAudio = false;
  #reconnecting = false;
  #destroyed = false;
  readonly #timing = new PacketTiming();
  /**
   * The interruption in progress. `heldMs` and `skippedMs` add up the time the player actually
   * spent paused by the link and playing (reading and dropping), from its own state changes, so a
   * Stop, a new station or the end of a hold part-way through is counted as it happened.
   */
  #outage: {
    since: number;
    held: boolean;
    heldMs: number;
    skippedMs: number;
    /** When the player entered its current status during the outage. */
    mark: number;
  } | null = null;
  #holdTimer: NodeJS.Timeout | null = null;
  /** How long the current stream has been held in all (see VOICE_HOLD_BUDGET_MS). */
  #heldTotalMs = 0;
  /** The close code of the voice WebSocket that closed last, read when the interruption begins. */
  #closeCode: number | null = null;
  /** The voice WebSocket in use; a close from one the library has already replaced is ignored. */
  #socket: object | null = null;
  readonly #watchedSockets = new WeakSet<object>();

  private constructor(connection: VoiceConnection, channelId: string) {
    super();
    this.connection = connection;
    this.#initialChannelId = channelId;
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: MAX_MISSED_FRAMES },
    });
    this.#subscription = connection.subscribe(this.player);
    timePackets(connection);
    packetTimings.set(connection, this.#timing);

    this.player.on('stateChange', (oldState, newState) => {
      if (newState.status !== AudioPlayerStatus.Playing) this.#timing.pause();
      if (this.#outage && oldState.status !== newState.status) this.#account(oldState.status);
      this.emit('changed');
      if (
        newState.status === AudioPlayerStatus.Idle &&
        oldState.status !== AudioPlayerStatus.Idle &&
        this.#expectingAudio
      ) {
        this.#expectingAudio = false;
        this.emit('audioEnded', null);
      }
    });
    this.player.on('error', (err) => {
      if (this.#expectingAudio) {
        this.#expectingAudio = false;
        this.emit('audioEnded', err);
      }
    });

    this.#watchSocket(connection.state);
    this.#onConnectionState = (old, state) => {
      this.#watchSocket(state);
      const ready = state.status === VoiceConnectionStatus.Ready;
      if (!ready) this.#timing.pause();
      if (
        old.status === VoiceConnectionStatus.Ready &&
        !ready &&
        state.status !== VoiceConnectionStatus.Destroyed
      ) {
        this.#interrupted(state);
      } else if (ready && this.#outage) this.#restored();
      this.emit('changed');
      if (state.status === VoiceConnectionStatus.Disconnected) void this.#reconnect(state);
      else if (state.status === VoiceConnectionStatus.Destroyed) this.#markLost('destroyed');
    };
    connection.on('stateChange', this.#onConnectionState);
    this.#onConnectionError = (error) => this.emit('connectionError', error);
    guardConnection(connection);
    connection.on('error', this.#onConnectionError);
  }

  /** Current channel; follows moves made by moderators (the connection's join config updates). */
  get channelId(): string {
    return this.connection.joinConfig.channelId ?? this.#initialChannelId;
  }

  detach(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#expectingAudio = false;
    this.#endHold();
    try {
      this.player.stop(true);
    } catch {
      /* ignore */
    }
    this.#subscription?.unsubscribe();
    this.#releaseTiming();
    if (this.#onConnectionState) this.connection.off('stateChange', this.#onConnectionState);
    if (this.#onConnectionError) this.connection.off('error', this.#onConnectionError);
    this.removeAllListeners();
  }

  static async connect(target: VoiceJoinTarget, timeoutMs = 20_000): Promise<DiscordVoiceLink> {
    const connection = joinVoiceChannel({
      channelId: target.channelId,
      guildId: target.guildId,
      adapterCreator: target.adapterCreator,
      selfDeaf: true,
      selfMute: false,
      daveEncryption: true,
    });
    guardConnection(connection);
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, timeoutMs);
    } catch (err) {
      connection.destroy();
      throw new RadioError('VOICE_CONNECT_TIMEOUT', 'Could not connect to the voice channel in time.', {
        cause: err,
      });
    }
    return new DiscordVoiceLink(connection, target.channelId);
  }

  /**
   * Single-flight: a failed rejoin sets Disconnected again, and every such transition during an
   * outage would otherwise start another loop of its own.
   */
  async #reconnect(state: { reason?: VoiceConnectionDisconnectReason; closeCode?: number }): Promise<void> {
    if (this.#reconnecting || this.#destroyed) return;
    this.#reconnecting = true;
    try {
      await this.#onDisconnected(state);
    } finally {
      this.#reconnecting = false;
    }
  }

  async #onDisconnected(state: {
    reason?: VoiceConnectionDisconnectReason;
    closeCode?: number;
  }): Promise<void> {
    if (this.#destroyed) return;
    if (state.reason === VoiceConnectionDisconnectReason.WebSocketClose && state.closeCode === 4014) {
      // 4014: removed from the channel — either moved (reconnects by itself) or kicked.
      try {
        await entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000);
        this.emit('reconnected');
      } catch {
        this.#markLost('kicked');
        this.destroy();
      }
      return;
    }
    for (let attempt = 0; attempt < 5 && !this.#destroyed; attempt++) {
      await delay((attempt + 1) * 2_000);
      if (this.#destroyed || this.connection.state.status === VoiceConnectionStatus.Destroyed) return;
      if (this.connection.state.status !== VoiceConnectionStatus.Disconnected) {
        try {
          await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
          this.emit('reconnected');
          return;
        } catch {
          /* try again */
        }
        // Detached or destroyed while waiting: the connection belongs to someone else now.
        if (this.#destroyed) return;
      }
      this.connection.rejoin();
      try {
        await entersState(this.connection, VoiceConnectionStatus.Ready, 15_000);
        this.emit('reconnected');
        return;
      } catch {
        /* next attempt */
      }
    }
    this.#markLost('reconnect_failed');
    this.destroy();
  }

  /**
   * Notes the close code of each voice WebSocket the connection uses. The listener goes first, so
   * the code is known before the library reacts to the close (and moves the connection on).
   */
  #watchSocket(state: VoiceConnectionState): void {
    const net = 'networking' in state ? state.networking?.state : undefined;
    const ws = net && 'ws' in net ? (net.ws as unknown) : undefined;
    if (!(ws instanceof EventEmitter)) return;
    this.#socket = ws;
    if (this.#watchedSockets.has(ws)) return;
    this.#watchedSockets.add(ws);
    ws.prependOnceListener('close', (event: { code?: unknown } | undefined) => {
      // The library closes a socket it has replaced (code 1000) after the fact: that isn't news.
      if (this.#socket === ws) this.#closeCode = typeof event?.code === 'number' ? event.code : null;
    });
  }

  /**
   * The connection stopped being ready. While it isn't, the library sends nothing, so a playing
   * player is paused to hold its place (for up to VOICE_HOLD_MS, and while the stream has some of
   * VOICE_HOLD_BUDGET_MS left) instead of reading on.
   */
  #interrupted(state: VoiceConnectionState): void {
    const net = 'networking' in state ? state.networking?.state : undefined;
    const resuming = net?.code === NetworkingStatusCode.Resuming;
    const closeCode = this.#closeCode;
    this.#closeCode = null;
    this.#endHold();
    const allowance = Math.min(VOICE_HOLD_MS, VOICE_HOLD_BUDGET_MS - this.#heldTotalMs);
    const held = allowance > 0 && this.player.pause(false);
    const now = Date.now();
    this.#outage = { since: now, held, heldMs: 0, skippedMs: 0, mark: now };
    if (held) {
      this.#holdTimer = setTimeout(() => {
        this.#holdTimer = null;
        // Too long to hold: play on without the connection, as before, to stay at the live edge.
        this.#unpause();
      }, allowance);
      this.#holdTimer.unref?.();
    }
    this.emit('interrupted', { status: state.status, resuming, closeCode, held });
  }

  /** Ready again: a held player plays on from the frame after the last one sent. */
  #restored(): void {
    this.#account(this.player.state.status);
    const outage = this.#outage!;
    this.#outage = null;
    this.#closeCode = null;
    const afterMs = Math.max(0, Date.now() - outage.since);
    this.#endHold();
    this.#unpause();
    this.emit('restored', { afterMs, heldMs: outage.heldMs, skippedMs: outage.skippedMs });
  }

  /**
   * During an outage, adds the time since the last mark to what the player was doing: paused by
   * the link (held, and counted against the stream's allowance) or playing (read and dropped).
   */
  #account(status: AudioPlayerStatus): void {
    const outage = this.#outage!;
    const now = Date.now();
    const spent = Math.max(0, now - outage.mark);
    outage.mark = now;
    if (status === AudioPlayerStatus.Paused) {
      outage.heldMs += spent;
      this.#heldTotalMs += spent;
    } else if (status === AudioPlayerStatus.Playing) outage.skippedMs += spent;
  }

  /** Unpauses only a pause of the link's own: nothing else pauses this player. */
  #unpause(): void {
    if (this.player.state.status === AudioPlayerStatus.Paused) this.player.unpause();
  }

  #endHold(): void {
    if (this.#holdTimer) clearTimeout(this.#holdTimer);
    this.#holdTimer = null;
  }

  #markLost(reason: 'kicked' | 'destroyed' | 'reconnect_failed'): void {
    if (this.listenerCount('lost') === 0) return;
    this.#expectingAudio = false;
    this.emit('lost', reason);
    this.removeAllListeners('lost');
  }

  get ready(): boolean {
    return this.connection.state.status === VoiceConnectionStatus.Ready;
  }

  play(stream: Readable): void {
    const resource = createAudioResource(stream, { inputType: StreamType.OggOpus, inlineVolume: false });
    this.#resource = resource;
    this.#expectingAudio = true;
    this.player.play(resource);
    // A new stream starts at the live edge, with the whole hold allowance (after the play above
    // has counted any hold it cut short against the old stream).
    this.#heldTotalMs = 0;
  }

  stopAudio(): void {
    this.#expectingAudio = false;
    this.player.stop(true);
    this.#resource = null;
  }

  playbackMs(): number {
    return this.#resource?.playbackDuration ?? 0;
  }

  playerStatus(): string {
    return this.player.state.status;
  }

  stats(): VoiceLinkStats {
    const ping = this.connection.ping;
    const state = this.connection.state;
    let endpoint: string | null = null;
    let packetsPlayed: number | null = null;
    let encryptionMode: string | null = null;
    if (state.status === VoiceConnectionStatus.Ready) {
      const net = state.networking.state;
      if ('connectionOptions' in net && net.connectionOptions)
        endpoint = net.connectionOptions.endpoint ?? null;
      if ('connectionData' in net && net.connectionData) {
        const data = net.connectionData as { packetsPlayed?: number; encryptionMode?: string };
        packetsPlayed = typeof data.packetsPlayed === 'number' ? data.packetsPlayed : null;
        encryptionMode = data.encryptionMode ?? null;
      }
    }
    return {
      wsPingMs: ping.ws ?? null,
      endpoint,
      packetsPlayed,
      packetTiming: this.#timing.summary(),
      silenceMs: this.#silenceMs(),
      encryptionMode,
      status: state.status,
    };
  }

  /**
   * The player counts every frame it sends, the resource only those it had audio for, so the
   * difference is the silence it filled in. Read here, when asked: nothing is added per packet.
   */
  #silenceMs(): number | null {
    const state = this.player.state;
    if (state.status !== AudioPlayerStatus.Playing) return null;
    return Math.max(0, state.playbackDuration - state.resource.playbackDuration);
  }

  #releaseTiming(): void {
    if (packetTimings.get(this.connection) === this.#timing) packetTimings.delete(this.connection);
  }

  encryption(): string {
    const code = this.connection.voicePrivacyCode;
    return code
      ? `DAVE end-to-end encrypted (privacy code ${code})`
      : 'Encrypted in transit; DAVE end-to-end encryption not used for this call';
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#expectingAudio = false;
    this.#endHold();
    try {
      this.player.stop(true);
    } catch {
      /* ignore */
    }
    this.#releaseTiming();
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
    if (this.#onConnectionError) this.connection.off('error', this.#onConnectionError);
    this.#markLost('destroyed');
    this.removeAllListeners();
  }
}

/** Main-thread mode: the voice connection and player run on the thread that runs everything else. */
export const discordVoiceLinkFactory: VoiceLinkFactory = (channel) =>
  DiscordVoiceLink.connect({
    guildId: channel.guild.id,
    channelId: channel.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
  });
