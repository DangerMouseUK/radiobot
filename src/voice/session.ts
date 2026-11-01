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
import type { SelectionResult } from '../streams/ranking.ts';
import type { VoiceLink } from './link.ts';
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
  refreshStation?(stationId: string): void;
}

export type SessionNoticeKind =
  | 'recovered'
  | 'failover'
  | 'degraded'
  | 'error'
  | 'kicked'
  | 'idle-left'
  | 'info';

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
  stableMs: number;
  noSourceRetryMs: number;
  stoppedIdleLeaveMs: number;
  emptyLeaveMs: number;
  emptyPauseMs: number;
  watchdogIntervalMs: number;
  backoff: readonly number[];
  reconnectBackoff: readonly number[];
}

export const DEFAULT_TIMINGS: SessionTimings = {
  stallMs: 15_000,
  firstAudioTimeoutMs: 20_000,
  lagMs: 45_000,
  stableMs: 30_000,
  noSourceRetryMs: 120_000,
  stoppedIdleLeaveMs: 5 * 60_000,
  emptyLeaveMs: 60_000,
  emptyPauseMs: 30_000,
  watchdogIntervalMs: 5_000,
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
    /** Ogg Opus pulled by the voice player, i.e. what is being sent on, rolling 10 s. */
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
}

const NON_RETRYABLE: ReadonlySet<ReasonCode> = new Set([
  'ACCESS_DENIED',
  'NOT_FOUND',
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
  #packetSamples: Array<{ at: number; packets: number }> = [];
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
    this.#d.guilds.setIntent(this.guildId, { desiredState, ...extra });
  }

  // ------------------------------------------------------------------ commands

  /** Start or switch station. Supersedes any pending start. */
  async play(stationId: string, channelId: string, requestedById: string | null): Promise<StartResult> {
    this.#commands++;
    this.#gen++;
    this.#clearTimer('retry');
    this.#clearTimer('idle');
    this.#clearTimer('empty');
    this.#stationId = stationId;
    this.#channelId = channelId;
    this.#excluded.clear();
    this.#attempts = 0;
    this.#voiceReconnectAttempts = 0;
    this.#persist('playing', {
      desiredStationId: stationId,
      desiredVoiceChannelId: channelId,
      lastRequestedAt: new Date().toISOString(),
      lastRequestedById: requestedById,
      lastErrorCode: null,
    });
    return this.#start(this.#gen, {});
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
  stop(): void {
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
  leave(desired: DesiredState = 'left'): void {
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
        this.#log.info('voice channel empty; leaving');
        // An explicit stop stays authoritative, so autostart doesn't fire on the next boot.
        this.leave(this.#desired() === 'stopped' ? 'stopped' : 'idle');
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

  /** Quality settings changed: rebuild the encoder if the Opus target changed (PRD §8.3). */
  refreshEncoder(): void {
    if (!this.#pipeline || !this.#source || this.#state !== 'PLAYING') return;
    const plan = this.#plan(this.#source);
    if (plan.targetKbps === this.#pipeline.plan.targetKbps) return;
    this.#log.info(
      { from: this.#pipeline.plan.targetKbps, to: plan.targetKbps },
      'encoder settings changed; re-encoding',
    );
    this.#gen++;
    void this.#start(this.#gen, { forceSourceId: this.#source.id, reason: 'reconfigure' });
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
    if (this.#link && this.#link.channelId === channelId && this.#link.ready) return true;
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
    });
    link.on('connectionError', (err) => this.#log.warn({ err: safeErr(err) }, 'voice connection error'));
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
    const abort = new AbortController();
    this.#runAbort = abort;
    try {
      const linked = await this.#ensureLink(gen, channelId);
      if (!linked) return this.#superseded();
      if (this.#state === 'CONNECTED' || this.#state === 'ERROR') this.#setState('BUFFERING');
      else if (this.#state === 'SWITCHING') this.#setState('BUFFERING');

      let selection = await this.#d.sources.prepareForPlayback(this.guildId, stationId, {
        exclude: this.#excluded,
        signal: abort.signal,
      });
      if (gen !== this.#gen) return this.#superseded();
      if (opts.forceSourceId && selection.selected?.id !== opts.forceSourceId) {
        const forced = selection.ordered.find((s) => s.id === opts.forceSourceId);
        if (forced) selection = { ...selection, selected: forced };
      }
      this.#selection = selection;
      const source = selection.selected;
      if (!source) {
        const station = this.#d.stations.getStation(stationId);
        const msg = `No verified, working source is available for ${station?.displayName ?? stationId} right now.`;
        this.#enterError('NO_ELIGIBLE_SOURCE', msg);
        this.#scheduleNoSourceRetry(gen);
        return { ok: false, code: 'NO_ELIGIBLE_SOURCE', message: msg, selection, plan: null };
      }
      this.#source = source;
      if (this.#state !== 'BUFFERING') this.#setState('BUFFERING');
      const plan = this.#plan(source);
      const input = await this.#d.openInput(source, abort.signal);
      if (gen !== this.#gen) {
        input.close();
        return this.#superseded();
      }
      let pipeline: PipelineLike;
      try {
        pipeline = this.#d.createPipeline(input, plan);
      } catch (err) {
        input.close();
        throw err;
      }
      const runId = ++this.#runId;
      this.#pipeline = pipeline;
      this.#nowPlaying = null;
      pipeline.on('failed', (err) => void this.#handleFailure(runId, err.code, err.userMessage));
      pipeline.on('metadata', (m) => {
        if (runId !== this.#runId) return;
        if (m?.title !== this.#nowPlaying?.title)
          this.#log.debug({ title: m?.title ?? null }, 'stream title');
        this.#nowPlaying = m;
      });
      this.#link!.play(pipeline.output);
      this.#startedAt = Date.now();
      const firstAudio = await this.#waitFirstAudio(pipeline, runId);
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
      this.#lastError = null;
      this.#voiceReconnectAttempts = 0;
      this.#persist('playing', { lastSuccessfulSourceId: source.id, lastErrorCode: null });
      this.#d.metrics.inc('playback.started');
      this.#recheckListeners();
      this.#stableTimer = setTimeout(() => {
        this.#stableTimer = null;
        if (runId !== this.#runId || this.#state !== 'PLAYING') return;
        this.#attempts = 0;
        this.#d.sources.recordPlaybackSuccess(source.id);
        // Only now, with the stream settled, may background checks of the other sources run.
        this.#d.sources.refreshStation?.(stationId);
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
          message: `The usual source failed, so the radio is playing from a fallback (${source.label ?? source.id}).`,
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
      if (!isRadioError(err)) this.#log.error({ err }, 'unexpected start failure');
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
      'This bot is already playing in as many servers as its operator allows. I will try again in a couple of minutes.';
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

  #waitFirstAudio(pipeline: PipelineLike, runId: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (pipeline.stats.firstOutputAt !== null) {
        resolve(true);
        return;
      }
      const started = Date.now();
      const tick = setInterval(() => {
        if (runId !== this.#runId || pipeline.stats.firstOutputAt !== null) {
          clearInterval(tick);
          resolve(pipeline.stats.firstOutputAt !== null);
        } else if (Date.now() - started > this.#t.firstAudioTimeoutMs) {
          clearInterval(tick);
          resolve(false);
        }
      }, 100);
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
    this.#teardownAudio();
    this.#lastError = { code, message, at: new Date().toISOString() };
    this.#d.metrics.incident(this.guildId, code, faultDomain(code), message);
    this.#persist('playing', { lastErrorCode: code });
    this.#log.warn({ code, sourceId: source?.id, attempts: this.#attempts }, 'playback failure');

    let tripped = false;
    if (source) tripped = this.#d.sources.recordPlaybackFailure(source.id, code);
    this.#attempts++;
    const retrySame =
      source && !tripped && !NON_RETRYABLE.has(code) && this.#attempts < this.#t.backoff.length + 1;
    if (retrySame) {
      this.#setState('RECOVERING');
      await sleep(backoffDelayMs(this.#attempts - 1, this.#t.backoff, 0.25, this.#d.random));
      if (gen !== this.#gen || this.#desired() !== 'playing') return;
      this.#gen++;
      await this.#start(this.#gen, { forceSourceId: source.id, reason: 'recover' });
      return;
    }
    if (source) this.#excluded.add(source.id);
    this.#attempts = 0;
    this.#failovers++;
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

  #scheduleNoSourceRetry(gen: number): void {
    this.#clearTimer('retry');
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (gen !== this.#gen || this.#desired() !== 'playing') return;
      this.#excluded.clear();
      this.#attempts = 0;
      this.#gen++;
      void this.#start(this.#gen, { reason: 'retry' });
    }, this.#t.noSourceRetryMs);
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

  /** Bounded, jittered voice reconnects (PRD §9.2); gives up with a visible error. */
  #scheduleVoiceReconnect(code: ReasonCode, message: string): void {
    const attempt = this.#voiceReconnectAttempts++;
    if (attempt >= this.#t.reconnectBackoff.length) {
      this.#enterError(code, `${message} I couldn’t reconnect. Use /radio play to try again.`);
      return;
    }
    this.#lastError = { code, message, at: new Date().toISOString() };
    const gen = ++this.#gen;
    this.#clearTimer('retry');
    this.#retryTimer = setTimeout(
      () => {
        this.#retryTimer = null;
        if (gen !== this.#gen || this.#desired() !== 'playing') return;
        this.#gen++;
        void this.#start(this.#gen, { reason: 'voice-reconnect' });
      },
      backoffDelayMs(attempt, this.#t.reconnectBackoff, 0.2, this.#d.random),
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
  /** Samples voice ping and packet counters for live stats (every watchdog tick). */
  #sampleVoice(): void {
    if (!this.#link) return;
    const v = this.#link.stats();
    this.#wsPing.add(v.wsPingMs);
    if (v.packetsPlayed !== null) {
      this.#packetSamples.push({ at: Date.now(), packets: v.packetsPlayed });
      if (this.#packetSamples.length > 13) this.#packetSamples.shift();
    }
  }

  #checkProgress(): void {
    this.#sampleVoice();
    const p = this.#pipeline;
    if (!p || this.#state !== 'PLAYING') return;
    const now = Date.now();
    const lastOut = p.stats.lastOutputAt ?? p.stats.startedAt;
    if (now - lastOut > this.#t.stallMs) {
      void this.#handleFailure(this.#runId, 'STREAM_STALLED', 'Audio stopped arriving from the station.');
      return;
    }
    if (this.#link && p.stats.firstOutputAt !== null) {
      const lag = now - p.stats.firstOutputAt - this.#link.playbackMs();
      if (lag > this.#t.lagMs && this.#source) {
        this.#log.info({ lagMs: lag }, 'playback drifted behind live; resynchronising');
        this.#d.metrics.inc('playback.resync');
        this.#gen++;
        void this.#start(this.#gen, { forceSourceId: this.#source.id, reason: 'resync' });
      }
    }
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
      this.#log.info('idle after stop; leaving voice channel');
      this.leave(desired === 'stopped' ? 'stopped' : 'idle');
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
    const first = this.#packetSamples[0];
    const last = this.#packetSamples[this.#packetSamples.length - 1];
    if (first && last && last.at - first.at >= 4000) {
      packetsPerSecond =
        Math.round(((last.packets - first.packets) / ((last.at - first.at) / 1000)) * 10) / 10;
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
    };
  }
}

/** Longest a leave waits for its onLeaving hook before disconnecting. */
const LEAVE_GRACE_MS = 1_500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
