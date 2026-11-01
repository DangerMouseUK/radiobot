import { type ProcessRegistry, runWithInput } from '../audio/ffmpeg.ts';
import type { BitrateEvidence, Transport } from '../catalogue/types.ts';
import { linkedSignal } from '../shared/async.ts';
import { errorCode, RadioError, type ReasonCode } from '../shared/errors.ts';
import { redactText } from '../shared/redact.ts';
import { type InputInfo, openSourceInput, type SourceInput } from './input.ts';
import type { SafeHttpClient } from './safe-fetch.ts';

export const PROBE_VERSION = 1;

export interface ProbeBudget {
  /** Total wall-clock limit for the basic probe (PRD §7.3: 10–15 s). */
  totalMs: number;
  /** How long to collect stream bytes for analysis. */
  sampleMs: number;
  /** Hard cap on in-memory sample size. */
  maxSampleBytes: number;
}

export const DEFAULT_PROBE_BUDGET: ProbeBudget = {
  totalMs: 15_000,
  sampleMs: 7_000,
  maxSampleBytes: 2 * 1024 * 1024,
};

export interface ProbeOutcome {
  success: boolean;
  failureCode: ReasonCode | null;
  failureDetail: string | null;
  startedAt: string;
  durationMs: number;
  startupMs: number | null;
  transport: Transport;
  effectiveHost: string | null;
  container: string | null;
  codec: string | null;
  profile: string | null;
  sampleRateHz: number | null;
  channels: number | null;
  channelLayout: string | null;
  advertisedBitrateKbps: number | null;
  codecBitrateKbps: number | null;
  measuredBitrateKbps: number | null;
  /** Network throughput while sampling; inflated by connect bursts, informational only. */
  networkKbps: number | null;
  bitrateEvidence: BitrateEvidence;
  sampleSeconds: number | null;
  decodedSeconds: number | null;
  decodeErrors: number;
  icyName: string | null;
  icyTitle: string | null;
  headersSummary: Record<string, string>;
  manifestSummary: Record<string, unknown>;
}

interface FfprobeJson {
  streams?: Array<{
    codec_name?: string;
    codec_type?: string;
    profile?: string;
    sample_rate?: string;
    channels?: number;
    channel_layout?: string;
    bit_rate?: string;
  }>;
  format?: { format_name?: string; bit_rate?: string };
  packets?: Array<{ size?: string; duration_time?: string; pts_time?: string }>;
}

export interface ParsedProbe {
  container: string | null;
  codec: string | null;
  profile: string | null;
  sampleRateHz: number | null;
  channels: number | null;
  channelLayout: string | null;
  codecBitrateKbps: number | null;
  measuredBitrateKbps: number | null;
  sampleSeconds: number | null;
}

