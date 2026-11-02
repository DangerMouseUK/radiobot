import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import {
  type AudioPlayer,
  AudioPlayerStatus,
  type AudioResource,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
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
}

export interface VoiceLinkStats {
  /** Round trip of the voice WebSocket heartbeat, ms. */
  wsPingMs: number | null;
  /** Discord voice server endpoint host (e.g. "c-lhr05-….discord.media"). */
  endpoint: string | null;
  /** Opus packets sent to Discord on this connection. */
  packetsPlayed: number | null;
  /** Packets sent late while playing since the bot joined, and the longest gap between two. */
  packetTiming: PacketTimingSummary;
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

/**
 * Frames without audio before the player gives up on a resource (20 ms each, so 25 s). It must
 * outlast the session watchdog (15 s stall threshold, checked every 5 s), so an output gap is
 * reported as STREAM_STALLED by the watchdog rather than ending the resource as STREAM_EOF.
 */
export const MAX_MISSED_FRAMES = 1250;

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

    this.#onConnectionState = (_old, state) => {
      if (state.status !== VoiceConnectionStatus.Ready) this.#timing.pause();
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
    this.#subscription?.unsubscribe();
    this.#releaseTiming();
    if (this.#onConnectionState) this.connection.off('stateChange', this.#onConnectionState);
    if (this.#onConnectionError) this.connection.off('error', this.#onConnectionError);
    this.removeAllListeners();
  }

  static async connect(channel: VoiceBasedChannel, timeoutMs = 20_000): Promise<DiscordVoiceLink> {
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
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
    return new DiscordVoiceLink(connection, channel.id);
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
      encryptionMode,
      status: state.status,
    };
  }

  #releaseTiming(): void {
    if (packetTimings.get(this.connection) === this.#timing) packetTimings.delete(this.connection);
  }

  encryption(): string {
    const code = this.connection.voicePrivacyCode;
    return code
      ? `DAVE end-to-end encrypted (privacy code ${code})`
      : 'Transport-encrypted; DAVE not negotiated for this call';
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
    this.#releaseTiming();
    if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) this.connection.destroy();
    if (this.#onConnectionError) this.connection.off('error', this.#onConnectionError);
    this.#markLost('destroyed');
    this.removeAllListeners();
  }
}

export const discordVoiceLinkFactory: VoiceLinkFactory = (channel) => DiscordVoiceLink.connect(channel);
