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
import { KeyedSemaphore, Semaphore } from '../shared/async.ts';
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
import { checkEligibility, type SelectionResult, selectSource } from './ranking.ts';
import type { SafeHttpClient } from './safe-fetch.ts';

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
/**
 * Consecutive playback failures before a source is circuit-broken: the first failure plus one per
 * same-source retry step (the session's backoff of about 1, 3 and 8 s), so every retry runs first.
 */
export const CIRCUIT_BREAK_FAILURES = 4;

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
  readonly #inflight = new Map<string, Promise<ProbeReport>>();
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
          ? { ...s, enabled: false, disabledReason: 'disabled by the operator (takedown/disable list)' }
          : s,
      );
  }

  /** Probes one source (deduplicated, rate-bounded: global and per-host limits). */
  probe(sourceId: string, opts: { signal?: AbortSignal; budget?: ProbeBudget } = {}): Promise<ProbeReport> {
    if (opts.signal?.aborted)
      return Promise.reject(new RadioError('CANCELLED', 'The stream check was cancelled.'));
    let shared = this.#inflight.get(sourceId);
    if (!shared) {
      // The probe itself is bounded by its own budget and is not tied to any caller's signal,
      // so one guild cancelling never records a failure or cancels another guild's wait.
      shared = this.#probeNow(sourceId, { budget: opts.budget }).finally(() =>
        this.#inflight.delete(sourceId),
      );
      this.#inflight.set(sourceId, shared);
    }
    return opts.signal ? raceSignal(shared, opts.signal) : shared;
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
    const outcome = await this.#global.run(
      () =>
        this.#perHost.run(
          host,
          () =>
            probeSource(
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
    const others = this.#d.stations.listBuiltinStations();
    const meta = o.success ? metadataSignal(station, others, o.icyName, this.#brand(station.provider)) : null;
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
            measuredBitrateKbps: o.measuredBitrateKbps,
            bitrateConfidence: o.bitrateEvidence,
            qualityConfidence: o.bitrateEvidence === 'measured' ? 'measured' : 'not-conclusive',
            icyName: o.icyName,
            startupMs: o.startupMs,
            identityStatus: decision.status,
            identityConfidence: decision.confidence,
            identityEvidence: decision.evidence,
          }
        : {}),
    });
    if (o.success) this.#d.stations.recordSuccess(source.id);
    else this.#d.stations.recordFailure(source.id, o.failureCode ?? 'PROBE_FAILED');
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
    return decision;
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
  needsProbe(s: StationSource, now = Date.now()): boolean {
    if (!s.enabled || s.rightsStatus === 'blocked') return false;
    if (s.lastProbeAt === null) return true;
    const age = now - Date.parse(s.lastProbeAt);
    if (s.verificationState === 'offline') return now >= (nextAutomaticCheck(s) ?? 0);
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
   * else is checked here: the session calls `refreshStation()` once its stream has played
   * steadily, so background checks never compete with a stream that is starting up.
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
    const sources = this.sourcesFor(stationId).filter((s) => !opts.exclude?.has(s.id));
    const stale = sources.filter((s) => this.needsProbe(s));
    if (selection.selected) return selection;
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

  /** Re-checks a station's due sources in the background (after its stream has played steadily). */
  refreshStation(stationId: string): void {
    if (this.isStationDisabled(stationId)) return;
    const due = this.sourcesFor(stationId).filter((s) => this.needsProbe(s));
    if (due.length > 0) this.refreshInBackground(due.map((s) => s.id));
  }

  /** Queues background checks; they run one at a time (and each check at the lowest CPU priority). */
  refreshInBackground(sourceIds: string[]): void {
    for (const id of sourceIds) {
      this.#background
        .run(() => this.probe(id))
        .catch((err: unknown) =>
          this.#log.debug({ sourceId: id, code: errorCode(err) }, 'background probe failed'),
        );
    }
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
    this.#d.stations.recordSuccess(sourceId);
    const s = this.#d.stations.getSource(sourceId);
    if (
      s &&
      s.verificationState === 'cooldown' &&
      (!s.cooldownUntil || Date.parse(s.cooldownUntil) <= Date.now())
    ) {
      this.#d.stations.applyProbePatch(sourceId, { verificationState: 'eligible' });
    }
  }

  /** Records a playback failure; trips the circuit breaker after repeated failures. Returns true if tripped. */
  recordPlaybackFailure(sourceId: string, code: string): boolean {
    const consecutive = this.#d.stations.recordFailure(sourceId, code);
    if (consecutive >= CIRCUIT_BREAK_FAILURES) {
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

  availability(station: Station): StationAvailability {
    if (station.catalogueStatus === 'retired') return 'retired';
    const sources = this.sourcesFor(station.id).filter((s) => s.enabled);
    if (sources.length === 0) return this.isStationDisabled(station.id) ? 'unavailable' : 'no_source';
    const now = Date.now();
    const eligible = sources.filter((s) => checkEligibility(s, now).eligible);
    if (eligible.length > 0) {
      const best = Math.max(...eligible.map((s) => s.healthScore));
      return best < 30 || eligible.every((s) => s.verificationState === 'degraded')
        ? 'degraded'
        : 'available';
    }
    if (
      sources.some((s) => s.lastProbeAt === null || (s.identityStatus === 'unverified' && s.codec !== null))
    ) {
      return 'unverified';
    }
    return 'unavailable';
  }

  coverage(stations: Station[]): CoverageCounts {
    const now = Date.now();
    let withSources = 0;
    let usable = 0;
    let verifiedPlayable = 0;
    for (const st of stations) {
      const sources = this.sourcesFor(st.id).filter((s) => s.enabled);
      if (sources.length > 0) withSources++;
      if (sources.some((s) => s.codec !== null && s.lastSuccessAt !== null)) usable++;
      if (sources.some((s) => checkEligibility(s, now).eligible)) verifiedPlayable++;
    }
    return { catalogued: stations.length, withSources, usable, verifiedPlayable };
  }
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
