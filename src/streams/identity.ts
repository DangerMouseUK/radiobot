import { runWithInput } from '../audio/ffmpeg.ts';
import type {
  Confidence,
  IdentityEvidence,
  IdentityStatus,
  Station,
  StationSource,
} from '../catalogue/types.ts';
import { linkedSignal } from '../shared/async.ts';
import { RadioError } from '../shared/errors.ts';
import { normalizeName } from '../shared/text.ts';
import { openSourceInput } from './input.ts';
import { collectSample, type ProbeDeps } from './probe.ts';

export interface MetadataSignal {
  verdict: IdentityEvidence['verdict'];
  detail: string;
}

/**
 * Compares in-band stream naming (icy-name) with the requested station. Only a clear
 * statement that the feed is a *different catalogue station* counts as contradiction;
 * brand labels and unrelated text are inconclusive.
 */
export function metadataSignal(
  station: Station,
  otherStations: Station[],
  icyName: string | null,
  /** Normalised publisher/brand labels of the station's pack (§3.1): never evidence either way. */
  brandLabels: ReadonlySet<string> = new Set(),
): MetadataSignal {
  if (!icyName) return { verdict: 'inconclusive', detail: 'No stream name metadata.' };
  const meta = normalizeName(icyName);
  if (!meta || brandLabels.has(meta)) {
    return {
      verdict: 'inconclusive',
      detail: `Stream name "${icyName}" is a brand label, not a programme name.`,
    };
  }
  const own = [station.displayName, ...station.aliases]
    .map(normalizeName)
    .filter((n) => n && !brandLabels.has(n));
  // Exact name of another station first: a short alias of this station (e.g. "XY") must never
  // turn another station's name ("XY DANCE") into support, whatever brand labels a pack declares.
  const other = otherStations.find((s) => s.id !== station.id && normalizeName(s.displayName) === meta);
  if (other && !own.includes(meta)) {
    return {
      verdict: 'contradicts',
      detail: `Stream name "${icyName}" is the name of a different station (${other.displayName}).`,
    };
  }
  if (own.some((n) => meta === n || containsWords(meta, n))) {
    return { verdict: 'supports', detail: `Stream name "${icyName}" matches this station.` };
  }
  return {
    verdict: 'inconclusive',
    detail: `Stream name "${icyName}" does not identify a catalogue station.`,
  };
}

function containsWords(haystack: string, needle: string): boolean {
  return ` ${haystack} `.includes(` ${needle} `);
}

export interface IdentityDecision {
  status: IdentityStatus;
  confidence: Confidence;
  evidence: IdentityEvidence[];
  summary: string;
}

/**
 * Combines identity signals (PRD FR-005). Ordered rules:
 *  1. An administrator override is authoritative (recorded as evidence).
 *  2. A time-aligned audio correlation with an already-verified source is strong support.
 *  3. A metadata contradiction without correlation support → mismatch (never auto-promoted).
 *  4. Official/curated provenance or an admin-declared custom URL → verified (medium).
 *  5. Anything else → unverified.
 * A correlation *failure* alone never demotes an established source: a few seconds of
 * differing adverts is not proof of a different programme.
 */
export function decideIdentity(
  source: Pick<StationSource, 'provenance' | 'provenanceDetail' | 'identityOverride'>,
  metadata: MetadataSignal | null,
  correlation: IdentityEvidence | null,
  now = new Date().toISOString(),
): IdentityDecision {
  const evidence: IdentityEvidence[] = [];
  const provenanceSupports = source.provenance === 'official-player' || source.provenance === 'curated';
  if (source.provenance === 'custom-user') {
    evidence.push({
      kind: 'declared',
      verdict: 'supports',
      detail: 'Added by a server admin for this custom station.',
      at: now,
    });
  } else {
    evidence.push({
      kind: 'provenance',
      verdict: provenanceSupports ? 'supports' : 'inconclusive',
      detail:
        source.provenance === 'official-player'
          ? `Linked to this station by the broadcaster’s own player or website. ${source.provenanceDetail ?? ''}`.trim()
          : source.provenance === 'curated'
            ? `Linked to this station in a reviewed list, with recorded evidence. ${source.provenanceDetail ?? ''}`.trim()
            : 'Found automatically; nothing official links it to this station.',
      at: now,
    });
  }
  if (metadata)
    evidence.push({ kind: 'metadata', verdict: metadata.verdict, detail: metadata.detail, at: now });
  if (correlation) evidence.push(correlation);

  if (source.identityOverride) {
    evidence.push({
      kind: 'admin-override',
      verdict: source.identityOverride === 'verified' ? 'supports' : 'contradicts',
      detail: `An admin reviewed this source and marked it as ${source.identityOverride === 'verified' ? 'the right station' : 'the wrong station'}.`,
      at: now,
    });
    return {
      status: source.identityOverride,
      confidence: 'high',
      evidence,
      summary: `An admin marked it as ${source.identityOverride === 'verified' ? 'the right station' : 'the wrong station'}.`,
    };
  }
  const correlated = correlation?.verdict === 'supports';
  if (metadata?.verdict === 'contradicts' && !correlated) {
    return { status: 'mismatch', confidence: 'medium', evidence, summary: metadata.detail };
  }
  if (correlated) {
    return {
      status: 'verified',
      confidence: 'high',
      evidence,
      summary: 'Its audio matches an already verified stream of this station.',
    };
  }
  if (provenanceSupports || source.provenance === 'custom-user') {
    const metaBoost = metadata?.verdict === 'supports';
    return {
      status: 'verified',
      confidence: metaBoost ? 'high' : 'medium',
      evidence,
      summary:
        source.provenance === 'custom-user'
          ? 'Custom station URL added by a server admin.'
          : `Verified by ${source.provenance === 'official-player' ? 'the broadcaster’s own player or website' : 'a reviewed list'}${
              metaBoost ? ' and stream metadata' : ''
            }.`,
    };
  }
  return {
    status: 'unverified',
    confidence: 'low',
    evidence,
    summary:
      'Nothing official links it to this station and no audio match yet; it needs an admin review or an audio comparison.',
  };
}

