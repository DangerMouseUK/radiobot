import type { Readable } from 'node:stream';
import { type EncoderPlan, planEncoder, sourceBitrate } from '../audio/encoder.ts';
import type { PipelineStats } from '../audio/pipeline.ts';
import type { StationSource } from '../catalogue/types.ts';
import type { IdleMode } from '../config/env.ts';
import { type Logger, safeErr } from '../observability/logger.ts';
import type { FaultDomain, Metrics } from '../observability/metrics.ts';
import { LatencySeries, type LatencySummary } from '../observability/netstats.ts';
import type { DesiredState, GuildRepository } from '../persistence/repositories/guilds.ts';
import type { StationRepository } from '../persistence/repositories/stations.ts';
import { backoffDelayMs } from '../shared/backoff.ts';
import { errorCode, isRadioError, type RadioError, type ReasonCode } from '../shared/errors.ts';
import type { NowPlayingMeta, SourceInput } from '../streams/input.ts';
import { compareFidelity, type SelectionResult, transportTier } from '../streams/ranking.ts';
import type { PlayOptions, VoiceLink, VoiceLinkStats } from './link.ts';
import type { LiveQueueStats } from './live-queue.ts';
import type { PacketTimingSummary } from './packet-timing.ts';
import { canTransition, isAudioActive, type PlaybackState } from './state-machine.ts';

/** What a session needs from an audio pipeline (AudioPipeline in production, fakes in tests). */
export interface PipelineLike {
  readonly output: Readable;
  readonly stats: PipelineStats;
  readonly plan: EncoderPlan;
  readonly input: SourceInput;
  readonly stderrTail: string[];
  on(event: 'failed', fn: (err: RadioError) => void): unknown;
  on(event: 'metadata', fn: (m: NowPlayingMeta | null) => void): unknown;
  once(event: 'firstAudio', fn: () => void): unknown;
  off(event: 'firstAudio', fn: () => void): unknown;
  stop(): void;
}

export interface SourceSelector {
  prepareForPlayback(
    guildId: string,
    stationId: string,
    opts: { exclude?: ReadonlySet<string>; signal?: AbortSignal },
  ): Promise<SelectionResult>;
  recordPlaybackSuccess(sourceId: string): void;
  recordPlaybackFailure(sourceId: string, code: string): boolean;
  /** Re-checks the station's other due sources in the background, once playback is stable. */
  refreshStation?(stationId: string, playingSourceId?: string): void;
  /** A stream is starting: background checks wait this long, so they don't compete with it. */
  holdBackground?(ms: number): void;
  /** A stream has its first audio: automatic background work waits this long, while it settles. */
  settleBackground?(ms: number): void;
  /** The current choice for a station, without checking anything (for moving back to a better source). */
  select?(guildId: string, stationId: string): SelectionResult;
}

export type SessionNoticeKind =
  | 'recovered'
  | 'failover'
  | 'degraded'
  | 'error'
  | 'kicked'
  | 'idle-left'
  | 'info';

/** Why playback stopped, for the log: a listener's Stop, or its station going away. */
export type StopReason = 'command' | 'station_removed' | 'pack_removed';

/** Why the bot left its voice channel, for the log. */
export type LeaveReason =
  | 'command'
  | 'channel_empty'
  | 'idle_after_stop'
  | 'channel_deleted'
  | 'moved_disallowed';

export interface SessionNotice {
  guildId: string;
  kind: SessionNoticeKind;
  code: ReasonCode | null;
  message: string;
}

export interface SessionTimings {
  stallMs: number;
  firstAudioTimeoutMs: number;
  lagMs: number;
  /** Playback this long counts as steady: the source's success is recorded and retries reset. */
  stableMs: number;
  /**
   * After a stream's first audio, automatic background work (checks of other sources, scheduled
   * syncs, the daily pack check) waits this long, so nothing competes with it while the
   * listener's client settles its buffer. This stream's own source refresh waits for it too.
   */
  backgroundSettleMs: number;
  noSourceRetryMs: number;
  /** The first retries when no source can play, each capped at noSourceRetryMs; then every noSourceRetryMs. */
  noSourceBackoff: readonly number[];
  stoppedIdleLeaveMs: number;
  emptyLeaveMs: number;
  emptyPauseMs: number;
  watchdogIntervalMs: number;
  /** How often a steady stream looks for a better source or a higher bitrate to move to. */
  upgradeCheckMs: number;
  /** The least time between two automatic moves (a failover, a move back, a re-encode). */
  autoSwitchMinIntervalMs: number;
  backoff: readonly number[];
  reconnectBackoff: readonly number[];
}

export const DEFAULT_TIMINGS: SessionTimings = {
  stallMs: 15_000,
  firstAudioTimeoutMs: 20_000,
  lagMs: 45_000,
  stableMs: 30_000,
  backgroundSettleMs: 180_000,
  noSourceRetryMs: 120_000,
  noSourceBackoff: [15_000, 30_000, 60_000],
  stoppedIdleLeaveMs: 5 * 60_000,
  emptyLeaveMs: 60_000,
  emptyPauseMs: 30_000,
  watchdogIntervalMs: 5_000,
  upgradeCheckMs: 60_000,
  autoSwitchMinIntervalMs: 10 * 60_000,
  backoff: [1_000, 3_000, 8_000],
  reconnectBackoff: [2_000, 5_000, 10_000, 30_000, 60_000],
};

export interface SessionDeps {
  guildId: string;
  sources: SourceSelector;
  stations: Pick<StationRepository, 'getStation' | 'getSource'>;
  guilds: Pick<GuildRepository, 'getSettings' | 'getIntent' | 'setIntent'>;
  openInput: (source: StationSource, signal: AbortSignal) => Promise<SourceInput>;
  createPipeline: (input: SourceInput, plan: EncoderPlan) => PipelineLike;
  connect: (channelId: string) => Promise<VoiceLink>;
  channelBitrate: (channelId: string) => number | null;
  /** Non-bot members in a voice channel, or null when unknown; used to apply idle modes on join. */
  countListeners?: (channelId: string) => number | null;
  /**
   * Called just before the session leaves its voice channel. A returned promise keeps the voice
   * connection open until it settles (at most LEAVE_GRACE_MS), so work that needs the bot to
   * still be in the channel, such as clearing its status, can finish first.
   */
  onLeaving?: (channelId: string) => Promise<void> | void;
  /** Whether another stream fits MAX_ACTIVE_GUILD_STREAMS (asked before a non-streaming session starts). */
  mayStream?: () => boolean;
  /** Opus ceiling: `maximum` follows the source's bitrate up to it (MAX_OPUS_BITRATE_KBPS). */
  maxOpusKbps?: number;
  notify: (notice: SessionNotice) => void;
  logger: Logger;
  metrics: Metrics;
  timings?: Partial<SessionTimings>;
  random?: () => number;
}

export interface StartResult {
  ok: boolean;
  code: ReasonCode | null;
  message: string;
  selection: SelectionResult | null;
  plan: EncoderPlan | null;
  /** The start failed, but a retry or failover of the same request is already running. */
  retrying?: boolean;
}

