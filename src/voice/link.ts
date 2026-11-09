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
import { type LiveCatchUp, type LiveQueue, type LiveQueueStats, liveQueueFrom } from './live-queue.ts';
import { PacketTiming, type PacketTimingSummary } from './packet-timing.ts';
import {
  openReceiverReport,
  type ReceiverReportReading,
  ReceiverReportTap,
  type ReportSocket,
  summarise,
} from './receiver-report.ts';

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
  /** The live queue dropped audio to stay near live (the connect burst, or a backlog after a break). */
  caughtUp: [event: LiveCatchUp];
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
}

export interface VoiceRestore {
  /** How long the connection was not ready, ms. */
  afterMs: number;
  /**
   * Audio the player read on and dropped while the connection was not ready, ms (0 when nothing was
   * playing). Playback stays live: the gap is heard, and the music has moved on by this much.
   */
  skippedMs: number;
  /** Audio the live queue dropped at the same moment, to get back to its cushion, ms. */
  caughtUpMs: number;
}

/** How a stream is to be played. */
export interface PlayOptions {
  /** How much audio arrives in one go, ms: an HLS segment's length; absent or 0 for a continuous stream. */
  chunkMs?: number;
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
  /** The live queue of the stream playing: how far behind live, the cushion, catch-ups, drift (null when idle). */
  live: LiveQueueStats | null;
}