// ---------------------------------------------------------------- audio correlation

export const ENVELOPE_RATE_HZ = 100;
const PCM_RATE = 8000;

/** Log-energy onset envelope of mono s16le PCM at ENVELOPE_RATE_HZ (100 frames/s), z-normalised. */
export function onsetEnvelope(pcm: Int16Array, sampleRate = PCM_RATE): Float64Array {
  const frame = Math.floor(sampleRate / ENVELOPE_RATE_HZ);
  const n = Math.floor(pcm.length / frame);
  const energy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < frame; j++) {
      const v = pcm[i * frame + j]! / 32768;
      sum += v * v;
    }
    energy[i] = Math.log10(sum / frame + 1e-9);
  }
  const onset = new Float64Array(Math.max(0, n - 1));
  // Signed energy flux: keeps the direction and size of level changes, so two programmes that
  // merely share a tempo do not line up the way identical audio does.
  for (let i = 1; i < n; i++) onset[i - 1] = energy[i]! - energy[i - 1]!;
  // Drop the first and last second: every decode starts and ends with the same kind of jump
  // (silence to audio), which would otherwise line two unrelated stations up at a lag of 0.
  const edge = ENVELOPE_RATE_HZ;
  const trimmed = onset.length > edge * 6 ? onset.slice(edge, onset.length - edge) : onset;
  // Clip extreme outliers so one transient cannot dominate the correlation.
  const clipped = zNormalise(trimmed).map((v) => Math.max(-4, Math.min(4, v)));
  return zNormalise(clipped);
}

function zNormalise(x: Float64Array): Float64Array {
  if (x.length === 0) return x;
  let mean = 0;
  for (const v of x) mean += v;
  mean /= x.length;
  let variance = 0;
  for (const v of x) variance += (v - mean) ** 2;
  const sd = Math.sqrt(variance / x.length) || 1;
  return x.map((v) => (v - mean) / sd);
}

export interface CorrelationResult {
  score: number;
  lagSeconds: number;
  /** Peak relative to the spread of other lags; >~4 means a distinct alignment. */
  prominence: number;
  /**
   * Best peak divided by the best peak more than 0.5 s away from it. Repetitive material
   * (a shared beat grid) produces several similar peaks and a ratio near 1.
   */
  uniqueness: number;
  overlapSeconds: number;
}

/**
 * Normalised cross-correlation of two envelopes over ±maxLagSeconds. A high, prominent
 * peak means the two feeds carry the same programme offset by `lagSeconds` (CDN delay).
 */
