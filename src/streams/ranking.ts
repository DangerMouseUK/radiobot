import type { StationSource } from '../catalogue/types.ts';
import type { SourcePreference } from '../persistence/repositories/guilds.ts';
import { codecLabel } from './probe.ts';

export type QualityConclusion =
  | 'higher-quality-verified'
  | 'no-higher-quality-source-verified'
  | 'not-conclusively-determined'
  | 'higher-quality-source-ranked-lower'
  | 'single-source'
  | 'no-eligible-source';

export const CONCLUSION_TEXT: Record<QualityConclusion, string> = {
  'higher-quality-verified': 'Measurements show this source has better audio than the others.',
  'no-higher-quality-source-verified':
    'The sources carry equivalent audio; none was verified as higher quality.',
  'not-conclusively-determined':
    'Whether one source sounds better was not conclusively determined (different codecs are not compared by bitrate).',
  'higher-quality-source-ranked-lower':
    'A source with measurably better audio exists but ranks lower, because of how it is delivered, its reliability or an admin’s choice.',
  'single-source': 'Only one verified source can be used right now.',
  'no-eligible-source': 'No verified, working source is available right now.',
};

export interface EligibilityReport {
  sourceId: string;
  eligible: boolean;
  reasons: string[];
}

export interface SelectionResult {
  mode: SourcePreference['mode'];
  selected: StationSource | null;
  fallback: StationSource | null;
  ordered: StationSource[];
  eligibility: EligibilityReport[];
  conclusion: QualityConclusion;
  degraded: boolean;
  explanation: string[];
}

/** PRD §7.4 eligibility gate. Correctness first: identity must be verified. */
export function checkEligibility(s: StationSource, now: number): EligibilityReport {
  const reasons: string[] = [];
  if (!s.enabled) reasons.push(`disabled${s.disabledReason ? `: ${s.disabledReason}` : ''}`);
  if (s.rightsStatus === 'blocked') reasons.push('blocked by rights/takedown policy');
  if (s.identityStatus === 'mismatch') reasons.push('plays a different station (identity mismatch)');
  else if (s.identityStatus !== 'verified') reasons.push('not verified as this station');
  if (s.verificationState === 'blocked_by_policy') reasons.push('rejected by URL safety policy');
  if (s.verificationState === 'discovered' || s.verificationState === 'resolved' || s.lastProbeAt === null) {
    reasons.push('not checked yet');
  } else if (s.verificationState === 'offline') {
    reasons.push(`last check failed${s.lastFailureCode ? ` (${s.lastFailureCode})` : ''}`);
  } else if (!s.codec) {
    reasons.push('codec not verified');
  }
  if (s.cooldownUntil && Date.parse(s.cooldownUntil) > now) {
    reasons.push(
      `cooling down after repeated failures until ${s.cooldownUntil.slice(0, 16).replace('T', ' ')} UTC`,
    );
  }
  return { sourceId: s.id, eligible: reasons.length === 0, reasons };
}

/** Best bitrate evidence available, with its strength. */
export function effectiveBitrate(s: StationSource): { kbps: number | null; strong: boolean } {
  if (s.measuredBitrateKbps !== null) return { kbps: s.measuredBitrateKbps, strong: true };
  if (s.codecBitrateKbps !== null) return { kbps: s.codecBitrateKbps, strong: true };
  return { kbps: s.advertisedBitrateKbps, strong: false };
}

function codecFamily(s: StationSource): string {
  return codecLabel(s.codec, s.profile);
}

export type FidelityRelation = 'a' | 'b' | 'equal' | 'inconclusive';

/**
 * Compares demonstrated fidelity evidence. Never ranks across codecs by bitrate alone; a
 * clear channel-count or audio-bandwidth (sample-rate) difference is accepted as evidence.
 */