/** Detailed, live measurements for the admin stats panel (FR-014). */
export interface SessionLiveStats {
  connectedSince: number | null;
  input: null | {
    requestedHost: string;
    finalHost: string;
    remoteAddress: string | null;
    remotePort: number | null;
    redirects: string[];
    transport: string;
    segmentHost: string | null;
    segmentsFetched: number;
    segmentFailures: number;
    skippedSegments: number;
    kbps10s: number | null;
    kbps60s: number | null;
    bytes: number;
  };
  output: null | {
    targetKbps: number;
    channelBitrateKbps: number | null;
    /** Ogg Opus read from the encoder (before the live queue drops any), rolling 10 s. */
    kbps10s: number | null;
    kbps60s: number | null;
    bytes: number;
  };
  voice: null | {
    endpoint: string | null;
    status: string;
    encryption: string;
    encryptionMode: string | null;
    packetsPlayed: number | null;
    /** Packets per second sent to Discord over the last sampling window (expect ~50). */
    packetsPerSecond: number | null;
    /** Packets sent more than 40 ms after the one before, while playing, and the longest gap. */
    latePackets: number;
    worstPacketGapMs: number | null;
    /** The last few late packets (wall-clock time, gap in ms), oldest first. */
    recentLatePackets: PacketTimingSummary['recent'];
    /**
     * Silence the voice player has filled in for the current stream because no audio was ready,
     * in ms (null when not playing), and how much of it over the last sampling window (about a
     * minute; null until two samples of the same stream exist).
     */
    silenceMs: number | null;
    recentSilenceMs: number | null;
    /** The live queue of the stream playing: delay, cushion, catch-ups, drift (null when idle). */
    live: LiveQueueStats | null;
    ws: LatencySummary | null;
  };
}

export interface SessionStatus {
  guildId: string;
  state: PlaybackState;
  desiredState: DesiredState;
  stationId: string | null;
  channelId: string | null;
  source: StationSource | null;
  selection: SelectionResult | null;
  plan: EncoderPlan | null;
  startedAt: number | null;
  nowPlaying: NowPlayingMeta | null;
  lastError: { code: ReasonCode; message: string; at: string } | null;
  failovers: number;
  reconnects: number;
  inputBytes: number;
  outputBytes: number;
  observedOutputKbps: number | null;
  observedInputKbps: number | null;
  encryption: string | null;
  inputTransport: string | null;
  inputHost: string | null;
  hls: SourceInput['info']['hls'];
  encoderPid: number | null;
  ffmpegWarnings: string[];
  /** A source a listener chose for this station, which overrides the automatic choice. */
  manualSourceId: string | null;
}

// NOT_FOUND is retried: an Icecast server answers 404 for a few seconds while the station's own
// encoder reconnects to it, and that blip must not switch source or silence the station.
const NON_RETRYABLE: ReadonlySet<ReasonCode> = new Set([
  'ACCESS_DENIED',
  'IDENTITY_MISMATCH',
  'HLS_ENCRYPTED',
  'ADDRESS_BLOCKED',
  'URL_HOST_NOT_ALLOWED',
  'URL_PORT_NOT_ALLOWED',
  'URL_SCHEME_NOT_ALLOWED',
  'URL_CREDENTIALS_NOT_ALLOWED',
  'CONTENT_TYPE_REJECTED',
]);

function faultDomain(code: ReasonCode): FaultDomain {
  if (code.startsWith('VOICE_')) return 'discord';
  if (code === 'FFMPEG_SPAWN' || code === 'INTERNAL') return 'bot';
  if (code === 'NO_ELIGIBLE_SOURCE' || code === 'STREAM_LIMIT') return 'operator';
  return 'upstream';
}

/**
 * The source's figures, corrected by the stream actually opened. HLS playback and the source
 * check each take the best rendition that loads; when this playback got a clearly higher one
 * than the check could (its declared bandwidth well above the stored figure), the encoder follows
 * that rendition, so it is never encoded at a lower rendition's rate.
 */
export function withOpenedBitrate(source: StationSource, input: Pick<SourceInput, 'info'>): StationSource {
  if (source.transport !== 'hls') return source;
  const declared = input.info.advertisedBitrateKbps;
  const stored = sourceBitrate(source)?.kbps ?? null;
  // A declared bandwidth includes a little container overhead (under 10 %), so only a bigger step
  // up means another rendition. Erring upwards only ever costs a few kbps, never quality.
  if (typeof declared !== 'number' || stored === null || declared <= stored * 1.15) return source;
  return {
    ...source,
    measuredBitrateKbps: null,
    codecBitrateKbps: null,
    advertisedBitrateKbps: declared,
    bitrateConfidence: 'manifest',
  };
}

/**
 * How a stream is played: how much audio arrives in one go. A direct stream arrives as the station
 * sends it (no chunk). HLS arrives a segment at a time: the reader polls the playlist at half the
 * target duration and fetches each new segment whole, so the queue gets a segment's worth of audio
 * about once per target duration, and nothing in between. The live queue keeps that chunk plus its
 * own safety margin as the cushion, and clamps the chunk itself.
 */
export function playOptionsFor(input: Pick<SourceInput, 'info'>): PlayOptions {
  const targetDuration = input.info.hls?.targetDuration;
  if (typeof targetDuration !== 'number' || !(targetDuration > 0)) return {};
  return { chunkMs: Math.round(targetDuration * 1000) };
}

/**
 * One guild's playback session: owns at most one voice link and one audio pipeline, drives
 * the PRD §9 state machine, and keeps desired state (persisted) apart from runtime state.
 * Every async step checks a generation counter so a newer command supersedes older ones.
 */
export class GuildSession {
  readonly guildId: string;
  readonly #d: SessionDeps;
  readonly #t: SessionTimings;
  readonly #log: Logger;
  #state: PlaybackState = 'IDLE';
  #gen = 0;
  /** Counts commands (play, join, stop, leave, destroy); internal retries don't change it. */
  #commands = 0;
  /**
   * A source a listener chose for the station that is playing. It holds through reconnects and
   * restarts of the same station, and is dropped when the station changes or the source fails.
   */
  #manualSourceId: string | null = null;
  #runId = 0;
  #runAbort: AbortController | null = null;
  #link: VoiceLink | null = null;
  #pipeline: PipelineLike | null = null;
  #source: StationSource | null = null;
  #selection: SelectionResult | null = null;
  #stationId: string | null = null;
  #channelId: string | null = null;
  #startedAt: number | null = null;
  #nowPlaying: NowPlayingMeta | null = null;
  #lastError: SessionStatus['lastError'] = null;
  #attempts = 0;
  #excluded = new Set<string>();
  #failovers = 0;
  #reconnects = 0;
  #voiceReconnectAttempts = 0;
  /** Retries in a row that found no source to play; the first few come sooner. */
  #noSourceRetries = 0;
  /**
   * Live-lag bookkeeping for the current run: time already made up by the HLS reader skipping
   * forward to the live edge, and the reader's skip count when that was last taken into account.
   */
  #lagCaughtUpMs = 0;
  #lagSkips = 0;
  /** When the bot last moved this stream by itself (failover, move back, re-encode), and last looked. */
  #lastAutoSwitchAt = 0;
  #lastUpgradeCheckAt = 0;
  /**
   * Sources this stream failed over away from, with how often and until when the bot won't move
   * back to them. Each failure doubles the wait, so a source that keeps dropping isn't retried
   * every 10 minutes forever. At most one entry per source of the playing station.
   */
  readonly #moveBackHolds = new Map<string, { failures: number; until: number }>();
  /** The run was a move back to a better source and hasn't proved itself yet (no steady playback). */
  #upgradeUnproven = false;
  #watchdog: NodeJS.Timeout | null = null;
  #stableTimer: NodeJS.Timeout | null = null;
  #retryTimer: NodeJS.Timeout | null = null;
  #idleTimer: NodeJS.Timeout | null = null;
  #emptyTimer: NodeJS.Timeout | null = null;
  /** The idle mode the pending empty-channel timer was armed for. */
  #emptyMode: IdleMode | null = null;
  #connecting: { channelId: string; promise: Promise<VoiceLink>; waiters: number } | null = null;
  #failingRun = -1;
  #connectedSince: number | null = null;
  #wsPing = new LatencySeries(24);
  /** Watchdog samples of the voice counters (about a minute's worth), for rates in live stats. */
  #packetSamples: Array<{ at: number; packets: number; silenceMs: number | null; run: number }> = [];
  #destroyed = false;

