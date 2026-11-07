import type { StationSource } from '../catalogue/types.ts';
import type { QualityMode } from '../config/env.ts';

/** libopus accepts up to 510 kbps for stereo. */
export const OPUS_ENCODER_MAX_KBPS = 510;
export const OPUS_MIN_KBPS = 32;
export const BALANCED_CAP_KBPS = 128;
/**
 * The least `maximum` sends for a stereo source. Re-encoding is a second lossy generation, and the
 * last encode's bitrate dominates what is heard. Below about 134 kbps libopus codes the bands above
 * a bitrate-dependent frequency as one shared signal with only each side's level (intensity stereo,
 * `intensity_thresholds` in celt/celt_encoder.c): above 3.2 kHz at 48 kbps, 5.6 kHz at 64, 12 kHz
 * at 96, and only the top band (15.6–20 kHz) at 128. A low-rate source still carries real stereo
 * well above those points, and HE-AAC's rebuilt treble and parametric stereo arrive as real audio
 * that Opus must code in full. 128 kbps is also where Opus alone is near-transparent for music.
 */
export const REENCODE_FLOOR_KBPS = 128;
/** The same for a mono source: there is no stereo image to keep, and VBR spends little on the side. */
export const REENCODE_FLOOR_MONO_KBPS = 96;
export const OUTPUT_SAMPLE_RATE = 48_000;
export const OUTPUT_CHANNELS = 2;
export const FRAME_MS = 20;

export interface EncoderInput {
  qualityMode: QualityMode;
  manualBitrateKbps: number | null;
  /** Installation ceiling (MAX_OPUS_BITRATE_KBPS, default 510). */
  maxKbps?: number;
  /** The source's own bitrate and where that figure comes from; null when unknown. */
  sourceBitrate?: SourceBitrate | null;
  /** The voice channel's configured bitrate in bits/s. Reported only; it is not used as a cap. */
  channelBitrateBps: number | null;
  sourceSampleRateHz: number | null;
  sourceChannels: number | null;
}

export interface SourceBitrate {
  kbps: number;
  evidence: 'codec metadata' | 'measured' | 'manifest' | 'advertised';
}

/**
 * The bitrate the encoder follows: the measured rate (the audio data the station really sends,
 * averaged over the probe sample), then the codec metadata, then the manifest or advertised one.
 * Codec metadata comes second because for AAC ffprobe estimates it and it can be well off in
 * either direction (176.4 or 113.7 kbps for streams that measure 128.1).
 */
export function sourceBitrate(s: StationSource): SourceBitrate | null {
  if (s.measuredBitrateKbps) return { kbps: s.measuredBitrateKbps, evidence: 'measured' };
  if (s.codecBitrateKbps) return { kbps: s.codecBitrateKbps, evidence: 'codec metadata' };
  if (s.advertisedBitrateKbps) {
    return {
      kbps: s.advertisedBitrateKbps,
      evidence: s.bitrateConfidence === 'manifest' ? 'manifest' : 'advertised',
    };
  }
  return null;
}

export interface EncoderPlan {
  codec: 'opus';
  targetKbps: number;
  /** The voice channel's own bitrate setting, for information. */
  channelBitrateKbps: number | null;
  qualityMode: QualityMode;
  sampleRateHz: number;
  channels: number;
  frameMs: number;
  application: 'audio';
  vbr: 'on';
  resampled: boolean;
  /** True when a mono source is duplicated to stereo framing (no detail is invented). */
  monoUpmixed: boolean;
  notes: string[];
}

/**
 * Chooses the Opus target (PRD §8.3). `maximum` follows the source's own bitrate, up to the
 * installation ceiling (libopus allows up to 510 kbps stereo): encoding a 128 kbps stream at
 * 510 kbps only costs bandwidth, since no target can restore what the source lacks. Below the
 * re-encode floor (128 kbps, 96 for mono) it uses the floor instead, so the second encode does
 * not throw away the stereo image and treble the source still has. When the source's bitrate is
 * unknown it uses the ceiling. `balanced` uses 128 kbps, or the source's rate when lower; `manual`
 * uses the admin's value exactly. A bot's stream is not limited by the voice channel's bitrate
 * setting, so that setting is reported only.
 */