export function compareFidelity(
  a: StationSource,
  b: StationSource,
): { relation: FidelityRelation; reason: string } {
  if (a.channels && b.channels && a.channels !== b.channels && Math.min(a.channels, b.channels) === 1) {
    return a.channels > b.channels
      ? { relation: 'a', reason: 'stereo vs mono' }
      : { relation: 'b', reason: 'stereo vs mono' };
  }
  if (a.sampleRateHz && b.sampleRateHz) {
    const lo = Math.min(a.sampleRateHz, b.sampleRateHz);
    const hi = Math.max(a.sampleRateHz, b.sampleRateHz);
    if (lo < 32_000 && hi >= 44_100) {
      return a.sampleRateHz > b.sampleRateHz
        ? { relation: 'a', reason: `${hi / 1000} kHz vs ${lo / 1000} kHz audio bandwidth` }
        : { relation: 'b', reason: `${hi / 1000} kHz vs ${lo / 1000} kHz audio bandwidth` };
    }
  }
  const fa = codecFamily(a);
  const fb = codecFamily(b);
  if (fa === 'unknown' || fb === 'unknown') return { relation: 'inconclusive', reason: 'codec unknown' };
  if (fa !== fb)
    return { relation: 'inconclusive', reason: `${fa} vs ${fb}: different codecs are not ranked by bitrate` };
  const ba = effectiveBitrate(a);
  const bb = effectiveBitrate(b);
  if (ba.kbps === null || bb.kbps === null)
    return { relation: 'inconclusive', reason: 'bitrate not measured' };
  const ratio = Math.max(ba.kbps, bb.kbps) / Math.max(1, Math.min(ba.kbps, bb.kbps));
  if (ratio < 1.15) return { relation: 'equal', reason: `both ≈${Math.round(ba.kbps)} kbps ${fa}` };
  if (!ba.strong || !bb.strong) {
    return { relation: 'inconclusive', reason: 'bitrate difference only advertised, not measured' };
  }
  return ba.kbps > bb.kbps
    ? { relation: 'a', reason: `${Math.round(ba.kbps)} vs ${Math.round(bb.kbps)} kbps ${fa}` }
    : { relation: 'b', reason: `${Math.round(bb.kbps)} vs ${Math.round(ba.kbps)} kbps ${fa}` };
}

/**
 * Delivery tiers. Direct continuous streams always come first: HLS delivers audio in segments,
 * which makes live playback start slower and recover less smoothly, so it is only a last-resort
 * fallback when no direct stream is eligible — whatever its measured quality.
 */
const TRANSPORT_TIER: Record<string, number> = { 'http-continuous': 0, unknown: 1, hls: 2 };

export function transportTier(s: Pick<StationSource, 'transport'>): number {
  return TRANSPORT_TIER[s.transport] ?? 1;
}

/** Negative if a should be preferred over b. */
export function compareSources(a: StationSource, b: StationSource): number {
  const tier = transportTier(a) - transportTier(b);
  if (tier !== 0) return tier;
  const fid = compareFidelity(a, b).relation;
  if (fid === 'a') return -1;
  if (fid === 'b') return 1;
  const health = b.healthScore - a.healthScore;
  if (Math.abs(health) >= 20) return health;
  if (a.startupMs !== null && b.startupMs !== null && Math.abs(a.startupMs - b.startupMs) > 1500) {
    return a.startupMs - b.startupMs;
  }
  return a.priority - b.priority || a.id.localeCompare(b.id);
}

function describe(s: StationSource): string {
  const br = effectiveBitrate(s).kbps;
  const transport =
    s.transport === 'hls' ? 'HLS' : s.transport === 'http-continuous' ? 'direct' : 'unknown-delivery';
  return `${transport} ${codecFamily(s)}${br !== null ? ` ≈${Math.round(br)} kbps` : ''}`;
}

/**
 * Correctness-gated, multi-criteria source selection (PRD FR-006, §7.4). Returns the chosen
 * source, a distinct eligible fallback, and a human-readable explanation of the decision.
 */
