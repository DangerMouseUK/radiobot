import type { ProcessRegistry } from '../audio/ffmpeg.ts';
import type {
  IdentityEvidence,
  Station,
  StationAvailability,
  StationSource,
  VerificationState,
} from '../catalogue/types.ts';
import type { Logger } from '../observability/logger.ts';
import type { Metrics } from '../observability/metrics.ts';
import type { GuildRepository } from '../persistence/repositories/guilds.ts';
import type { StationRepository } from '../persistence/repositories/stations.ts';
import { delay, KeyedSemaphore, Semaphore } from '../shared/async.ts';
import { cooldownMs } from '../shared/backoff.ts';
import { errorCode, RadioError } from '../shared/errors.ts';
import { urlHost } from '../shared/redact.ts';
import {
  compareSources as correlate,
  correlationEvidence,
  decideIdentity,
  type IdentityDecision,
  metadataSignal,
} from './identity.ts';
import {
  DEFAULT_PROBE_BUDGET,
  PROBE_VERSION,
  type ProbeBudget,
  type ProbeOutcome,
  probeSource,
} from './probe.ts';
import { isEligibleNow, type SelectionResult, selectSource } from './ranking.ts';
import type { SafeHttpClient } from './safe-fetch.ts';

/** `coverageByProvider()` counts are at most this old: eligibility depends on time (holds end). */
export const COVERAGE_MAX_AGE_MS = 60_000;

/** Why a background check was interrupted (the abort reason). */
const STREAM_START = 'stream-start';
const STOPPED = 'stopped';

/**
 * A background check that gave way to a stream starting somewhere. Nothing is recorded, and it is
 * not the source's fault or its host's: a full re-check simply queues it again.
 */
class GaveWayToStart extends RadioError {
  constructor() {
    super('CANCELLED', 'The background check gave way to a stream that is starting.');
  }
}

/** A check in progress, shared by everyone who asks for the same source meanwhile. */
interface InflightProbe {
  promise: Promise<ProbeReport>;
  /** Set for a background check, which may be interrupted while nobody is waiting for it. */
  abort: AbortController | null;
}

export const PROBE_STALE_MS = 24 * 60 * 60_000;
/**
 * How long a failed source waits before its next automatic check, by failed checks in a row:
 * about 10 min, 1 h, 6 h, 12 h, then once a day. An address that is gone (HTTP 404/410) starts
 * at 12 h, because removed mounts rarely come back. "Check sources again" ignores the wait, and
 * a successful check resets it. Fewer checks also means less background load on small hosts.
 */
export const FAILED_RETRY_STEPS_MS = [
  10 * 60_000,
  60 * 60_000,
  6 * 3_600_000,
  12 * 3_600_000,
  24 * 3_600_000,
] as const;
const GONE_STEP = 3;

/** When a failed source is next checked automatically (ms since the epoch), or null if it isn't failing. */
export function nextAutomaticCheck(
  s: Pick<StationSource, 'verificationState' | 'lastProbeAt' | 'consecutiveFailures' | 'lastFailureCode'>,
): number | null {
  if (s.verificationState !== 'offline' || s.lastProbeAt === null) return null;
  let step = Math.min(Math.max(1, s.consecutiveFailures) - 1, FAILED_RETRY_STEPS_MS.length - 1);
  if (s.lastFailureCode === 'NOT_FOUND') step = Math.max(step, GONE_STEP);
  return Date.parse(s.lastProbeAt) + FAILED_RETRY_STEPS_MS[step]!;
}

/** A failing source with no successful check for this long is paused (see `isPaused()`). */
export const PAUSE_AFTER_MS = 7 * 24 * 3_600_000;
/** …and at least this many failed checks in a row, so a source is never paused on thin evidence. */
export const PAUSE_MIN_FAILURES = 5;
/**
 * When someone wants a station and none of its sources works, its failing sources are re-checked
 * despite the back-off (they are the only hope), but no more often than this: every 10 min within
 * a day of the source last working (or being added), then hourly.
 */
export const FOREGROUND_FLOOR_MS = [10 * 60_000, 60 * 60_000] as const;
const DAY_MS = 24 * 3_600_000;

/**
 * True when a failing source is paused: no successful check for 7 days and 5+ failures in a row.
 * A paused source is never checked automatically, in the background or for a play; only an
 * admin's "Check sources again", the bot owner's "Check all sources again" (`FullSourceCheck`)
 * or a new address from a pack update brings it back. Measuring
 * time, not just failures, means a temporary outage of hours or days never pauses a source,
 * however many checks fail during it.
 */
export function isPaused(
  s: Pick<StationSource, 'verificationState' | 'consecutiveFailures' | 'lastSuccessAt' | 'createdAt'>,
  now = Date.now(),
): boolean {
  if (s.verificationState !== 'offline' || s.consecutiveFailures < PAUSE_MIN_FAILURES) return false;
  return now - Date.parse(s.lastSuccessAt ?? s.createdAt) >= PAUSE_AFTER_MS;
}
/**
 * Consecutive playback failures before a source is circuit-broken: the first failure plus one per
 * same-source retry step (the session's backoff of about 1, 3 and 8 s), so every retry runs first.
 */
export const CIRCUIT_BREAK_FAILURES = 4;
/**
 * …and the failures must span at least this long. A short upstream blip (a station's encoder
 * reconnecting) uses up the quick retries in about 12 s; it must not put the source on hold.
 */