const toNum = (v: string | number | undefined): number | null => {
  if (v === undefined || v === 'N/A') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Interprets ffprobe JSON. Measured bitrate = payload bits / audio duration (not network timing). */
export function parseFfprobeOutput(json: FfprobeJson): ParsedProbe {
  const audio = json.streams?.find((s) => s.codec_type === 'audio') ?? null;
  const packets = json.packets ?? [];
  let bytes = 0;
  let seconds = 0;
  for (const p of packets) {
    const size = toNum(p.size);
    const dur = toNum(p.duration_time);
    if (size !== null && dur !== null && dur > 0) {
      bytes += size;
      seconds += dur;
    }
  }
  const measured = seconds >= 3 ? Math.round((bytes * 8) / seconds / 100) / 10 : null;
  const streamBr = toNum(audio?.bit_rate);
  const formatBr = toNum(json.format?.bit_rate);
  const codecBr = streamBr ?? formatBr;
  let profile = audio?.profile ?? null;
  if (profile && /^(unknown|-?\d+)$/i.test(profile)) profile = null;
  return {
    container: json.format?.format_name ?? null,
    codec: audio?.codec_name ?? null,
    profile,
    sampleRateHz: toNum(audio?.sample_rate),
    channels: audio?.channels ?? null,
    channelLayout: audio?.channel_layout ?? null,
    codecBitrateKbps: codecBr !== null ? Math.round(codecBr / 100) / 10 : null,
    measuredBitrateKbps: measured,
    sampleSeconds: seconds > 0 ? Math.round(seconds * 10) / 10 : null,
  };
}

/** Normalises codec naming for display/ranking (e.g. aac + "HE-AAC" profile). */
export function codecLabel(codec: string | null, profile: string | null): string {
  if (!codec) return 'unknown';
  const c = codec.toLowerCase();
  if (c === 'aac') {
    if (profile && /he-?aacv2/i.test(profile)) return 'HE-AACv2';
    if (profile && /he-?aac/i.test(profile)) return 'HE-AAC';
    if (profile && /lc/i.test(profile)) return 'AAC-LC';
    return 'AAC';
  }
  if (c === 'mp3' || c === 'mp3float') return 'MP3';
  if (c === 'opus') return 'Opus';
  if (c === 'vorbis') return 'Vorbis';
  if (c === 'flac') return 'FLAC';
  return codec.toUpperCase();
}

/**
 * Collects up to `ms` / `maxBytes` of stream data into memory. The buffer is discarded after analysis.
 * With `requireLive`, a stream that ends before the window is over fails with STREAM_EOF: a live
 * station never ends, so a short finite body is a recording or an "offline" message.
 */
export function collectSample(
  input: SourceInput,
  ms: number,
  maxBytes: number,
  signal: AbortSignal,
  opts: { requireLive?: boolean } = {},
): Promise<{ sample: Buffer; firstByteMs: number | null; networkKbps: number | null }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const started = Date.now();
    let firstAt: number | null = null;
    let done = false;
    const finish = (err?: unknown, fatal = false) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      input.stream.off('data', onData);
      input.stream.pause();
      if (err && (size === 0 || fatal)) {
        reject(err);
        return;
      }
      const elapsed = firstAt ? (Date.now() - firstAt) / 1000 : 0;
      resolve({
        sample: Buffer.concat(chunks),
        firstByteMs: firstAt ? firstAt - started : null,
        networkKbps: elapsed > 1 ? Math.round((size * 8) / elapsed / 1000) : null,
      });
    };
    const onData = (chunk: Buffer) => {
      firstAt ??= Date.now();
      const room = maxBytes - size;
      chunks.push(room < chunk.length ? chunk.subarray(0, room) : chunk);
      size += Math.min(room, chunk.length);
      if (size >= maxBytes) finish();
    };
    const onAbort = () =>
      finish(new RadioError('PROBE_TIMEOUT', 'The stream did not deliver audio in time.'));
    const timer = setTimeout(() => finish(), ms);
    signal.addEventListener('abort', onAbort, { once: true });
    input.stream.on('data', onData);
    input.stream.once('end', () =>
      finish(
        new RadioError(
          'STREAM_EOF',
          size === 0
            ? 'The stream ended immediately.'
            : 'The stream ended after a few seconds, so it is not a continuous live stream.',
        ),
        opts.requireLive,
      ),
    );
    input.stream.once('error', (e) => finish(e));
  });
}

export interface ProbeDeps {
  client: SafeHttpClient;
  registry: ProcessRegistry;
  ffmpegPath: string;
  ffprobePath: string;
}

function emptyOutcome(startedAt: number): ProbeOutcome {
  return {
    success: false,
    failureCode: null,
    failureDetail: null,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: 0,
    startupMs: null,
    transport: 'unknown',
    effectiveHost: null,
    container: null,
    codec: null,
    profile: null,
    sampleRateHz: null,
    channels: null,
    channelLayout: null,
    advertisedBitrateKbps: null,
    codecBitrateKbps: null,
    measuredBitrateKbps: null,
    networkKbps: null,
    bitrateEvidence: 'unknown',
    sampleSeconds: null,
    decodedSeconds: null,
    decodeErrors: 0,
    icyName: null,
    icyTitle: null,
    headersSummary: {},
    manifestSummary: {},
  };
}

function manifestSummary(info: InputInfo): Record<string, unknown> {
  if (!info.hls) return {};
  return {
    playlistHost: info.hls.playlistHost,
    chosen: info.hls.chosen,
    alternatives: info.hls.alternatives.slice(0, 10),
    targetDuration: info.hls.targetDuration,
  };
}

/**
 * Bounded technical probe of one source (PRD FR-004, §7.3 steps 1–7): opens it through the
 * safe client, samples a few seconds into memory, runs ffprobe (format/codec/packets) and a
 * decode check over the sample, then discards the sample.
 */