export function correlateEnvelopes(a: Float64Array, b: Float64Array, maxLagSeconds = 30): CorrelationResult {
  const maxLag = Math.round(maxLagSeconds * ENVELOPE_RATE_HZ);
  const minOverlap = 15 * ENVELOPE_RATE_HZ;
  const scores: number[] = [];
  const byLag = new Map<number, number>();
  let best = { score: -1, lag: 0, overlap: 0 };
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sum = 0;
    let sa = 0;
    let sb = 0;
    let count = 0;
    for (let i = Math.max(0, -lag); i < a.length && i + lag < b.length; i++) {
      const x = a[i]!;
      const y = b[i + lag]!;
      sum += x * y;
      sa += x * x;
      sb += y * y;
      count++;
    }
    if (count < minOverlap) continue;
    const score = sa > 0 && sb > 0 ? sum / Math.sqrt(sa * sb) : 0;
    scores.push(score);
    byLag.set(lag, score);
    if (score > best.score) best = { score, lag, overlap: count };
  }
  if (scores.length === 0)
    return { score: 0, lagSeconds: 0, prominence: 0, uniqueness: 0, overlapSeconds: 0 };
  const exclusion = Math.round(0.5 * ENVELOPE_RATE_HZ);
  let second = 0;
  for (const [lag, sc] of byLag) if (Math.abs(lag - best.lag) > exclusion && sc > second) second = sc;
  const mean = scores.reduce((s, v) => s + v, 0) / scores.length;
  const sd = Math.sqrt(scores.reduce((s, v) => s + (v - mean) ** 2, 0) / scores.length) || 1e-9;
  return {
    score: Math.round(best.score * 1000) / 1000,
    lagSeconds: best.lag / ENVELOPE_RATE_HZ,
    prominence: Math.round(((best.score - mean) / sd) * 10) / 10,
    uniqueness: Math.round((Math.max(0, best.score) / Math.max(second, 0.05)) * 100) / 100,
    overlapSeconds: best.overlap / ENVELOPE_RATE_HZ,
  };
}

export const CORRELATION_THRESHOLD = 0.3;
/*
 * Thresholds calibrated on live radio on 31 Oct 2026: the same station over different encodes
 * and transports (MP3 vs AAC, direct vs HLS) scored 0.38–0.90 with prominence 5.3–24.7;
 * different stations scored 0.08–0.14 with prominence 3.6–4.8. Uniqueness is reported but not
 * required: repetitive dance music produces look-alike peaks one beat or bar away even for a
 * true match. A miss is only ever "inconclusive", so the gate errs on the strict side.
 */
export const PROMINENCE_THRESHOLD = 5;

export function correlationEvidence(
  r: CorrelationResult,
  againstLabel: string,
  now = new Date().toISOString(),
): IdentityEvidence {
  const supports = r.score >= CORRELATION_THRESHOLD && r.prominence >= PROMINENCE_THRESHOLD;
  return {
    kind: 'correlation',
    verdict: supports ? 'supports' : 'inconclusive',
    score: r.score,
    detail: supports
      ? `Audio matches ${againstLabel} (score ${r.score}, offset ${r.lagSeconds.toFixed(1)} s).`
      : `No reliable match with ${againstLabel} (score ${r.score}, prominence ${r.prominence}); this is inconclusive, not a mismatch.`,
    at: now,
  };
}

/** Decodes a bounded live sample of a source to 8 kHz mono PCM, in memory only. */
async function decodeSample(
  deps: ProbeDeps,
  url: string,
  seconds: number,
  signal: AbortSignal,
  owner: string,
): Promise<Int16Array> {
  const input = await openSourceInput(deps.client, url, {
    signal,
    icyMetadata: false,
    hlsLiveEdgeSegments: 1,
  });
  try {
    const { sample } = await collectSample(input, seconds * 1000, 4 * 1024 * 1024, signal);
    const res = await runWithInput(
      deps.registry,
      deps.ffmpegPath,
      [
        '-hide_banner',
        '-nostdin',
        '-v',
        'error',
        '-protocol_whitelist',
        'pipe',
        '-i',
        'pipe:0',
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        String(PCM_RATE),
        '-f',
        's16le',
        'pipe:1',
      ],
      sample,
      { owner, kind: 'identity-decode', timeoutMs: 20_000, maxStdout: seconds * 3 * PCM_RATE * 2, signal },
    );
    const buf = res.stdout;
    return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  } finally {
    input.close();
  }
}

/**
 * Samples two sources at the same time and correlates them (PRD §7.5). Bounded to
 * `seconds` of capture each (default 40 s, total budget ≤ 90 s). Nothing is persisted.
 */
export async function compareSources(
  deps: ProbeDeps,
  urlA: string,
  urlB: string,
  opts: { seconds?: number; signal?: AbortSignal; owner?: string } = {},
): Promise<CorrelationResult> {
  const seconds = opts.seconds ?? 40;
  const signal = linkedSignal(90_000, opts.signal);
  const owner = opts.owner ?? 'identity';
  const [a, b] = await Promise.all([
    decodeSample(deps, urlA, seconds, signal, owner),
    decodeSample(deps, urlB, seconds, signal, owner),
  ]);
  if (a.length < PCM_RATE * 5 || b.length < PCM_RATE * 5) {
    throw new RadioError('PROBE_FAILED', 'Not enough audio was captured to compare the two streams.');
  }
  // ±30 s covers CDN delays between direct streams and HLS started one segment from live.
  return correlateEnvelopes(onsetEnvelope(a), onsetEnvelope(b), 30);
}