export const CIRCUIT_BREAK_MIN_SPAN_MS = 60_000;
/**
 * Failures of one source this close together are one event: several servers hearing the same blip
 * at once. It is well under the first retry step (about 1 s), so one server's retries all count.
 */
export const FAILURE_DEDUP_MS = 500;
/** A play with nothing else to use re-checks a source on hold this often, instead of waiting it out. */
export const COOLDOWN_RECHECK_MS = 2 * 60_000;
/** A source that failed in playback since its last check is checked again this long after, to see if it is back. */
export const PLAYBACK_FAILURE_RECHECK_MS = 5 * 60_000;

export interface SourceServiceDeps {
  stations: StationRepository;
  guilds: GuildRepository;
  client: SafeHttpClient;
  registry: ProcessRegistry;
  ffmpegPath: string;
  ffprobePath: string;
  maxConcurrentProbes: number;
  logger: Logger;
  metrics: Metrics;
  /** Operator kill switch (takedown / disable list). */
  disabledSourceIds?: ReadonlySet<string>;
  disabledStationIds?: ReadonlySet<string>;
  /** Pack brand labels for identity checks. */
  brandLabels?: (provider: string) => ReadonlySet<string>;
  probeBudget?: ProbeBudget;
  /** The network check itself; tests replace it to observe scheduling. Defaults to `probeSource`. */
  probeImpl?: typeof probeSource;
  /** Check results kept per source (PROBE_HISTORY_LIMIT). */
  probeHistoryLimit?: number;
}

export interface ProbeReport {
  source: StationSource;
  outcome: ProbeOutcome;
  identity: IdentityDecision;
}

export interface CoverageCounts {
  catalogued: number;
  withSources: number;
  usable: number;
  verifiedPlayable: number;
}

/**
 * The source-validation boundary (PRD §12.2): the only component that probes stream URLs.
 * Command handlers ask it for a selection; the playback pipeline asks it to record health.
 */
export class SourceService {
  readonly #d: SourceServiceDeps;
  readonly #global: Semaphore;
  readonly #perHost = new KeyedSemaphore(1);
  /** Background checks run one at a time, at the lowest priority, so they never crowd out a stream. */
  readonly #background = new Semaphore(1);
  /** The background check running on each host, which a play's check may interrupt. */
  readonly #backgroundByHost = new Map<string, { sourceId: string; abort: AbortController }>();
  readonly #inflight = new Map<string, InflightProbe>();
  /** Sources waiting for a background check, so a source is never queued twice. */
  readonly #queued = new Set<string>();
  /** Background work waits until this time while a stream is starting somewhere. */
  #holdUntil = 0;
  /**
   * Automatic background work (nobody waiting for it) also waits until this time: a stream's first
   * minutes after its first audio, while the listener's client is still settling its buffer.
   */
  #settleUntil = 0;
  /** One timer for all the work waiting out the settle period, so it resumes in the order it came. */
  #settleGate: { until: number; done: Promise<void> } | null = null;
  /**
   * The settle deadline whose timer has fired. A timer can fire a moment early by the wall clock;
   * once it has fired, that deadline counts as passed, so every waiter agrees and the work keeps its
   * order (otherwise the first in line could give its turn up while the next one went ahead).
   */
  #settledThrough = 0;
  /** `coverageByProvider()` results, per provider. */
  readonly #coverage = new Map<string, { key: string; at: number; counts: CoverageCounts }>();
  /** Per source with a playback failure streak: when the streak started and its last counted failure. */
  readonly #failureStreaks = new Map<string, { since: number; last: number }>();
  readonly #log: Logger;

  constructor(deps: SourceServiceDeps) {
    this.#d = deps;
    this.#global = new Semaphore(deps.maxConcurrentProbes);
    this.#log = deps.logger.child({ component: 'sources' });
  }