export async function probeSource(
  deps: ProbeDeps,
  url: string,
  budget: ProbeBudget = DEFAULT_PROBE_BUDGET,
  outerSignal?: AbortSignal,
  owner = 'probe',
): Promise<ProbeOutcome> {
  const started = Date.now();
  const out = emptyOutcome(started);
  const signal = linkedSignal(budget.totalMs, outerSignal);
  let input: SourceInput | null = null;
  try {
    input = await openSourceInput(deps.client, url, {
      signal,
      headersTimeoutMs: Math.min(10_000, budget.totalMs),
    });
    input.on('metadata', (m) => {
      if (m) out.icyTitle = m.title;
    });
    out.transport = input.info.transport;
    out.effectiveHost = input.info.finalHost;
    out.headersSummary = input.info.headersSummary;
    out.manifestSummary = manifestSummary(input.info);
    out.advertisedBitrateKbps = input.info.advertisedBitrateKbps;
    out.icyName = input.info.icyName;

    const { sample, firstByteMs, networkKbps } = await collectSample(
      input,
      budget.sampleMs,
      budget.maxSampleBytes,
      signal,
      { requireLive: input.info.transport === 'http-continuous' },
    );
    out.startupMs = firstByteMs;
    out.networkKbps = networkKbps;
    input.close();
    if (sample.length < 2048) throw new RadioError('NO_AUDIO_STREAM', 'The stream delivered almost no data.');

    const remaining = () => Math.max(2000, budget.totalMs - (Date.now() - started));
    const [probeRes, decodeRes] = await Promise.all([
      runWithInput(
        deps.registry,
        deps.ffprobePath,
        [
          '-v',
          'error',
          '-protocol_whitelist',
          'pipe',
          '-select_streams',
          'a:0',
          '-show_entries',
          'stream=codec_name,codec_type,profile,sample_rate,channels,channel_layout,bit_rate:format=format_name,bit_rate:packet=size,duration_time',
          '-of',
          'json',
          '-i',
          'pipe:0',
        ],
        sample,
        { owner, kind: 'ffprobe', timeoutMs: remaining(), maxStdout: 8 * 1024 * 1024, signal: outerSignal },
      ),
      runWithInput(
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
          '-f',
          'null',
          '-progress',
          'pipe:1',
          '-nostats',
          '-',
        ],
        sample,
        { owner, kind: 'decode-check', timeoutMs: remaining(), maxStdout: 1024 * 1024, signal: outerSignal },
      ),
    ]);

    let json: FfprobeJson;
    try {
      json = JSON.parse(probeRes.stdout.toString('utf8')) as FfprobeJson;
    } catch {
      throw new RadioError(
        'PROBE_FAILED',
        `ffprobe could not analyse the stream. ${probeRes.stderr.slice(0, 200)}`,
      );
    }
    const parsed = parseFfprobeOutput(json);
    if (!parsed.codec) throw new RadioError('NO_AUDIO_STREAM', 'No audio stream was found in the source.');
    Object.assign(out, parsed);
    if (input.info.hls?.container && !out.container?.includes('mp4'))
      out.container = input.info.hls.container;

    const progress = decodeRes.stdout.toString('utf8');
    const times = [...progress.matchAll(/out_time_us=(\d+)/g)].map((m) => Number(m[1]));
    out.decodedSeconds = times.length > 0 ? Math.round(Math.max(...times) / 100_000) / 10 : null;
    out.decodeErrors = decodeRes.stderr.split(/\r?\n/).filter((l) => /error|invalid|corrupt/i.test(l)).length;
    if (!out.decodedSeconds || out.decodedSeconds < 0.5) {
      throw new RadioError('DECODE_FAILED', 'The audio could not be decoded.');
    }
    out.bitrateEvidence =
      out.measuredBitrateKbps !== null
        ? 'measured'
        : out.codecBitrateKbps !== null
          ? 'codec-metadata'
          : out.transport === 'hls' && out.advertisedBitrateKbps !== null
            ? 'manifest'
            : out.advertisedBitrateKbps !== null
              ? 'advertised'
              : 'unknown';
    out.success = true;
  } catch (err) {
    out.success = false;
    // Only the caller can cancel a probe; any other abort is the probe's own time budget running out.
    out.failureCode = outerSignal?.aborted ? 'CANCELLED' : signal.aborted ? 'PROBE_TIMEOUT' : errorCode(err);
    out.failureDetail = redactText(
      err instanceof RadioError ? err.userMessage : String((err as Error)?.message ?? err),
    ).slice(0, 500);
  } finally {
    input?.close();
    out.durationMs = Date.now() - started;
  }
  return out;
}