  constructor(deps: SessionDeps) {
    this.guildId = deps.guildId;
    this.#d = deps;
    this.#t = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.#log = deps.logger.child({ guildId: deps.guildId, component: 'session' });
  }

  get state(): PlaybackState {
    return this.#state;
  }

  get channelId(): string | null {
    return this.#link?.channelId ?? this.#channelId;
  }

  get stationId(): string | null {
    return this.#stationId;
  }

  get connected(): boolean {
    return this.#link !== null;
  }

  /** True when this session counts against MAX_ACTIVE_GUILD_STREAMS. */
  get isStreaming(): boolean {
    return isAudioActive(this.#state) || this.#state === 'JOINING';
  }

  #setState(next: PlaybackState): void {
    if (!canTransition(this.#state, next)) {
      this.#log.warn({ from: this.#state, to: next }, 'unexpected state transition');
    }
    if (this.#state !== next) this.#log.debug({ from: this.#state, to: next }, 'state');
    this.#state = next;
  }

  #desired(): DesiredState {
    return this.#d.guilds.getIntent(this.guildId)?.desiredState ?? 'idle';
  }

  #persist(
    desiredState: DesiredState,
    extra: Parameters<GuildRepository['setIntent']>[1] | object = {},
  ): void {
    // What to resume after a restart is worth saving, but never at the cost of the stream: a
    // failed write (a full disk, say) is logged and playback carries on.
    try {
      this.#d.guilds.setIntent(this.guildId, { desiredState, ...extra });
    } catch (err) {
      this.#log.error({ err: safeErr(err) }, 'could not save the playback state');
    }
  }

  // ------------------------------------------------------------------ commands