/** The minimal voice surface a session needs; faked in tests. */
export interface VoiceLink extends EventEmitter<VoiceLinkEvents> {
  readonly channelId: string;
  readonly ready: boolean;
  /** Plays Ogg Opus from `stream` through a live queue (src/voice/live-queue.ts). */
  play(stream: Readable, options?: PlayOptions): void;
  stopAudio(): void;
  /** Milliseconds of audio the player has sent for the current resource. */
  playbackMs(): number;
  playerStatus(): string;
  /** Debug information about the encryption/DAVE state where exposed. */
  encryption(): string;
  stats(): VoiceLinkStats;
  /**
   * Starts keeping the latest RTCP Receiver Report from Discord's voice server (one slot,
   * src/voice/receiver-report.ts). Idempotent. Only while `/radio stats` is open.
   */
  armReports(): void;
  /** Stops listening and forgets the report. Idempotent. */
  disarmReports(): void;
  /** Decrypts and reads the latest report, now. */
  receiverReport(): Promise<ReceiverReportReading>;
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

const noop = () => {};

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
 * DAVE end-to-end encryption enabled. Input is already Ogg Opus: the live queue demuxes it into
 * packets and the player sends them as they are — there is no second encode (PRD FR-007, NFR-06).
 *
 * While the voice connection is not ready (a voice WebSocket resume, a reconnect, a move) the
 * library sends nothing, and the player plays on regardless (`NoSubscriberBehavior.Play`): it reads
 * the station's audio and drops it, so playback stays at the live edge and the listener hears a
 * gap, never a growing delay.
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
  /** The live queue of the stream playing (its source's packets, waiting for the player). */
  #queue: LiveQueue | null = null;
  #expectingAudio = false;
  #reconnecting = false;
  #destroyed = false;
  readonly #timing = new PacketTiming();
  /**
   * The interruption in progress. `skippedMs` adds up the time the player actually spent playing
   * (reading and dropping), from its own state changes, so a Stop, a new station or playback that
   * starts part-way through is counted as it happened.
   */
  #outage: {
    since: number;
    skippedMs: number;
    /** When the player entered its current status during the outage. */
    mark: number;
  } | null = null;
  /** The close code of the voice WebSocket that closed last, read when the interruption begins. */
  #closeCode: number | null = null;
  /** The voice WebSocket in use; a close from one the library has already replaced is ignored. */
  #socket: object | null = null;
  readonly #watchedSockets = new WeakSet<object>();
  /**
   * Discord's receiver reports, while `/radio stats` is open: the voice socket's listener and its
   * one slot, and the channel it was armed in. Null (no listener at all) the rest of the time.
   */
  #reports: { tap: ReceiverReportTap; channelId: string } | null = null;

  private constructor(connection: VoiceConnection, channelId: string) {
    super();
    this.connection = connection;
    this.#initialChannelId = channelId;
    this.player = createAudioPlayer({
      // Off: with it on, every player state change builds two JSON strings that nothing reads.
      debug: false,
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
      // A resume, a reconnect or a move: the report reader stops; the next Refresh starts it again.
      if (this.#reports && (!ready || this.channelId !== this.#reports.channelId)) this.disarmReports();
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
    try {
      this.player.stop(true);
    } catch {
      /* ignore */
    }
    this.#endQueue();
    this.disarmReports();
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
   * The connection stopped being ready. While it isn't, the library sends nothing; the player
   * plays on, reading the station's audio and dropping it, so playback stays live. Nothing is held.
   */
  #interrupted(state: VoiceConnectionState): void {
    const net = 'networking' in state ? state.networking?.state : undefined;
    const resuming = net?.code === NetworkingStatusCode.Resuming;
    const closeCode = this.#closeCode;
    this.#closeCode = null;
    const now = Date.now();
    this.#outage = { since: now, skippedMs: 0, mark: now };
    this.emit('interrupted', { status: state.status, resuming, closeCode });
  }

  /**
   * Ready again. The listener has just heard a gap, so the live queue drops any audio that piled up
   * past its cushion now, where the cut is hidden, rather than as a cut of its own later.
   */
  #restored(): void {
    this.#account(this.player.state.status);
    const outage = this.#outage!;
    this.#outage = null;
    this.#closeCode = null;
    const afterMs = Math.max(0, Date.now() - outage.since);
    const caughtUpMs = this.#queue?.catchUp('resume') ?? 0;
    this.emit('restored', { afterMs, skippedMs: outage.skippedMs, caughtUpMs });
  }

  /**
   * During an outage, adds the time since the last mark to the audio skipped if the player was
   * playing (reading and dropping) through it.
   */
  #account(status: AudioPlayerStatus): void {
    const outage = this.#outage!;
    const now = Date.now();
    const spent = Math.max(0, now - outage.mark);
    outage.mark = now;
    if (status === AudioPlayerStatus.Playing) outage.skippedMs += spent;
  }

  /** Lets go of the live queue, which closes the stream it reads (after the player has moved on). */
  #endQueue(): void {
    const queue = this.#queue;
    this.#queue = null;
    if (queue && !queue.destroyed) queue.destroy();
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

  /**
   * Plays the Ogg Opus in `stream` through a new live queue, which reads it eagerly and hands the
   * player one packet per 20 ms frame (`StreamType.Opus`: no further processing in the library).
   */
  play(stream: Readable, options?: PlayOptions): void {
    const previous = this.#queue;
    const queue = liveQueueFrom(stream, {
      chunkMs: options?.chunkMs,
      onCatchUp: (event) => {
        if (this.#queue === queue) this.emit('caughtUp', event);
      },
    });
    // The player reports the queue's errors while it plays it; this only keeps a late one from throwing.
    queue.on('error', noop);
    const resource = createAudioResource(queue, { inputType: StreamType.Opus, inlineVolume: false });
    this.#queue = queue;
    this.#resource = resource;
    this.#expectingAudio = true;
    this.player.play(resource);
    // Only now that the player has moved on to the new resource: the old one ending is no news.
    if (previous && !previous.destroyed) previous.destroy();
  }

  stopAudio(): void {
    this.#expectingAudio = false;
    this.player.stop(true);
    this.#resource = null;
    this.#endQueue();
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
      live: this.#queue?.stats() ?? null,
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

  /** The voice UDP socket while the connection is ready, else null. */
  #readySocket(): ReportSocket | null {
    const state = this.connection.state;
    if (state.status !== VoiceConnectionStatus.Ready) return null;
    const net = state.networking.state;
    if (net.code !== NetworkingStatusCode.Ready) return null;
    const udp = 'udp' in net ? (net.udp as unknown) : undefined;
    return udp instanceof EventEmitter ? (udp as ReportSocket) : null;
  }

  armReports(): void {
    if (this.#destroyed) return;
    const socket = this.#readySocket();
    if (!socket) return;
    const current = this.#reports;
    if (current?.tap.socket === socket && current.channelId === this.channelId) return;
    this.disarmReports();
    this.#reports = { tap: new ReceiverReportTap(socket), channelId: this.channelId };
  }

  disarmReports(): void {
    this.#reports?.tap.close();
    this.#reports = null;
  }

  async receiverReport(): Promise<ReceiverReportReading> {
    const armed = this.#reports;
    if (!armed) return { state: 'off' };
    // Moved on since it was armed (resumed, reconnected, moved): that socket's reports no longer apply.
    if (this.#readySocket() !== armed.tap.socket || this.channelId !== armed.channelId) {
      this.disarmReports();
      return { state: 'off' };
    }
    const latest = armed.tap.latest();
    if (!latest) return { state: 'waiting' };
    const state = this.connection.state;
    const net = state.status === VoiceConnectionStatus.Ready ? state.networking.state : null;
    const data = (net && 'connectionData' in net ? net.connectionData : null) as {
      encryptionMode?: string;
      secretKey?: Uint8Array;
      ssrc?: number;
      sequence?: number;
      packetsPlayed?: number;
    } | null;
    if (!data?.encryptionMode || !data.secretKey) {
      return { state: 'unreadable', reason: 'the connection has no encryption key yet' };
    }
    const block = await openReceiverReport(latest.packet, data.encryptionMode, data.secretKey, data.ssrc);
    if (!block) {
      return { state: 'unreadable', reason: `it could not be decrypted (${data.encryptionMode})` };
    }
    const sequence =
      typeof data.sequence === 'number' && typeof data.packetsPlayed === 'number'
        ? { next: data.sequence, sent: data.packetsPlayed }
        : null;
    return { state: 'ok', report: summarise(block, latest.ageMs, sequence) };
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
    try {
      this.player.stop(true);
    } catch {
      /* ignore */
    }
    this.#endQueue();
    this.disarmReports();
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