export function selectSource(
  sources: StationSource[],
  preference: SourcePreference | null,
  opts: { now?: number; exclude?: ReadonlySet<string> } = {},
): SelectionResult {
  const now = opts.now ?? Date.now();
  const eligibility = sources.map((s) => {
    const r = checkEligibility(s, now);
    if (opts.exclude?.has(s.id))
      return { ...r, eligible: false, reasons: [...r.reasons, 'skipped because it just failed'] };
    return r;
  });
  const eligibleIds = new Set(eligibility.filter((e) => e.eligible).map((e) => e.sourceId));
  // compareSources is not a total order (fidelity only compares within a codec family), so
  // start from a fixed order: the choice then never depends on database row order.
  const ordered = sources
    .filter((s) => eligibleIds.has(s.id))
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    .sort(compareSources);
  const mode = preference?.mode ?? 'auto';
  const explanation: string[] = [];
  let degraded = false;

  if (ordered.length === 0) {
    explanation.push('No source is both verified as this station and working right now.');
    return {
      mode,
      selected: null,
      fallback: null,
      ordered,
      eligibility,
      conclusion: 'no-eligible-source',
      degraded: true,
      explanation,
    };
  }

  let selected = ordered[0]!;
  if (mode !== 'auto' && preference?.sourceId) {
    const pinned = ordered.find((s) => s.id === preference.sourceId);
    if (pinned) {
      selected = pinned;
      explanation.push(`Using the ${mode === 'pin' ? 'pinned' : 'preferred'} source an admin chose.`);
    } else if (mode === 'pin') {
      degraded = true;
      const why =
        eligibility.find((e) => e.sourceId === preference.sourceId)?.reasons.join('; ') ?? 'source removed';
      explanation.push(`Degraded: the pinned source can’t be used (${why}), so a fallback is playing.`);
    } else {
      explanation.push('Preferred source is unavailable, so the bot chose one automatically.');
    }
  }
  const fallback = ordered.find((s) => s.id !== selected.id) ?? null;

  let conclusion: QualityConclusion;
  if (ordered.length === 1) {
    conclusion = 'single-source';
    explanation.push(`Only one usable source: ${describe(selected)}.`);
  } else {
    const relations = ordered
      .filter((s) => s.id !== selected.id)
      .map((o) => ({ o, r: compareFidelity(selected, o) }));
    if (relations.every((x) => x.r.relation === 'a')) {
      conclusion = 'higher-quality-verified';
      explanation.push(`Selected ${describe(selected)}: ${relations.map((x) => x.r.reason).join('; ')}.`);
    } else if (relations.every((x) => x.r.relation === 'equal')) {
      conclusion = 'no-higher-quality-source-verified';
      const why =
        selected.transport === 'http-continuous' && relations.some((x) => x.o.transport === 'hls')
          ? 'direct feed selected for simpler live delivery'
          : 'selected on stability, latency and catalogue order';
      explanation.push(`All usable sources carry equivalent audio (${relations[0]!.r.reason}); ${why}.`);
      explanation.push('No independently verified higher-quality source found.');
    } else if (relations.some((x) => x.r.relation === 'b')) {
      // The evidence is conclusive; the better source lost on something other than fidelity.
      conclusion = 'higher-quality-source-ranked-lower';
      const better = relations.filter((x) => x.r.relation === 'b');
      const why = (o: StationSource) =>
        transportTier(o) > transportTier(selected)
          ? 'direct streams come before HLS whatever their bitrate'
          : mode !== 'auto' && preference?.sourceId === selected.id
            ? 'an admin chose the selected source'
            : 'it ranks lower on stability or start-up time';
      explanation.push(
        `Selected ${describe(selected)}; ${better.map((x) => `${describe(x.o)} measures higher (${x.r.reason}) but ${why(x.o)}`).join('; ')}.`,
      );
    } else {
      conclusion = 'not-conclusively-determined';
      explanation.push(
        `Selected ${describe(selected)}; quality versus ${relations.map((x) => `${describe(x.o)} (${x.r.reason})`).join(', ')} is not conclusively determined.`,
      );
    }
  }
  if (selected.transport === 'hls' && ordered.some((s) => s.transport !== 'hls')) {
    explanation.push('An admin chose this HLS source; a usable direct stream would normally come first.');
  } else if (selected.transport === 'hls') {
    explanation.push('Only HLS is available right now; no direct stream of this station can be used.');
  } else if (ordered.some((s) => s.transport === 'hls')) {
    explanation.push('HLS sources are kept as a last-resort fallback (segmented delivery).');
  }
  if (fallback) explanation.push(`Fallback: ${describe(fallback)}.`);
  return { mode, selected, fallback, ordered, eligibility, conclusion, degraded, explanation };
}