export function planEncoder(i: EncoderInput): EncoderPlan {
  const channelBitrateKbps = i.channelBitrateBps ? Math.round(i.channelBitrateBps / 1000) : null;
  const ceiling = Math.min(
    Math.max(i.maxKbps ?? OPUS_ENCODER_MAX_KBPS, OPUS_MIN_KBPS),
    OPUS_ENCODER_MAX_KBPS,
  );
  let target: number;
  const notes: string[] = [];
  const source = i.sourceBitrate ?? null;
  const floor = i.sourceChannels === 1 ? REENCODE_FLOOR_MONO_KBPS : REENCODE_FLOOR_KBPS;
  // `maximum`, and `manual` before a value is set: the source's rate, raised to the floor.
  const followed = source === null ? ceiling : Math.min(ceiling, Math.max(source.kbps, floor));
  switch (i.qualityMode) {
    case 'balanced':
      target = Math.min(ceiling, BALANCED_CAP_KBPS, source?.kbps ?? BALANCED_CAP_KBPS);
      break;
    case 'manual':
      target = Math.min(ceiling, i.manualBitrateKbps ?? followed);
      break;
    default:
      target = followed;
  }
  // Rounded up, never down, so a fractional source rate (128.1) is never encoded below itself.
  target = Math.max(OPUS_MIN_KBPS, Math.ceil(target));
  if (i.qualityMode !== 'manual' || i.manualBitrateKbps === null) {
    if (source === null) {
      notes.push(`The source's bitrate is unknown, so the encoder uses ${target} kbps.`);
    } else if (target > Math.ceil(source.kbps)) {
      const limit = target < floor ? ` (this installation's limit; the usual minimum is ${floor} kbps)` : '';
      notes.push(
        `The source is ${source.kbps} kbps (${source.evidence}); the encoder uses ${target} kbps${limit}, the minimum for a re-encode, so Opus keeps the ${i.sourceChannels === 1 ? 'treble' : 'stereo image and treble'} the source has. This adds no detail the source lacks.`,
      );
    } else if (target === Math.max(OPUS_MIN_KBPS, Math.ceil(source.kbps))) {
      notes.push(`The encoder follows the source's ${source.kbps} kbps (${source.evidence}).`);
    } else if (target < source.kbps) {
      const why =
        i.qualityMode === 'balanced' && target === BALANCED_CAP_KBPS
          ? 'balanced quality uses'
          : "this installation's limit is";
      notes.push(`The source is ${source.kbps} kbps (${source.evidence}); ${why} ${target} kbps.`);
    }
  }
  if (channelBitrateKbps !== null && target > channelBitrateKbps) {
    notes.push(
      `Encoding above the voice channel's ${channelBitrateKbps} kbps setting; the channel setting does not cap a bot's stream.`,
    );
  }
  const resampled = i.sourceSampleRateHz !== null && i.sourceSampleRateHz !== OUTPUT_SAMPLE_RATE;
  if (resampled) {
    notes.push(
      `Source ${(i.sourceSampleRateHz! / 1000).toFixed(1)} kHz is resampled to 48 kHz as Discord requires.`,
    );
  }
  const monoUpmixed = i.sourceChannels === 1;
  if (monoUpmixed)
    notes.push('Source is mono; it is sent in stereo framing without inventing stereo detail.');
  notes.push('A higher Opus target cannot restore detail already lost in the source encoding.');
  return {
    codec: 'opus',
    targetKbps: target,
    channelBitrateKbps,
    qualityMode: i.qualityMode,
    sampleRateHz: OUTPUT_SAMPLE_RATE,
    channels: OUTPUT_CHANNELS,
    frameMs: FRAME_MS,
    application: 'audio',
    vbr: 'on',
    resampled,
    monoUpmixed,
    notes,
  };
}

/**
 * FFmpeg arguments for the single lossy encode: stdin (already-fetched, policy-checked
 * bytes) → decode → 48 kHz stereo → libopus (music mode, 20 ms) → Ogg Opus on stdout.
 * No loudness normalisation, EQ, compression or limiter. FFmpeg may only read the pipe.
 *
 * Latency: the Ogg muxer closes a page once it spans `-page_duration`, then holds it until the
 * next page closes (libavformat/oggenc.c, ogg_write_pages). With one 20 ms page per Opus packet,
 * each packet leaves after one more frame (20 ms) instead of 100–180 ms with 100 ms pages, and
 * `-flush_packets 1` writes it to the pipe at once. `+nobuffer` is deliberately not set: it only
 * discards the packets read while probing the input, which the live queue trims anyway, and for
 * HLS (MPEG-TS, probed up to `-analyzeduration`) it would throw away the queue's start cushion.
 */
export function buildEncodeArgs(plan: EncoderPlan): string[] {
  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-protocol_whitelist',
    'pipe',
    '-fflags',
    '+discardcorrupt',
    '-analyzeduration',
    '3000000',
    '-probesize',
    '1000000',
    '-i',
    'pipe:0',
    '-map',
    '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-ac',
    String(plan.channels),
    '-ar',
    String(plan.sampleRateHz),
    // libopus takes 16-bit or float input. FFmpeg picks float when the decoder outputs float (MP3,
    // AAC, Opus, Vorbis) but 16-bit for 16-bit FLAC or PCM, which it would then resample in integers
    // and round back without dither, clipping any overshoot. Float keeps every source on one path.
    '-sample_fmt',
    'flt',
    '-c:a',
    'libopus',
    '-b:a',
    `${plan.targetKbps}k`,
    '-vbr',
    plan.vbr,
    '-compression_level',
    '10',
    '-application',
    plan.application,
    '-frame_duration',
    String(plan.frameMs),
    '-f',
    'ogg',
    '-page_duration',
    '20000',
    '-flush_packets',
    '1',
    'pipe:1',
  ];
}