  /** Start or switch station. Supersedes any pending start. */
  async play(stationId: string, channelId: string, requestedById: string | null): Promise<StartResult> {
    // Asking for the station that is already playing here keeps it playing: a restart would only
    // cut the audio (and drop a listener's chosen source) for nothing.
    if (
      stationId === this.#stationId &&
      this.#state === 'PLAYING' &&
      this.#pipeline &&
      this.#link?.channelId === channelId &&
      this.#desired() === 'playing'
    ) {
      return {
        ok: true,
        code: null,
        message: 'Already playing.',
        selection: this.#selection,
        plan: this.#pipeline.plan,
      };
    }
    this.#commands++;
    this.#gen++;
    this.#clearTimer('retry');
    this.#clearTimer('idle');
    this.#clearTimer('empty');
    this.#stationId = stationId;
    this.#channelId = channelId;
    this.#manualSourceId = null;
    this.#excluded.clear();
    this.#attempts = 0;
    this.#voiceReconnectAttempts = 0;
    this.#noSourceRetries = 0;
    this.#lastAutoSwitchAt = 0;
    this.#moveBackHolds.clear();
    this.#upgradeUnproven = false;
    this.#persist('playing', {
      desiredStationId: stationId,
      desiredVoiceChannelId: channelId,
      lastRequestedAt: new Date().toISOString(),
      lastRequestedById: requestedById,
      lastErrorCode: null,
    });
    return this.#start(this.#gen, {});
  }

  /**
   * Plays the current station from another of its usable sources, chosen by a listener. It lasts
   * until the station changes; if the source fails, the bot goes back to choosing automatically.
   * The caller checks that the source belongs to the playing station and is usable.
   */
  async useSource(stationId: string, sourceId: string): Promise<StartResult> {
    // Checked here as well as by the caller: a stop, or another station, may have come in
    // between. A stop is authoritative; a source choice never restarts playback.
    if (this.#stationId !== stationId || this.#desired() !== 'playing') {
      return {
        ok: false,
        code: 'CANCELLED',
        message: 'That station isn’t playing any more, so its source can’t be changed.',
        selection: null,
        plan: null,
      };
    }
    this.#commands++;
    this.#gen++;
    this.#clearTimer('retry');
    this.#manualSourceId = sourceId;
    this.#excluded.clear();
    this.#attempts = 0;
    return this.#start(this.#gen, { forceSourceId: sourceId, reason: 'manual' });
  }

  /** The source a listener chose for this station, if any. */
  get manualSourceId(): string | null {
    return this.#manualSourceId;
  }

  /** Joins without playing (used by /radio join without a default station). */
  async join(channelId: string): Promise<void> {
    if (
      this.#link?.channelId === channelId &&
      this.#link.ready &&
      (isAudioActive(this.#state) || this.#state === 'JOINING')
    ) {
      return; // already here and playing: leave the audio alone
    }
    this.#commands++;
    this.#gen++;
    const gen = this.#gen;
    const moving = this.#link !== null && this.#link.channelId !== channelId;
    this.#channelId = channelId;
    if (moving && this.#stationId && this.#desired() === 'playing') {
      // Bring the current station along rather than orphaning its pipeline.
      this.#persist('playing', { desiredVoiceChannelId: channelId });
      await this.#start(gen, { reason: 'join' });
      return;
    }
    this.#teardownAudio();
    await this.#ensureLink(gen, channelId);
    if (gen !== this.#gen) return;
    this.#setState('CONNECTED');
    this.#persist(this.#desired() === 'playing' ? 'playing' : 'idle', { desiredVoiceChannelId: channelId });
    this.#armStoppedIdleLeave();
    this.#recheckListeners();
  }

  /** Explicit stop: authoritative, suppresses auto-resume (PRD §9.1). Keeps the voice link briefly. */
  stop(reason: StopReason = 'command'): void {
    this.#log.info({ reason, state: this.#state, stationId: this.#stationId }, 'stopping playback');
    this.#commands++;
    this.#gen++;
    this.#persist('stopped');
    this.#clearTimer('retry');
    this.#clearTimer('empty'); // a pending pause would otherwise overwrite 'stopped'
    if (this.#pipeline || isAudioActive(this.#state)) this.#setState('STOPPING');
    this.#teardownAudio();
    this.#setState(this.#link ? 'CONNECTED' : 'IDLE');
    this.#armStoppedIdleLeave();
  }

  /** Explicit leave: disconnect and cancel auto-rejoin until the next explicit play. */
  leave(desired: DesiredState = 'left', reason: LeaveReason = 'command'): void {
    this.#log.info(
      { reason, desired, state: this.#state, channelId: this.#link?.channelId ?? this.#channelId },
      'leaving the voice channel',
    );
    this.#commands++;
    this.#gen++;
    const gen = this.#gen;
    this.#persist(desired);
    this.#clearAllTimers();
    if (this.#state !== 'IDLE') this.#setState('LEAVING');
    this.#teardownAudio();
    const link = this.#link;
    const pending = link ? this.#d.onLeaving?.(link.channelId) : undefined;
    this.#setState('IDLE');
    if (!(pending instanceof Promise)) {
      this.#teardownLink();
      return;
    }
    // Discord refuses to change a channel's status once the bot has left it, so the hook's work
    // finishes first. A command in the meantime (a new play) takes over the still-open link.
    const disconnect = () => {
      if (gen === this.#gen && this.#link === link) this.#teardownLink();
    };
    void Promise.race([pending.catch(() => {}), sleep(LEAVE_GRACE_MS)]).then(disconnect);
  }

  /** Shutdown/guild removal: release resources without touching the persisted desired state. */
  destroy(): void {
    this.#destroyed = true;
    this.#commands++;
    this.#gen++;
    this.#clearAllTimers();
    this.#teardownAudio();
    this.#teardownLink();
    this.#state = 'IDLE';
  }

  // ------------------------------------------------------------------ external events

  /** Number of non-bot members in the bot's channel changed. Implements idle modes (FR-012). */
  onListenersChanged(humans: number): void {
    if (!this.#link) return;
    const { idleMode } = this.#d.guilds.getSettings(this.guildId);
    const desired = this.#desired();
    if (humans > 0) {
      this.#clearTimer('empty');
      if (desired === 'paused_empty' && this.#stationId) {
        this.#log.info('listener returned; resuming');
        this.#persist('playing');
        this.#gen++;
        this.#excluded.clear();
        this.#attempts = 0;
        void this.#start(this.#gen, {});
      }
      return;
    }
    if (this.#emptyTimer && this.#emptyMode === idleMode) return;
    // An admin changed the idle mode while a timer was pending: that timer no longer applies.
    this.#clearTimer('empty');
    if (idleMode === '24x7') return;
    this.#emptyMode = idleMode;
    if (idleMode === 'leave_when_empty') {
      this.#emptyTimer = setTimeout(() => {
        this.#emptyTimer = null;
        // An explicit stop stays authoritative, so autostart doesn't fire on the next boot.
        this.leave(this.#desired() === 'stopped' ? 'stopped' : 'idle', 'channel_empty');
        this.#d.notify({
          guildId: this.guildId,
          kind: 'idle-left',
          code: null,
          message: 'Left the voice channel because nobody was listening.',
        });
      }, this.#t.emptyLeaveMs);
    } else if (idleMode === 'pause_when_empty' && desired === 'playing') {
      this.#emptyTimer = setTimeout(() => {
        this.#emptyTimer = null;
        if (this.#desired() !== 'playing') return;
        this.#log.info('voice channel empty; pausing stream');
        this.#gen++;
        this.#persist('paused_empty');
        this.#teardownAudio();
        this.#setState('CONNECTED');
      }, this.#t.emptyPauseMs);
    }
  }

  /** Applies the idle mode to the channel as it is now: the bot's own join raises no listener event. */
  #recheckListeners(): void {
    const channelId = this.channelId;
    const humans = channelId && this.#d.countListeners ? this.#d.countListeners(channelId) : null;
    if (humans !== null) this.onListenersChanged(humans);
  }

  /** The bot was moved to another channel by someone else (already validated by the caller). */
  onMoved(newChannelId: string): void {
    this.#channelId = newChannelId;
    if (this.#desired() === 'playing' || this.#desired() === 'paused_empty') {
      this.#persist(this.#desired(), { desiredVoiceChannelId: newChannelId });
    }
  }

  /**
   * Quality settings changed: rebuild the encoder if the Opus target changed (PRD §8.3). Returns
   * true when it did, which means a brief cut, so the admin can be told.
   */
  refreshEncoder(): boolean {
    if (!this.#pipeline || !this.#source || this.#state !== 'PLAYING') return false;
    const plan = this.#plan(this.#source);
    if (plan.targetKbps === this.#pipeline.plan.targetKbps) return false;
    this.#log.info(
      { from: this.#pipeline.plan.targetKbps, to: plan.targetKbps },
      'encoder settings changed; re-encoding',
    );
    this.#gen++;
    void this.#start(this.#gen, { forceSourceId: this.#source.id, reason: 'reconfigure' });
    return true;
  }

  // ------------------------------------------------------------------ core start

  #plan(source: StationSource): EncoderPlan {
    const settings = this.#d.guilds.getSettings(this.guildId);
    const channelId = this.channelId;
    return planEncoder({
      qualityMode: settings.qualityMode,
      manualBitrateKbps: settings.manualBitrateKbps,
      maxKbps: this.#d.maxOpusKbps,
      sourceBitrate: sourceBitrate(source),
      channelBitrateBps: channelId ? this.#d.channelBitrate(channelId) : null,
      sourceSampleRateHz: source.sampleRateHz,
      sourceChannels: source.channels,
    });
  }

  /**
   * Ensures a ready voice link to `channelId`. Concurrent callers for the same channel share
   * one connect attempt (@discordjs/voice keeps one connection per guild, so two parallel
   * joins would wrap the same connection). A superseded caller never destroys a link that a
   * newer caller is waiting for. A failed connect leaves the session IDLE, not JOINING.
   */
  async #ensureLink(gen: number, channelId: string): Promise<boolean> {
    if (this.#link && this.#link.channelId === channelId && this.#link.ready) {
      // A leave stops the watchdog but can keep the link open for its onLeaving hook; a play in
      // that window takes the link over, and must not play without stall detection.
      if (!this.#watchdog) this.#startWatchdog();
      return true;
    }
    if (this.#link) this.#teardownLink();
    this.#setState('JOINING');
    let pending = this.#connecting;
    if (!pending || pending.channelId !== channelId) {
      const entry = { channelId, promise: this.#d.connect(channelId), waiters: 0 };
      void entry.promise
        .catch(() => {})
        .finally(() => {
          if (this.#connecting === entry) this.#connecting = null;
        });
      this.#connecting = entry;
      pending = entry;
    }
    pending.waiters++;
    let link: VoiceLink;
    try {
      link = await pending.promise;
    } catch (err) {
      pending.waiters--;
      if (gen === this.#gen) this.#setState(this.#link ? 'CONNECTED' : 'IDLE');
      throw err;
    }
    pending.waiters--;
    if (this.#link === link) return gen === this.#gen && !this.#destroyed;
    if (this.#destroyed) {
      link.destroy();
      return false;
    }
    if (gen !== this.#gen) {
      if (pending.waiters > 0) return false; // a newer request awaits this same link and adopts it
      const newer = this.#connecting !== null && this.#connecting !== pending;
      if (newer || this.#link) link.detach();
      else link.destroy();
      if (!this.#link && this.#state === 'JOINING' && !newer) this.#setState('IDLE');
      return false;
    }
    this.#link = link;
    this.#connectedSince = Date.now();
    this.#wsPing = new LatencySeries(24);
    this.#packetSamples = [];
    link.on('lost', (reason) => this.#onLinkLost(link, reason));
    link.on('reconnected', () => {
      this.#reconnects++;
      this.#d.metrics.inc('voice.reconnected');
      // A new voice connection counts its packets from zero: rates start again from its samples.
      this.#packetSamples = [];
    });
    link.on('connectionError', (err) => this.#log.warn({ err: safeErr(err) }, 'voice connection error'));
    // Rare, and each one a brief gap in the audio, so worth seeing at info level.
    link.on('interrupted', (info) => {
      this.#d.metrics.inc('voice.interrupted');
      this.#log.info(
        info,
        info.resuming ? 'voice connection resuming' : 'voice connection interrupted; reconnecting',
      );
    });
    // `skippedMs`: audio the player dropped while the connection was down (playback stays live);
    // `caughtUpMs`: the backlog the live queue dropped at the same moment, back to its cushion.
    link.on('restored', (info) => this.#log.info(info, 'voice connection ready again'));
    // At most a few per stream (the start and its settle, then network gaps, resumes, a fast station clock),
    // never per packet. Each one is a moment the listener skipped ahead, so worth seeing at info.
    link.on('caughtUp', (e) => {
      this.#d.metrics.inc('playback.caught_up');
      // A resume's catch-up is in the 'voice connection ready again' line (`caughtUpMs`): once is enough.
      if (e.reason === 'resume') return;
      this.#log.info(
        { reason: e.reason, droppedMs: e.droppedMs, cushionMs: e.cushionMs },
        e.reason === 'start'
          ? 'started behind live by the cushion; dropped the connect burst'
          : 'caught up with live',
      );
    });
    link.on('audioEnded', (err) => {
      if (link !== this.#link) return;
      const code: ReasonCode = err ? 'FFMPEG_EXIT' : 'STREAM_EOF';
      void this.#handleFailure(
        this.#runId,
        code,
        err ? 'The audio player reported an error.' : 'The audio stream ended.',
      );
    });
    this.#startWatchdog();
    this.#setState('CONNECTED');
    return true;
  }

  async #start(gen: number, opts: { forceSourceId?: string; reason?: string }): Promise<StartResult> {
    const stationId = this.#stationId;
    const channelId = this.#channelId;
    if (!stationId || !channelId) {
      return { ok: false, code: 'INTERNAL', message: 'Nothing to play.', selection: null, plan: null };
    }
    if (!this.isStreaming && this.#d.mayStream && !this.#d.mayStream()) {
      return this.#streamLimitReached(gen);
    }
    const commands = this.#commands;
    this.#clearTimer('retry');
    this.#clearTimer('stable');
    const wasPlaying = this.#pipeline !== null;
    if (wasPlaying && this.#state === 'PLAYING') this.#setState('SWITCHING');
    // Tears down the previous run, aborting its probes and requests. The new run's controller is
    // created afterwards: created first, the teardown would abort it and cancel every start.
    this.#teardownAudio();
    // The source belongs to the run that chose it. If this run fails before choosing one, a
    // failure must not be blamed on the last run's source (and fail over from it at once, again
    // and again, if every start keeps failing the same way).
    this.#source = null;
    const abort = new AbortController();
    this.#runAbort = abort;
    try {
      const linked = await this.#ensureLink(gen, channelId);
      if (!linked) return this.#superseded();
      if (this.#state === 'CONNECTED' || this.#state === 'ERROR') this.#setState('BUFFERING');
      else if (this.#state === 'SWITCHING') this.#setState('BUFFERING');
      // Until this stream has played steadily, background checks for any server wait.
      this.#d.sources.holdBackground?.(this.#t.stableMs);

      let selection = await this.#d.sources.prepareForPlayback(this.guildId, stationId, {
        exclude: this.#excluded,
        signal: abort.signal,
      });
      if (gen !== this.#gen) return this.#superseded();
      const force = opts.forceSourceId ?? this.#manualSourceId;
      if (force && selection.selected?.id !== force) {
        const forced = selection.ordered.find((s) => s.id === force);
        if (forced) selection = { ...selection, selected: forced };
        // A listener's choice that can't be used now (cooling down, failing) is dropped, so a
        // later restart doesn't jump back to it.
        else if (force === this.#manualSourceId) this.#manualSourceId = null;
      }
      this.#selection = selection;
      const source = selection.selected;
      if (!source) {
        const station = this.#d.stations.getStation(stationId);
        const msg = `No verified, working source is available for ${station?.displayName ?? stationId} right now.`;
        this.#enterError('NO_ELIGIBLE_SOURCE', msg);
        // A station whose only source blipped comes back within seconds, so look again soon.
        this.#scheduleNoSourceRetry(gen, true);
        return { ok: false, code: 'NO_ELIGIBLE_SOURCE', message: msg, selection, plan: null };
      }
      this.#source = source;
      if (this.#state !== 'BUFFERING') this.#setState('BUFFERING');
      const input = await this.#d.openInput(source, abort.signal);
      if (gen !== this.#gen) {
        input.close();
        return this.#superseded();
      }
      const plan = this.#plan(withOpenedBitrate(source, input));
      let pipeline: PipelineLike;
      try {
        pipeline = this.#d.createPipeline(input, plan);
      } catch (err) {
        input.close();
        throw err;
      }
      const runId = ++this.#runId;
      this.#pipeline = pipeline;
      this.#lagCaughtUpMs = 0;
      this.#lagSkips = 0;
      this.#nowPlaying = null;
      pipeline.on('failed', (err) => void this.#handleFailure(runId, err.code, err.userMessage));
      pipeline.on('metadata', (m) => {
        if (runId !== this.#runId) return;
        if (m?.title !== this.#nowPlaying?.title)
          this.#log.debug({ title: m?.title ?? null }, 'stream title');
        this.#nowPlaying = m;
      });
      this.#link!.play(pipeline.output, playOptionsFor(input));
      this.#startedAt = Date.now();
      const firstAudio = await this.#waitFirstAudio(pipeline, abort.signal);
      if (gen !== this.#gen || runId !== this.#runId) {
        // The source failed before its first audio and recovery took over; no command superseded it.
        const failedHere = this.#failingRun === runId && commands === this.#commands;
        return failedHere && this.#desired() === 'playing'
          ? this.#retrying(selection, plan)
          : this.#superseded();
      }
      if (!firstAudio) {
        void this.#handleFailure(runId, 'STREAM_STALLED', 'No audio arrived from the station in time.');
        return {
          ok: false,
          code: 'STREAM_STALLED',
          message: 'The station did not send any audio in time. Retrying…',
          selection,
          plan,
          retrying: true,
        };
      }
      this.#setState('PLAYING');
      this.#lastUpgradeCheckAt = Date.now(); // the first look for a better source comes a minute in
      // Audio is flowing now; background work waits until it has had time to settle: all of it for
      // stableMs, and the automatic kind (nobody waiting for it) for backgroundSettleMs.
      this.#d.sources.holdBackground?.(this.#t.stableMs);
      this.#d.sources.settleBackground?.(this.#t.backgroundSettleMs);
      this.#lastError = null;
      this.#voiceReconnectAttempts = 0;
      this.#persist('playing', { lastSuccessfulSourceId: source.id, lastErrorCode: null });
      this.#d.metrics.inc('playback.started');
      this.#recheckListeners();
      this.#stableTimer = setTimeout(() => {
        this.#stableTimer = null;
        if (runId !== this.#runId || this.#state !== 'PLAYING') return;
        this.#attempts = 0;
        this.#noSourceRetries = 0;
        this.#upgradeUnproven = false;
        try {
          // The station's other sources are checked later, once the settle period is over (the
          // first look for a better source after it queues them): see #considerUpgrade.
          this.#d.sources.recordPlaybackSuccess(source.id);
        } catch (err) {
          this.#log.error({ err: safeErr(err) }, 'could not record steady playback');
        }
      }, this.#t.stableMs);
      this.#log.info(
        {
          stationId,
          sourceId: source.id,
          reason: opts.reason ?? 'play',
          input: {
            transport: input.info.transport,
            host: input.info.finalHost,
            codec: source.codec,
            profile: source.profile,
            kbps: source.measuredBitrateKbps ?? source.codecBitrateKbps ?? source.advertisedBitrateKbps,
            bitrateEvidence: source.bitrateConfidence,
            sampleRateHz: source.sampleRateHz,
            channels: source.channels,
          },
          output: {
            codec: 'opus',
            sampleRateHz: plan.sampleRateHz,
            channels: plan.channels,
            targetKbps: plan.targetKbps,
            channelBitrateKbps: plan.channelBitrateKbps,
            frameMs: plan.frameMs,
            resampled: plan.resampled,
            lossyEncodes: 1,
          },
        },
        'playing',
      );
      if (this.#failovers > 0 && opts.reason === 'failover') {
        this.#d.notify({
          guildId: this.guildId,
          kind: 'degraded',
          code: null,
          message: `The radio is now playing from a fallback source (${source.label ?? source.id}).`,
        });
      } else if (opts.reason === 'upgrade') {
        this.#d.notify({
          guildId: this.guildId,
          kind: 'recovered',
          code: null,
          message: `A better source is working again, so the radio has moved back to it (${source.label ?? source.id}).`,
        });
      } else if (opts.reason === 'recover') {
        this.#d.notify({
          guildId: this.guildId,
          kind: 'recovered',
          code: null,
          message: 'The stream has recovered and is playing again.',
        });
      }
      return { ok: true, code: null, message: 'Playing.', selection, plan };
    } catch (err) {
      if (gen !== this.#gen) return this.#superseded();
      const code = errorCode(err);
      const message = isRadioError(err)
        ? err.userMessage
        : 'Something went wrong while starting the station.';
      if (code === 'CANCELLED') return this.#superseded();
      if (code.startsWith('VOICE_')) {
        this.#persist('playing', { lastErrorCode: code });
        if (code === 'VOICE_CONNECT_TIMEOUT' || code === 'VOICE_DISCONNECTED') {
          this.#scheduleVoiceReconnect(code, message);
        } else {
          this.#enterError(code, message);
        }
        return { ok: false, code, message, selection: this.#selection, plan: null };
      }
      if (!isRadioError(err)) this.#log.error({ err: safeErr(err) }, 'unexpected start failure');
      void this.#handleFailure(this.#runId, code, message, true);
      return {
        ok: false,
        code,
        message: `${message} Retrying…`,
        selection: this.#selection,
        plan: null,
        retrying: true,
      };
    }
  }

  #retrying(selection: SelectionResult, plan: EncoderPlan): StartResult {
    const code = this.#lastError?.code ?? 'STREAM_EOF';
    const reason = this.#lastError?.message ?? 'The stream failed before any audio arrived.';
    return { ok: false, code, message: `${reason} Retrying…`, selection, plan, retrying: true };
  }

  /**
   * A resume, retry or reconnect found MAX_ACTIVE_GUILD_STREAMS taken by other servers. Waits
   * and tries again, telling the server once rather than on every attempt.
   */
  #streamLimitReached(gen: number): StartResult {
    const message =
      'This bot is already playing in as many servers as its owner allows. I will try again in a couple of minutes.';
    const first = this.#lastError?.code !== 'STREAM_LIMIT';
    this.#teardownAudio();
    this.#lastError = { code: 'STREAM_LIMIT', message, at: new Date().toISOString() };
    if (this.#link) this.#setState('ERROR');
    if (first) {
      this.#d.metrics.incident(this.guildId, 'STREAM_LIMIT', 'operator', message);
      this.#d.notify({ guildId: this.guildId, kind: 'error', code: 'STREAM_LIMIT', message });
    }
    this.#scheduleNoSourceRetry(gen);
    return { ok: false, code: 'STREAM_LIMIT', message, selection: null, plan: null };
  }

  #superseded(): StartResult {
    return {
      ok: false,
      code: 'CANCELLED',
      message: 'Replaced by a newer request.',
      selection: null,
      plan: null,
    };
  }

  /**
   * Resolves true on the encoder's first audio, false on a timeout or when the run is torn down
   * (a failure, a stop or a newer request aborts `signal`). Event-driven: nothing polls.
   */
  #waitFirstAudio(pipeline: PipelineLike, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (pipeline.stats.firstOutputAt !== null || signal.aborted) {
        resolve(pipeline.stats.firstOutputAt !== null);
        return;
      }
      const finish = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', finish);
        pipeline.off('firstAudio', finish);
        resolve(pipeline.stats.firstOutputAt !== null);
      };
      const timer = setTimeout(finish, this.#t.firstAudioTimeoutMs);
      signal.addEventListener('abort', finish, { once: true });
      pipeline.once('firstAudio', finish);
    });
  }

  // ------------------------------------------------------------------ recovery

  /** PRD §9.2: reconnect same source with jittered backoff, then fail over, then error + retry. */
  async #handleFailure(runId: number, code: ReasonCode, message: string, preStart = false): Promise<void> {
    if (!preStart && runId !== this.#runId) return;
    if (this.#failingRun === runId && !preStart) return;
    this.#failingRun = runId;
    const gen = this.#gen;
    if (this.#desired() !== 'playing' || this.#destroyed) return;
    const source = this.#source;
    if (!source) {
      // The start failed before a source was chosen, so there is nothing to fail over from.
      // Starting again at once would repeat the same failure in a tight loop; wait instead.
      this.#log.warn({ code }, 'playback failed before a source was chosen; retrying later');
      this.#enterError(code, message);
      this.#persist('playing', { lastErrorCode: code });
      this.#scheduleNoSourceRetry(gen);
      return;
    }
    this.#teardownAudio();
    this.#lastError = { code, message, at: new Date().toISOString() };
    this.#d.metrics.incident(this.guildId, code, faultDomain(code), message);
    this.#persist('playing', { lastErrorCode: code });
    this.#log.warn({ code, sourceId: source?.id, attempts: this.#attempts }, 'playback failure');

    // The bot's own faults (FFmpeg could not start, an internal error) say nothing about the
    // source, so they are not held against it. FFmpeg failing to start would fail the same way on
    // any source, so it never fails over; an unexpected error may be specific to this source's
    // data, so once its retries run out it still fails over to a fallback.
    const botFault = faultDomain(code) === 'bot';
    const tripped = botFault ? false : this.#d.sources.recordPlaybackFailure(source.id, code);
    this.#attempts++;
    // A move back to a better source that fails before it has played steadily goes straight back to
    // the source that was working, rather than leaving listeners in silence through every retry.
    const retrySame =
      !tripped &&
      !this.#upgradeUnproven &&
      !NON_RETRYABLE.has(code) &&
      this.#attempts < this.#t.backoff.length + 1;
    if (code === 'FFMPEG_SPAWN' && !retrySame) {
      this.#attempts = 0;
      this.#setState('ERROR');
      this.#d.notify({
        guildId: this.guildId,
        kind: 'error',
        code,
        message: `${message} I will try again in a couple of minutes.`,
      });
      this.#scheduleNoSourceRetry(gen);
      return;
    }
    if (retrySame) {
      this.#setState('RECOVERING');
      await sleep(backoffDelayMs(this.#attempts - 1, this.#t.backoff, 0.25, this.#d.random));
      if (gen !== this.#gen || this.#desired() !== 'playing') return;
      this.#gen++;
      await this.#start(this.#gen, { forceSourceId: source.id, reason: 'recover' });
      return;
    }
    if (source) {
      this.#excluded.add(source.id);
      const hold = this.#moveBackHolds.get(source.id);
      const failures = (hold?.failures ?? 0) + 1;
      // 10 min after the first failure, then 20, 40 … up to 4 h, before moving back to it.
      const wait = Math.min(this.#t.autoSwitchMinIntervalMs * 2 ** (failures - 1), 4 * 60 * 60_000);
      this.#moveBackHolds.set(source.id, { failures, until: Date.now() + wait });
    }
    this.#upgradeUnproven = false;
    // A listener's chosen source has failed: the bot chooses automatically again.
    if (source?.id === this.#manualSourceId) this.#manualSourceId = null;
    this.#attempts = 0;
    this.#failovers++;
    this.#lastAutoSwitchAt = Date.now();
    this.#d.metrics.inc('playback.failover');
    this.#setState('FAILING_OVER');
    this.#d.notify({
      guildId: this.guildId,
      kind: 'failover',
      code,
      message: `The current source failed: ${message} Switching to a verified fallback…`,
    });
    if (gen !== this.#gen) return;
    this.#gen++;
    await this.#start(this.#gen, { reason: 'failover' });
  }

  #enterError(code: ReasonCode, message: string): void {
    this.#teardownAudio();
    this.#lastError = { code, message, at: new Date().toISOString() };
    this.#setState('ERROR');
    this.#d.metrics.incident(this.guildId, code, faultDomain(code), message);
    this.#d.notify({ guildId: this.guildId, kind: 'error', code, message });
  }

  #scheduleNoSourceRetry(gen: number, soon = false): void {
    this.#clearTimer('retry');
    const step = soon ? this.#t.noSourceBackoff[this.#noSourceRetries++] : undefined;
    const delayMs = Math.min(step ?? this.#t.noSourceRetryMs, this.#t.noSourceRetryMs);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (gen !== this.#gen || this.#desired() !== 'playing') return;
      this.#excluded.clear();
      this.#attempts = 0;
      this.#gen++;
      void this.#start(this.#gen, { reason: 'retry' });
    }, delayMs);
  }

  #onLinkLost(link: VoiceLink, reason: 'kicked' | 'destroyed' | 'reconnect_failed'): void {
    if (link !== this.#link) return;
    this.#link = null;
    this.#stopWatchdog();
    this.#teardownAudio();
    if (reason === 'kicked') {
      this.#gen++;
      this.#clearAllTimers();
      this.#persist('kicked');
      this.#setState('IDLE');
      this.#d.notify({
        guildId: this.guildId,
        kind: 'kicked',
        code: 'VOICE_KICKED',
        message:
          'I was disconnected from the voice channel by a moderator, so playback stopped. Use /radio play to start again.',
      });
      return;
    }
    if (this.#desired() !== 'playing' || this.#destroyed) {
      this.#setState('IDLE');
      return;
    }
    this.#setState('IDLE');
    this.#d.metrics.incident(this.guildId, 'VOICE_DISCONNECTED', 'discord', `voice link lost (${reason})`);
    this.#scheduleVoiceReconnect('VOICE_DISCONNECTED', 'Lost the Discord voice connection.');
  }

  /**
   * Jittered voice reconnects (PRD §9.2). Once the quick ones are used up it says so once, then
   * keeps trying every couple of minutes while playback is wanted: an outage of Discord's voice
   * service can outlast the quick retries, and the station should come back by itself after it.
   */
  #scheduleVoiceReconnect(code: ReasonCode, message: string): void {
    const attempt = this.#voiceReconnectAttempts++;
    const slow = attempt >= this.#t.reconnectBackoff.length;
    if (attempt === this.#t.reconnectBackoff.length) {
      this.#enterError(
        code,
        `${message} I couldn’t reconnect yet, so I’ll keep trying every couple of minutes. /radio stop cancels it.`,
      );
    } else if (!slow) {
      this.#lastError = { code, message, at: new Date().toISOString() };
    } else if (this.#state !== 'ERROR') {
      this.#setState('ERROR');
    }
    const gen = ++this.#gen;
    this.#clearTimer('retry');
    this.#retryTimer = setTimeout(
      () => {
        this.#retryTimer = null;
        if (gen !== this.#gen || this.#desired() !== 'playing') return;
        this.#gen++;
        void this.#start(this.#gen, { reason: 'voice-reconnect' });
      },
      slow ? this.#t.noSourceRetryMs : backoffDelayMs(attempt, this.#t.reconnectBackoff, 0.2, this.#d.random),
    );
  }

  // ------------------------------------------------------------------ watchdog

  #startWatchdog(): void {
    this.#stopWatchdog();
    this.#watchdog = setInterval(() => this.#checkProgress(), this.#t.watchdogIntervalMs);
    this.#watchdog.unref?.();
  }

  #stopWatchdog(): void {
    if (this.#watchdog) clearInterval(this.#watchdog);
    this.#watchdog = null;
  }

  /** Stall detection from encoder output progress (PRD §9.2 / NFR-03) and live-lag resync (§8.4). */
  /**
   * Samples voice ping and packet counters for live stats (every watchdog tick), and returns the
   * stats it read, so the live-lag check needs no second read.
   */
  #sampleVoice(): VoiceLinkStats | null {
    if (!this.#link) return null;
    const v = this.#link.stats();
    this.#wsPing.add(v.wsPingMs);
    if (v.packetsPlayed !== null) {
      const prev = this.#packetSamples[this.#packetSamples.length - 1];
      // The counter went backwards: a new voice connection counts from zero, so start again.
      if (prev && v.packetsPlayed < prev.packets) this.#packetSamples = [];
      this.#packetSamples.push({
        at: Date.now(),
        packets: v.packetsPlayed,
        silenceMs: v.silenceMs,
        run: this.#runId,
      });
      if (this.#packetSamples.length > 13) this.#packetSamples.shift();
    }
    return v;
  }

  #checkProgress(): void {
    const voice = this.#sampleVoice();
    const p = this.#pipeline;
    if (!p || this.#state !== 'PLAYING') return;
    const now = Date.now();
    const lastOut = p.stats.lastOutputAt ?? p.stats.startedAt;
    if (now - lastOut > this.#t.stallMs) {
      void this.#handleFailure(this.#runId, 'STREAM_STALLED', 'Audio stopped arriving from the station.');
      return;
    }
    if (this.#link && p.stats.firstOutputAt !== null) {
      // Wall-clock time since the encoder's first audio, less the audio the player has sent: how
      // far playback has fallen behind the stream since it started. The live queue keeps this
      // small by dropping backlog (after a network gap the server sends what it held back; after
      // a voice resume; at its limit). Those packets were never played, so `playbackMs` didn't
      // advance for them, yet dropping them brought playback that much closer to live: they are
      // taken off. The burst trimmed at the start (`startDroppedMs`) is not: it arrived with the
      // first audio, before playback began, so it never added to `behind` in the first place.
      // The queue's figures come from the stats the voice sample just read (in worker mode, the
      // snapshot pushed each second, as is `playbackMs`), so this costs a subtraction.
      const caughtUpMs = voice?.live?.caughtUpMs ?? 0;
      const behind = now - p.stats.firstOutputAt - this.#link.playbackMs() - caughtUpMs;
      // When the HLS reader skips forward it is back at the live edge, so the gap it left
      // (time that passed without audio to play) no longer means playback is behind live.
      const skips = p.input.stats.liveEdgeSkips ?? 0;
      if (skips !== this.#lagSkips) {
        this.#lagSkips = skips;
        this.#lagCaughtUpMs = behind;
      }
      // With the live queue holding the delay to a few seconds, this is a last-resort safety net
      // for lag building up where the queue can't see it, or a fault in its accounting. `lagMs`
      // stays at 45 s, because the figure also counts gaps whose audio the server never resent
      // (lost, not held back): those leave nothing for the queue to drop and add no delay, yet
      // still add to `behind`. Lower, and a run of such gaps (each up to the 15 s stall limit)
      // would force a restart, an audible cut, for no gain.
      const lag = behind - this.#lagCaughtUpMs;
      if (lag > this.#t.lagMs && this.#source) {
        this.#log.info({ lagMs: lag }, 'playback drifted behind live; resynchronising');
        this.#d.metrics.inc('playback.resync');
        this.#gen++;
        void this.#start(this.#gen, { forceSourceId: this.#source.id, reason: 'resync' });
        return;
      }
    }
    this.#considerUpgrade(now);
  }

  /**
   * Quality first: a steady stream that isn't on its station's best source moves back to it once
   * that source has shown it works again, and a stream whose source now measures a clearly higher
   * bitrate is re-encoded at it. Each move is a brief cut, so the bot looks once a minute, moves
   * only for a real gain (better delivery, clearly better fidelity, or the admin's chosen source),
   * and at most once every `autoSwitchMinIntervalMs` (10 min). A listener's own choice is kept.
   */
  #considerUpgrade(now: number): void {
    const current = this.#source;
    const stationId = this.#stationId;
    const p = this.#pipeline;
    if (!current || !stationId || !p || this.#stableTimer) return;
    if (now - this.#lastUpgradeCheckAt < this.#t.upgradeCheckMs) return;
    this.#lastUpgradeCheckAt = now;
    if (this.#desired() !== 'playing') return;
    try {
      // Keeps the station's other sources checked (in the background, at the lowest priority),
      // so a source that failed earlier can show that it works again. Not before this stream's
      // settle period is over: nothing should compete with it in its first minutes.
      const firstAudio = p.stats.firstOutputAt;
      if (firstAudio !== null && now - firstAudio >= this.#t.backgroundSettleMs) {
        this.#d.sources.refreshStation?.(stationId, current.id);
      }
      if (this.#manualSourceId || now - this.#lastAutoSwitchAt < this.#t.autoSwitchMinIntervalMs) return;
      const better = this.#betterSource(stationId, current);
      if (better) {
        this.#log.info({ from: current.id, to: better.id }, 'moving back to a better source');
        this.#d.metrics.inc('playback.upgrade');
        this.#lastAutoSwitchAt = now;
        this.#excluded.clear();
        this.#attempts = 0;
        this.#upgradeUnproven = true;
        this.#gen++;
        void this.#start(this.#gen, { forceSourceId: better.id, reason: 'upgrade' });
        return;
      }
      const fresh = this.#d.stations.getSource(current.id);
      if (!fresh) return;
      const target = this.#plan(fresh).targetKbps;
      if (target > p.plan.targetKbps * 1.05) {
        this.#log.info({ from: p.plan.targetKbps, to: target }, 'source measures higher; re-encoding');
        this.#d.metrics.inc('playback.upgrade');
        this.#lastAutoSwitchAt = now;
        this.#gen++;
        void this.#start(this.#gen, { forceSourceId: current.id, reason: 'reconfigure' });
      }
    } catch (err) {
      this.#log.error({ err: safeErr(err) }, 'could not look for a better source');
    }
  }

  /** The station's best source, when it is a real step up from `current` and has shown it works. */
  #betterSource(stationId: string, current: StationSource): StationSource | null {
    const selection = this.#d.sources.select?.(this.guildId, stationId);
    const best = selection?.selected;
    if (!best || best.id === current.id) return null;
    if ((this.#moveBackHolds.get(best.id)?.until ?? 0) > Date.now()) return null;
    // It failed in playback since its last good check: wait for a check to show it is back.
    if (best.lastFailureAt && !(best.lastSuccessAt && best.lastSuccessAt > best.lastFailureAt)) return null;
    if (selection.preferredSourceId === best.id) return best;
    if (transportTier(best) < transportTier(current)) return best;
    const fresh = this.#d.stations.getSource(current.id) ?? current;
    return transportTier(best) === transportTier(fresh) && compareFidelity(best, fresh).relation === 'a'
      ? best
      : null;
  }

  // ------------------------------------------------------------------ teardown helpers

  #teardownAudio(): void {
    this.#runAbort?.abort();
    this.#runAbort = null;
    this.#clearTimer('stable');
    if (this.#pipeline) {
      this.#runId++;
      this.#link?.stopAudio();
      this.#pipeline.stop();
      this.#pipeline = null;
    }
    this.#startedAt = null;
    this.#nowPlaying = null;
  }

  #teardownLink(): void {
    this.#stopWatchdog();
    const link = this.#link;
    this.#link = null;
    if (link) {
      link.removeAllListeners();
      link.destroy();
    }
  }

  #armStoppedIdleLeave(): void {
    this.#clearTimer('idle');
    const { idleMode } = this.#d.guilds.getSettings(this.guildId);
    if (idleMode === '24x7' || !this.#link) return;
    const gen = this.#gen;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (gen !== this.#gen || isAudioActive(this.#state)) return;
      const desired = this.#desired();
      this.leave(desired === 'stopped' ? 'stopped' : 'idle', 'idle_after_stop');
    }, this.#t.stoppedIdleLeaveMs);
  }

  #clearTimer(which: 'retry' | 'stable' | 'idle' | 'empty'): void {
    if (which === 'empty' && this.#emptyTimer) {
      clearTimeout(this.#emptyTimer);
      this.#emptyTimer = null;
    }
    if (which === 'retry' && this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    } else if (which === 'stable' && this.#stableTimer) {
      clearTimeout(this.#stableTimer);
      this.#stableTimer = null;
    } else if (which === 'idle' && this.#idleTimer) {
      clearTimeout(this.#idleTimer);
      this.#idleTimer = null;
    }
  }

  #clearAllTimers(): void {
    this.#clearTimer('retry');
    this.#clearTimer('stable');
    this.#clearTimer('idle');
    this.#clearTimer('empty');
    this.#stopWatchdog();
  }

  // ------------------------------------------------------------------ status

  liveStats(): SessionLiveStats {
    const p = this.#pipeline;
    const link = this.#link;
    let packetsPerSecond: number | null = null;
    let recentSilenceMs: number | null = null;
    const first = this.#packetSamples[0];
    const last = this.#packetSamples[this.#packetSamples.length - 1];
    // A count that went down belongs to another voice connection: no rate rather than a wrong one.
    if (first && last && last.at - first.at >= 4000 && last.packets >= first.packets) {
      packetsPerSecond =
        Math.round(((last.packets - first.packets) / ((last.at - first.at) / 1000)) * 10) / 10;
    }
    // Silence is counted per stream, so only the samples of the stream playing now are compared.
    if (last && last.silenceMs !== null) {
      const from = this.#packetSamples.find((s) => s.run === last.run && s.silenceMs !== null);
      if (from && from !== last && last.silenceMs >= from.silenceMs!) {
        recentSilenceMs = Math.round(last.silenceMs - from.silenceMs!);
      }
    }
    const v = link?.stats() ?? null;
    return {
      connectedSince: link ? this.#connectedSince : null,
      input: p
        ? {
            requestedHost: p.input.info.requestedHost,
            finalHost: p.input.info.finalHost,
            remoteAddress: p.input.info.remoteAddress,
            remotePort: p.input.info.remotePort,
            redirects: p.input.info.redirects,
            transport: p.input.info.transport,
            segmentHost: p.input.stats.segmentHost,
            segmentsFetched: p.input.stats.segmentsFetched,
            segmentFailures: p.input.stats.segmentFailures,
            skippedSegments: p.input.stats.skippedSegments,
            kbps10s: p.stats.inputRate?.kbps(10) ?? null,
            kbps60s: p.stats.inputRate?.kbps(59) ?? null,
            bytes: p.stats.inputBytes,
          }
        : null,
      output: p
        ? {
            targetKbps: p.plan.targetKbps,
            channelBitrateKbps: p.plan.channelBitrateKbps,
            kbps10s: p.stats.outputRate?.kbps(10) ?? null,
            kbps60s: p.stats.outputRate?.kbps(59) ?? null,
            bytes: p.stats.outputBytes,
          }
        : null,
      voice:
        link && v
          ? {
              endpoint: v.endpoint,
              status: v.status,
              encryption: link.encryption(),
              encryptionMode: v.encryptionMode,
              packetsPlayed: v.packetsPlayed,
              packetsPerSecond,
              latePackets: v.packetTiming.late,
              worstPacketGapMs: v.packetTiming.worstGapMs,
              recentLatePackets: v.packetTiming.recent,
              silenceMs: v.silenceMs,
              recentSilenceMs,
              live: v.live,
              ws: this.#wsPing.summary(),
            }
          : null,
    };
  }

  status(): SessionStatus {
    const p = this.#pipeline;
    const elapsed = p?.stats.firstOutputAt ? (Date.now() - p.stats.firstOutputAt) / 1000 : 0;
    return {
      guildId: this.guildId,
      state: this.#state,
      desiredState: this.#desired(),
      stationId: this.#stationId,
      channelId: this.channelId,
      source: this.#source && p ? (this.#d.stations.getSource(this.#source.id) ?? this.#source) : null,
      selection: this.#selection,
      plan: p?.plan ?? null,
      startedAt: this.#startedAt,
      nowPlaying: this.#nowPlaying,
      lastError: this.#lastError,
      failovers: this.#failovers,
      reconnects: this.#reconnects,
      inputBytes: p?.stats.inputBytes ?? 0,
      outputBytes: p?.stats.outputBytes ?? 0,
      observedOutputKbps: p && elapsed >= 5 ? Math.round((p.stats.outputBytes * 8) / elapsed / 1000) : null,
      observedInputKbps: p && elapsed >= 5 ? Math.round((p.stats.inputBytes * 8) / elapsed / 1000) : null,
      encryption: this.#link?.encryption() ?? null,
      inputTransport: p?.input.info.transport ?? null,
      inputHost: p?.input.info.finalHost ?? null,
      hls: p?.input.info.hls ?? null,
      encoderPid: p?.stats.pid ?? null,
      ffmpegWarnings: p?.stderrTail ?? [],
      manualSourceId: this.#manualSourceId,
    };
  }
}

/** Longest a leave waits for its onLeaving hook before disconnecting. */
const LEAVE_GRACE_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