  #brand(provider: string): ReadonlySet<string> {
    return this.#d.brandLabels?.(provider) ?? new Set();
  }

  get activeProbes(): number {
    return this.#global.inUse;
  }

  isStationDisabled(stationId: string): boolean {
    return this.#d.disabledStationIds?.has(stationId) ?? false;
  }

  /** Sources with the operator kill-switch applied. */
  sourcesFor(stationId: string): StationSource[] {
    const disabledStation = this.isStationDisabled(stationId);
    return this.#d.stations
      .listSources(stationId)
      .map((s) =>
        disabledStation || this.#d.disabledSourceIds?.has(s.id)
          ? { ...s, enabled: false, disabledReason: 'switched off by the bot owner' }
          : s,
      );
  }

  /** Probes one source (deduplicated, rate-bounded: global and per-host limits). */
  probe(sourceId: string, opts: { signal?: AbortSignal; budget?: ProbeBudget } = {}): Promise<ProbeReport> {
    if (opts.signal?.aborted)
      return Promise.reject(new RadioError('CANCELLED', 'The stream check was cancelled.'));
    // Playback comes first: a check someone is waiting for interrupts any background check of
    // another source on the same host, instead of queuing behind it.
    this.#claimHost(sourceId);
    let shared = this.#joinable(sourceId);
    if (!shared) {
      // The probe itself is bounded by its own budget and is not tied to any caller's signal,
      // so one guild cancelling never records a failure or cancels another guild's wait.
      shared = this.#track(sourceId, this.#probeNow(sourceId, { budget: opts.budget }), null);
    }
    return opts.signal ? raceSignal(shared, opts.signal) : shared;
  }

  /** Registers a check in progress, so that others asking for the same source share it. */
  #track(
    sourceId: string,
    run: Promise<ProbeReport>,
    abort: AbortController | null,
    onSettled?: () => void,
  ): Promise<ProbeReport> {
    const entry: InflightProbe = { promise: run, abort };
    entry.promise = run.finally(() => {
      // A check that was interrupted may already have been replaced by a new one: leave that be.
      if (this.#inflight.get(sourceId) === entry) this.#inflight.delete(sourceId);
      onSettled?.();
    });
    this.#inflight.set(sourceId, entry);
    return entry.promise;
  }

  /**
   * The check of `sourceId` in progress, if it can still give a result. One that was interrupted
   * ends CANCELLED, so whoever asks now starts a new check rather than sharing that.
   */
  #joinable(sourceId: string): Promise<ProbeReport> | null {
    const entry = this.#inflight.get(sourceId);
    return entry && !entry.abort?.signal.aborted ? entry.promise : null;
  }

  /**
   * A foreground check of `sourceId` is starting. A background check of the same source is joined
   * and can no longer be interrupted (someone now waits for it); one of another source on the same
   * host is interrupted, unrecorded, and simply runs again later.
   */
  #claimHost(sourceId: string): void {
    const source = this.#d.stations.getSource(sourceId);
    if (!source) return;
    const host = urlHost(source.url) || 'invalid';
    const running = this.#backgroundByHost.get(host);
    if (!running) return;
    this.#backgroundByHost.delete(host);
    if (running.sourceId !== sourceId) {
      running.abort.abort();
      this.#log.debug({ host, interrupted: running.sourceId, for: sourceId }, 'background check gave way');
    }
  }

  /**
   * A background check: shares an in-flight check, otherwise runs one that a play may interrupt.
   * `signal` (a full re-check being stopped) stops the wait at once, and interrupts the check
   * itself only while nobody else waits for it: a play that joined it still gets its result.
   * An interrupted check records nothing.
   */
  #probeInBackground(sourceId: string, signal?: AbortSignal): Promise<ProbeReport> {
    const existing = this.#joinable(sourceId);
    if (existing) return signal ? raceSignal(existing, signal) : existing;
    const source = this.#d.stations.getSource(sourceId);
    if (!source) return Promise.reject(new RadioError('INTERNAL', 'Unknown source.'));
    const host = urlHost(source.url) || 'invalid';
    const abort = new AbortController();
    const running = { sourceId, abort };
    this.#backgroundByHost.set(host, running);
    // Still in the map means unclaimed: a foreground check of this source removes it.
    const onStop = () => {
      if (this.#backgroundByHost.get(host) === running) abort.abort(STOPPED);
    };
    signal?.addEventListener('abort', onStop, { once: true });
    const shared = this.#track(sourceId, this.#probeNow(sourceId, { signal: abort.signal }), abort, () => {
      signal?.removeEventListener('abort', onStop);
      if (this.#backgroundByHost.get(host) === running) this.#backgroundByHost.delete(host);
    });
    return signal ? raceSignal(shared, signal) : shared;
  }

  async #probeNow(
    sourceId: string,
    opts: { signal?: AbortSignal; budget?: ProbeBudget },
  ): Promise<ProbeReport> {
    const source = this.#d.stations.getSource(sourceId);
    if (!source) throw new RadioError('INTERNAL', 'Unknown source.');
    const station = this.#d.stations.getStation(source.stationId);
    if (!station) throw new RadioError('INTERNAL', 'Unknown station.');
    const host = urlHost(source.url) || 'invalid';
    let outcome: ProbeOutcome;
    try {
      outcome = await this.#global.run(
        () =>
          this.#perHost.run(
            host,
            () =>
              (this.#d.probeImpl ?? probeSource)(
                {
                  client: this.#d.client,
                  registry: this.#d.registry,
                  ffmpegPath: this.#d.ffmpegPath,
                  ffprobePath: this.#d.ffprobePath,
                },
                source.url,
                opts.budget ?? this.#d.probeBudget ?? DEFAULT_PROBE_BUDGET,
                opts.signal,
                `probe:${sourceId}`,
              ),
            opts.signal,
          ),
        opts.signal,
      );
    } catch (err) {
      if (opts.signal?.aborted) throw interrupted(opts.signal);
      throw err;
    }
    // Interrupted to make way for playback: not a result, so nothing is recorded.
    if (opts.signal?.aborted) throw interrupted(opts.signal);
    this.#d.metrics.inc(outcome.success ? 'probe.success' : 'probe.failure');
    const identity = this.#applyProbe(station, source, outcome);
    const updated = this.#d.stations.getSource(sourceId)!;
    this.#log.info(
      {
        sourceId,
        stationId: station.id,
        success: outcome.success,
        failureCode: outcome.failureCode,
        codec: outcome.codec,
        measuredKbps: outcome.measuredBitrateKbps,
        transport: outcome.transport,
        host: outcome.effectiveHost,
        identity: identity.status,
        durationMs: outcome.durationMs,
      },
      'source probed',
    );
    return { source: updated, outcome, identity };
  }

  #applyProbe(station: Station, source: StationSource, o: ProbeOutcome): IdentityDecision {
    const meta = o.success
      ? metadataSignal(
          station,
          this.#d.stations.listBuiltinStations(),
          o.icyName,
          this.#brand(station.provider),
        )
      : null;
    const priorCorrelation = latestCorrelation(source.identityEvidence);
    const decision = decideIdentity(source, meta, priorCorrelation);
    if (o.success && source.codec) {
      const before = source.measuredBitrateKbps ?? source.codecBitrateKbps;
      const after = o.measuredBitrateKbps ?? o.codecBitrateKbps;
      const bitrateChanged = before !== null && after !== null && Math.abs(after - before) / before > 0.15;
      if (source.codec !== o.codec || bitrateChanged || source.sampleRateHz !== o.sampleRateHz) {
        this.#d.metrics.inc('source.characteristics_changed');
        this.#log.warn(
          {
            sourceId: source.id,
            from: { codec: source.codec, kbps: before, sampleRateHz: source.sampleRateHz },
            to: { codec: o.codec, kbps: after, sampleRateHz: o.sampleRateHz },
          },
          'source characteristics changed since last probe',
        );
      }
    }
    let state: VerificationState;
    if (!o.success) {
      state =
        o.failureCode &&
        [
          'ADDRESS_BLOCKED',
          'URL_HOST_NOT_ALLOWED',
          'URL_PORT_NOT_ALLOWED',
          'URL_SCHEME_NOT_ALLOWED',
          'URL_CREDENTIALS_NOT_ALLOWED',
          'HLS_ENCRYPTED',
        ].includes(o.failureCode)
          ? 'blocked_by_policy'
          : 'offline';
    } else if (decision.status === 'verified') {
      state = o.decodeErrors > 3 ? 'degraded' : 'eligible';
    } else {
      state = 'unverified';
    }
    // One commit for the source's new state and its history row: atomic, and one disk sync.
    this.#d.stations.transaction(() => this.#recordProbe(source, o, state, decision));
    return decision;
  }

  #recordProbe(
    source: StationSource,
    o: ProbeOutcome,
    state: VerificationState,
    decision: IdentityDecision,
  ): void {
    // A check whose sample was too short to measure keeps the earlier measurement of the same
    // stream, rather than falling back to codec metadata, which for AAC is only an estimate.
    const keepMeasured =
      o.success &&
      o.measuredBitrateKbps === null &&
      source.measuredBitrateKbps !== null &&
      source.codec === o.codec &&
      source.transport === o.transport;
    this.#d.stations.applyProbePatch(source.id, {
      lastProbeAt: o.startedAt,
      verificationState: state,
      effectiveHost: o.effectiveHost,
      ...(o.success
        ? {
            transport: o.transport,
            container: o.container,
            codec: o.codec,
            profile: o.profile,
            sampleRateHz: o.sampleRateHz,
            channels: o.channels,
            channelLayout: o.channelLayout,
            advertisedBitrateKbps: o.advertisedBitrateKbps,
            codecBitrateKbps: o.codecBitrateKbps,
            measuredBitrateKbps: keepMeasured ? source.measuredBitrateKbps : o.measuredBitrateKbps,
            bitrateConfidence: keepMeasured ? 'measured' : o.bitrateEvidence,
            qualityConfidence:
              keepMeasured || o.bitrateEvidence === 'measured' ? 'measured' : 'not-conclusive',
            icyName: o.icyName,
            startupMs: o.startupMs,
            identityStatus: decision.status,
            identityConfidence: decision.confidence,
            identityEvidence: decision.evidence,
          }
        : {}),
    });
    if (o.success) {
      this.#d.stations.recordSuccess(source.id);
      // A working check ends a hold early (the station came back): nothing else would play.
      if (state === 'eligible' && source.cooldownUntil && Date.parse(source.cooldownUntil) > Date.now()) {
        this.#d.stations.setCooldown(source.id, null);
        this.#failureStreaks.delete(source.id);
      }
    } else this.#d.stations.recordFailure(source.id, o.failureCode ?? 'PROBE_FAILED');
    this.#d.stations.insertProbeResult({
      sourceId: source.id,
      startedAt: o.startedAt,
      durationMs: o.durationMs,
      kind: 'basic',
      effectiveHost: o.effectiveHost,
      transport: o.transport,
      container: o.container,
      codec: o.codec,
      profile: o.profile,
      sampleRateHz: o.sampleRateHz,
      channels: o.channels,
      bitrateEstimate: o.measuredBitrateKbps ?? o.codecBitrateKbps ?? o.advertisedBitrateKbps,
      bitrateEvidence: o.bitrateEvidence,
      startupMs: o.startupMs,
      headersSummary: { ...o.headersSummary, networkKbps: o.networkKbps, decodeErrors: o.decodeErrors },
      manifestSummary: o.manifestSummary,
      identityEvidence: decision.evidence,
      success: o.success,
      failureCode: o.failureCode,
      failureDetail: o.failureDetail,
      confidence: decision.confidence,
      probeVersion: PROBE_VERSION,
    });
    this.#d.stations.pruneSourceHistory(source.id, this.#d.probeHistoryLimit ?? 30);
  }

  /**
   * Called when a live connection's metadata names a different catalogue station (FR-008).
   * Records the contradiction; unless audio correlation supports the source, it becomes a
   * mismatch and is excluded until re-verified.
   */
  flagIdentityContradiction(sourceId: string, detail: string): void {
    const source = this.#d.stations.getSource(sourceId);
    if (!source) return;
    const decision = decideIdentity(
      source,
      { verdict: 'contradicts', detail },
      latestCorrelation(source.identityEvidence),
    );
    this.#d.stations.applyProbePatch(sourceId, {
      identityStatus: decision.status,
      identityConfidence: decision.confidence,
      identityEvidence: decision.evidence,
      verificationState: decision.status === 'verified' ? source.verificationState : 'unverified',
    });
    this.#d.metrics.inc('source.identity_contradiction');
    this.#log.warn(
      { sourceId, detail, status: decision.status },
      'live metadata contradicts station identity',
    );
  }

  /** Re-evaluates identity without a network probe (e.g. after an admin override). */
  reevaluateIdentity(sourceId: string): IdentityDecision | null {
    const source = this.#d.stations.getSource(sourceId);
    const station = source ? this.#d.stations.getStation(source.stationId) : null;
    if (!source || !station) return null;
    const meta = source.icyName
      ? metadataSignal(
          station,
          this.#d.stations.listBuiltinStations(),
          source.icyName,
          this.#brand(station.provider),
        )
      : null;
    const decision = decideIdentity(source, meta, latestCorrelation(source.identityEvidence));
    const probedOk =
      source.codec !== null && source.verificationState !== 'offline' && source.lastProbeAt !== null;
    this.#d.stations.applyProbePatch(sourceId, {
      identityStatus: decision.status,
      identityConfidence: decision.confidence,
      identityEvidence: decision.evidence,
      ...(probedOk && source.verificationState !== 'blocked_by_policy'
        ? { verificationState: decision.status === 'verified' ? 'eligible' : 'unverified' }
        : {}),
    });
    return decision;
  }

  /** True when the source should be (re)probed before relying on it. */
  /**
   * True when the source should be (re)checked. `background` follows the back-off; `foreground` is
   * for a play with no working source, where failing sources are the only hope and are retried
   * every 10 min (hourly after a day). A paused source is never due either way.
   */
  needsProbe(s: StationSource, now = Date.now(), mode: 'background' | 'foreground' = 'background'): boolean {
    if (!s.enabled || s.rightsStatus === 'blocked') return false;
    if (s.lastProbeAt === null) return true;
    const age = now - Date.parse(s.lastProbeAt);
    // On hold after repeated failures: a play with nothing else to use checks it every couple of
    // minutes, and a successful check ends the hold, rather than leaving the station silent.
    if (mode === 'foreground' && s.cooldownUntil && Date.parse(s.cooldownUntil) > now) {
      const lastTry = Math.max(Date.parse(s.lastProbeAt), Date.parse(s.lastFailureAt ?? s.lastProbeAt));
      return now - lastTry >= COOLDOWN_RECHECK_MS;
    }
    // It failed in playback since its last check, while still working by its checks (a failed check
    // marks it offline or blocked instead, with their own waits): check it again a few minutes later,
    // so that a session that moved away can move back once it works.
    const onHold = s.cooldownUntil !== null && Date.parse(s.cooldownUntil) > now;
    const working =
      s.verificationState === 'eligible' ||
      s.verificationState === 'degraded' ||
      s.verificationState === 'cooldown';
    if (working && !onHold && s.lastFailureAt && s.lastFailureAt > s.lastProbeAt) {
      return now - Date.parse(s.lastFailureAt) >= PLAYBACK_FAILURE_RECHECK_MS;
    }
    if (s.verificationState === 'offline') {
      if (isPaused(s, now)) return false;
      if (mode === 'background') return now >= (nextAutomaticCheck(s) ?? 0);
      const failingFor = now - Date.parse(s.lastSuccessAt ?? s.createdAt);
      return age >= FOREGROUND_FLOOR_MS[failingFor < DAY_MS ? 0 : 1];
    }
    return age > PROBE_STALE_MS;
  }

  select(guildId: string, stationId: string, exclude?: ReadonlySet<string>): SelectionResult {
    return selectSource(this.sourcesFor(stationId), this.#d.guilds.getPreference(guildId, stationId), {
      exclude,
    });
  }

  /**
   * Returns a playable selection, probing in the foreground only when no eligible source
   * exists (PRD §7.6): candidates are probed best-first until one becomes eligible. Nothing
   * else is checked here: the session calls `refreshStation()` once its stream's settle period
   * is over, so background checks never compete with a stream that is starting up.
   */
  async prepareForPlayback(
    guildId: string,
    stationId: string,
    opts: { exclude?: ReadonlySet<string>; signal?: AbortSignal } = {},
  ): Promise<SelectionResult> {
    if (this.isStationDisabled(stationId)) {
      return this.select(guildId, stationId, opts.exclude);
    }
    let selection = this.select(guildId, stationId, opts.exclude);
    if (selection.selected) return selection;
    const sources = this.sourcesFor(stationId).filter((s) => !opts.exclude?.has(s.id));
    const stale = sources.filter((s) => this.needsProbe(s, Date.now(), 'foreground'));
    const pref = this.#d.guilds.getPreference(guildId, stationId);
    const order = [...stale].sort((a, b) => {
      if (pref?.sourceId === a.id) return -1;
      if (pref?.sourceId === b.id) return 1;
      if (a.transport === 'http-continuous' && b.transport !== 'http-continuous') return -1;
      if (b.transport === 'http-continuous' && a.transport !== 'http-continuous') return 1;
      return a.priority - b.priority;
    });
    for (const s of order) {
      if (selection.selected) break;
      try {
        await this.probe(s.id, { signal: opts.signal });
      } catch (err) {
        if (errorCode(err) === 'CANCELLED') throw err;
      }
      if (opts.signal?.aborted) throw new RadioError('CANCELLED', 'Replaced by a newer request.');
      selection = this.select(guildId, stationId, opts.exclude);
    }
    return selection;
  }

  /**
   * Re-checks a station's due sources in the background (once its stream's settle period is over).
   * The source that is playing is left alone: its steady playback is better evidence than a check,
   * which would open a second connection that some stations refuse.
   */
  refreshStation(stationId: string, playingSourceId?: string): void {
    if (this.isStationDisabled(stationId)) return;
    const due = this.sourcesFor(stationId).filter((s) => s.id !== playingSourceId && this.needsProbe(s));
    if (due.length > 0) this.refreshInBackground(due.map((s) => s.id));
  }

  /**
   * Queues background checks; they run one at a time (and each check at the lowest CPU priority).
   * A source already queued is not queued again, and whether it is still due is decided when its
   * turn comes: plays in several servers, failovers and reconnects all ask for the same checks.
   */
  refreshInBackground(sourceIds: string[]): void {
    for (const id of sourceIds) {
      if (this.#queued.has(id)) continue;
      this.#queued.add(id);
      this.#queue(
        async () => {
          this.#queued.delete(id);
          const s = this.#d.stations.getSource(id);
          if (!s || this.isStationDisabled(s.stationId) || !this.needsProbe(s)) return null;
          return this.#probeInBackground(id);
        },
        { automatic: true },
      ).catch((err: unknown) => {
        this.#queued.delete(id);
        this.#log.debug({ sourceId: id, code: errorCode(err) }, 'background probe failed');
      });
    }
  }

  /**
   * Runs other background work (a scheduled catalogue sync, say) under the same rules as background
   * checks: it waits for its turn in the same one-at-a-time queue, and then until no stream is
   * starting, so it never runs alongside a check or during a stream's first moments. `automatic`
   * work (nobody is waiting for it: a scheduled sync, the daily pack check) also waits out the
   * settle period after a stream's first audio; work a user asked for (an install) does not.
   */
  runInBackground<T>(fn: () => Promise<T>, opts: { automatic?: boolean } = {}): Promise<T> {
    return this.#queue(fn, { automatic: opts.automatic ?? false });
  }

  /**
   * A stream is starting: background work waits `ms` so it doesn't compete with its start-up, and
   * background checks running now that nobody is waiting for stop at once. They record nothing and
   * run again later (a full re-check queues its own again; the station's next refresh queues others).
   */
  holdBackground(ms: number): void {
    this.#holdUntil = Math.max(this.#holdUntil, Date.now() + ms);
    for (const [host, running] of this.#backgroundByHost) {
      this.#backgroundByHost.delete(host);
      running.abort.abort(STREAM_START);
      this.#log.debug({ host, interrupted: running.sourceId }, 'background check gave way to a stream start');
    }
  }

  /**
   * A stream has just started playing: automatic background work waits `ms` more, so nothing
   * competes with it while the listener's client is still settling (interface: SessionTimings
   * `backgroundSettleMs`). A shorter call never cuts a longer wait short.
   */
  settleBackground(ms: number): void {
    this.#settleUntil = Math.max(this.#settleUntil, Date.now() + ms);
  }

  /**
   * The one-at-a-time background queue. Automatic work waits out the settle period before taking
   * its turn, and gives its turn up again if a stream started meanwhile, so work a user asked for
   * never waits behind it for more than the hold.
   */
  async #queue<T>(fn: () => Promise<T>, opts: { automatic: boolean; signal?: AbortSignal }): Promise<T> {
    for (;;) {
      // Checked before awaiting, so that without a settle period the queue keeps its order.
      if (opts.automatic && this.#settling()) await this.#settled(opts.signal);
      const release = await this.#background.acquire(opts.signal);
      try {
        await this.#waitForHold(opts.signal);
        if (opts.automatic && this.#settling()) continue;
        return await fn();
      } finally {
        release();
      }
    }
  }

  async #waitForHold(signal?: AbortSignal): Promise<void> {
    for (let wait = this.#holdUntil - Date.now(); wait > 0; wait = this.#holdUntil - Date.now()) {
      try {
        await delay(wait, undefined, signal ? { signal } : undefined);
      } catch {
        throw new RadioError('CANCELLED', 'The background check was stopped.');
      }
    }
  }

  /** Whether automatic work must still wait: a settle deadline is ahead and its timer hasn't fired. */
  #settling(): boolean {
    return this.#settleUntil > this.#settledThrough && this.#settleUntil > Date.now();
  }

  /** Waits out the settle period, on one shared timer (unreferenced: it never delays an exit). */
  async #settled(signal?: AbortSignal): Promise<void> {
    while (this.#settling()) {
      let gate = this.#settleGate;
      if (!gate || gate.until !== this.#settleUntil) {
        const until = this.#settleUntil;
        gate = { until, done: delay(until - Date.now(), undefined, { ref: false }) };
        this.#settleGate = gate;
      }
      try {
        await (signal ? raceSignal(gate.done, signal) : gate.done);
      } catch {
        throw new RadioError('CANCELLED', 'The background check was stopped.');
      }
      // Fired: this deadline has passed for everyone, even if the wall clock says a moment short.
      // Only a later deadline (a stream started meanwhile) makes the work wait again.
      this.#settledThrough = Math.max(this.#settledThrough, gate.until);
      if (this.#settleGate === gate) this.#settleGate = null;
    }
  }

  /**
   * One check for "Check all sources again": queued with the other background checks (one at a
   * time, at the lowest CPU priority, and waiting while any stream is starting), then run whatever
   * the source's back-off, hold or pause says. A source that passes can be used at once; one that
   * fails is recorded as usual, so its back-off and pause carry on. `want` is asked when its turn
   * comes, so a source switched off or removed meanwhile is skipped (null). A play's check of the
   * same host interrupts it (CANCELLED, nothing recorded), as it does any background check. It is
   * automatic work, so it also waits out the settle period after a stream's first audio; a stream
   * starting while it runs interrupts it, and it then simply queues again (that is no give-way).
   * Stopping `signal` ends the wait at once; a play that joined the check still gets its result.
   */
  async checkInBackground(
    sourceId: string,
    signal: AbortSignal,
    want: (source: StationSource) => boolean,
  ): Promise<{ before: StationSource; report: ProbeReport } | null> {
    for (;;) {
      try {
        return await this.#queue(
          async () => {
            if (signal.aborted) throw new RadioError('CANCELLED', 'The background check was stopped.');
            const s = this.#d.stations.getSource(sourceId);
            if (!s || !this.checkable(s) || !want(s)) return null;
            const report = await this.#probeInBackground(sourceId, signal);
            return { before: s, report };
          },
          { automatic: true, signal },
        );
      } catch (err) {
        if (!(err instanceof GaveWayToStart) || signal.aborted) throw err;
      }
    }
  }

  /**
   * Whether a source is one a check could make usable: enabled by its pack, not switched off by
   * the bot owner (DISABLED_SOURCE_IDS, DISABLED_STATION_IDS) and not blocked for rights.
   */
  checkable(s: StationSource): boolean {
    return (
      s.enabled &&
      s.rightsStatus !== 'blocked' &&
      !this.isStationDisabled(s.stationId) &&
      !this.#d.disabledSourceIds?.has(s.id)
    );
  }

  /**
   * Probes every enabled source of a station (admin rescan), one after another; `onProgress`
   * hears after each one. It ignores any back-off: an admin asked for it.
   */
  async rescanStation(
    stationId: string,
    signal?: AbortSignal,
    onProgress?: (done: number, total: number) => void,
  ): Promise<ProbeReport[]> {
    const sources = this.sourcesFor(stationId).filter((x) => x.enabled);
    const reports: ProbeReport[] = [];
    for (const s of sources) {
      reports.push(await this.probe(s.id, { signal }));
      onProgress?.(reports.length, sources.length);
    }
    return reports;
  }

  /**
   * Time-aligned identity comparison (PRD FR-005 step 3–4): compares each candidate that is
   * not yet verified (or all, if `all`) against the best currently verified source.
   */
  async deepVerify(
    guildId: string,
    stationId: string,
    opts: { all?: boolean; signal?: AbortSignal } = {},
  ): Promise<Array<{ sourceId: string; evidence: IdentityEvidence | null; error: string | null }>> {
    const selection = this.select(guildId, stationId);
    const incumbent = selection.selected;
    if (!incumbent)
      throw new RadioError('NO_ELIGIBLE_SOURCE', 'There is no verified source to compare against.');
    const targets = this.sourcesFor(stationId).filter(
      (s) => s.id !== incumbent.id && s.enabled && (opts.all || s.identityStatus !== 'verified'),
    );
    const results: Array<{ sourceId: string; evidence: IdentityEvidence | null; error: string | null }> = [];
    for (const t of targets) {
      try {
        const r = await this.#global.run(
          () =>
            correlate(
              {
                client: this.#d.client,
                registry: this.#d.registry,
                ffmpegPath: this.#d.ffmpegPath,
                ffprobePath: this.#d.ffprobePath,
              },
              incumbent.url,
              t.url,
              { signal: opts.signal, owner: `identity:${t.id}` },
            ),
          opts.signal,
        );
        const ev = correlationEvidence(r, `verified source ${incumbent.id}`);
        const kept = t.identityEvidence.filter((e) => e.kind !== 'correlation');
        this.#d.stations.applyProbePatch(t.id, { identityEvidence: [...kept, ev] });
        this.reevaluateIdentity(t.id);
        results.push({ sourceId: t.id, evidence: ev, error: null });
      } catch (err) {
        results.push({
          sourceId: t.id,
          evidence: null,
          error: err instanceof RadioError ? err.userMessage : 'comparison failed',
        });
      }
    }
    return results;
  }

  // ---- playback health feedback ----

  recordPlaybackSuccess(sourceId: string): void {
    this.#failureStreaks.delete(sourceId);
    this.#d.stations.recordSuccess(sourceId);
    const s = this.#d.stations.getSource(sourceId);
    // Steady playback proves the source works: a failed background check (a second connection the
    // station refused, say) or an expired hold no longer counts against it.
    if (
      s &&
      (s.verificationState === 'offline' ||
        (s.verificationState === 'cooldown' &&
          (!s.cooldownUntil || Date.parse(s.cooldownUntil) <= Date.now())))
    ) {
      this.#d.stations.applyProbePatch(sourceId, { verificationState: 'eligible' });
    }
  }

  /**
   * Records a playback failure; trips the circuit breaker after repeated failures over at least a
   * minute. Returns true if tripped.
   */
  recordPlaybackFailure(sourceId: string, code: string, now = Date.now()): boolean {
    const prev = this.#failureStreaks.get(sourceId);
    if (prev && now - prev.last < FAILURE_DEDUP_MS) return false;
    const consecutive = this.#d.stations.recordFailure(sourceId, code);
    // The first failure after any success (a check, or steady playback) starts a new streak.
    const streak = prev && consecutive > 1 ? { since: prev.since, last: now } : { since: now, last: now };
    this.#failureStreaks.set(sourceId, streak);
    if (consecutive >= CIRCUIT_BREAK_FAILURES && now - streak.since >= CIRCUIT_BREAK_MIN_SPAN_MS) {
      this.#failureStreaks.delete(sourceId);
      const s = this.#d.stations.getSource(sourceId);
      const until = new Date(Date.now() + cooldownMs((s?.cooldownTrips ?? 0) + 1)).toISOString();
      this.#d.stations.setCooldown(sourceId, until);
      this.#d.metrics.inc('source.circuit_break');
      this.#log.warn({ sourceId, until, code }, 'source circuit-broken');
      return true;
    }
    return false;
  }

  // ---- availability ----

  /** Whether a source is switched on, by its pack and by the bot owner (the station aside). */
  #sourceOn(s: StationSource): boolean {
    return s.enabled && !this.#d.disabledSourceIds?.has(s.id);
  }

  /**
   * How a station stands for listing it. Browse and lists ask this for every station they show,
   * so it reads the cached sources as they are, with no copies and no reason strings.
   */
  availability(station: Station, now = Date.now()): StationAvailability {
    if (station.catalogueStatus === 'retired') return 'retired';
    const stationOff = this.isStationDisabled(station.id);
    let enabled = 0;
    let eligible = 0;
    let best = Number.NEGATIVE_INFINITY;
    let allDegraded = true;
    let unverified = false;
    if (!stationOff) {
      for (const s of this.#d.stations.listSources(station.id)) {
        if (!this.#sourceOn(s)) continue;
        enabled++;
        if (isEligibleNow(s, now)) {
          eligible++;
          if (s.healthScore > best) best = s.healthScore;
          if (s.verificationState !== 'degraded') allDegraded = false;
        }
        if (s.lastProbeAt === null || (s.identityStatus === 'unverified' && s.codec !== null))
          unverified = true;
      }
    }
    if (enabled === 0) return stationOff ? 'unavailable' : 'no_source';
    if (eligible > 0) return best < 30 || allDegraded ? 'degraded' : 'available';
    return unverified ? 'unverified' : 'unavailable';
  }

  coverage(stations: readonly Station[], now = Date.now()): CoverageCounts {
    let withSources = 0;
    let usable = 0;
    let verifiedPlayable = 0;
    for (const st of stations) {
      if (this.isStationDisabled(st.id)) continue;
      let any = false;
      let working = false;
      let eligible = false;
      for (const s of this.#d.stations.listSources(st.id)) {
        if (!this.#sourceOn(s)) continue;
        any = true;
        if (!working && s.codec !== null && s.lastSuccessAt !== null) working = true;
        if (!eligible && isEligibleNow(s, now)) eligible = true;
        if (working && eligible) break;
      }
      if (any) withSources++;
      if (working) usable++;
      if (eligible) verifiedPlayable++;
    }
    return { catalogued: stations.length, withSources, usable, verifiedPlayable };
  }

  /**
   * `coverage()` of every station of a pack that isn't retired (what browse and `/radio stats`
   * list for it), cached: the same answer until a station or source changes, the bot owner's
   * switches change, or a minute has passed (holds end with time). Not for custom stations.
   */
  coverageByProvider(provider: string, now = Date.now()): CoverageCounts {
    const key = `${this.#d.stations.changeCount}/${this.#d.disabledSourceIds?.size ?? 0}/${this.#d.disabledStationIds?.size ?? 0}`;
    const hit = this.#coverage.get(provider);
    if (hit && hit.key === key && now >= hit.at && now - hit.at < COVERAGE_MAX_AGE_MS)
      return { ...hit.counts };
    const stations = this.#d.stations
      .listProviderStations(provider)
      .filter((st) => st.catalogueStatus !== 'retired');
    const counts = this.coverage(stations, now);
    this.#coverage.set(provider, { key, at: now, counts });
    return { ...counts };
  }
}

/** Why a check was interrupted, as the error its callers see (CANCELLED either way). */
function interrupted(signal: AbortSignal): RadioError {
  if (signal.reason === STREAM_START) return new GaveWayToStart();
  if (signal.reason === STOPPED) return new RadioError('CANCELLED', 'The background check was stopped.');
  return new RadioError('CANCELLED', 'The background check gave way to playback.');
}

function latestCorrelation(evidence: IdentityEvidence[]): IdentityEvidence | null {
  const list = evidence.filter((e) => e.kind === 'correlation');
  return list.length > 0 ? list[list.length - 1]! : null;
}

function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new RadioError('CANCELLED', 'The stream check was cancelled.'));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}
