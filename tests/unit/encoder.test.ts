import { describe, expect, it } from 'vitest';
import {
  BALANCED_CAP_KBPS,
  buildEncodeArgs,
  type EncoderInput,
  OPUS_ENCODER_MAX_KBPS,
  OPUS_MIN_KBPS,
  planEncoder,
} from '../../src/audio/encoder.ts';

const base: EncoderInput = {
  qualityMode: 'maximum',
  manualBitrateKbps: null,
  channelBitrateBps: 96_000,
  sourceSampleRateHz: 44_100,
  sourceChannels: 2,
};
const target = (o: Partial<EncoderInput>) => planEncoder({ ...base, ...o }).targetKbps;

describe('Opus target selection (§8.3)', () => {
  it('defaults to the libopus stereo maximum of 510 kbps', () => {
    expect(OPUS_ENCODER_MAX_KBPS).toBe(510);
    expect(target({})).toBe(510);
  });

  it('clamps the installation ceiling to the Opus range', () => {
    expect(target({ maxKbps: 1000 })).toBe(OPUS_ENCODER_MAX_KBPS);
    expect(target({ maxKbps: 8 })).toBe(OPUS_MIN_KBPS);
  });

  it('balanced mode uses 128 kbps, or a lower installation ceiling', () => {
    expect(target({ qualityMode: 'balanced' })).toBe(BALANCED_CAP_KBPS);
    expect(target({ qualityMode: 'balanced', maxKbps: 96 })).toBe(96);
  });

  it('manual mode uses the admin value within [32, ceiling] and falls back to the ceiling', () => {
    expect(target({ qualityMode: 'manual', manualBitrateKbps: 192 })).toBe(192);
    expect(target({ qualityMode: 'manual', manualBitrateKbps: 8 })).toBe(OPUS_MIN_KBPS);
    expect(target({ qualityMode: 'manual', manualBitrateKbps: null })).toBe(510);
    expect(target({ qualityMode: 'manual', manualBitrateKbps: null, maxKbps: 256 })).toBe(256);
    expect(target({ qualityMode: 'manual', manualBitrateKbps: 191.6 })).toBe(192);
  });

  it('never uses the voice channel bitrate as a cap, in any mode', () => {
    for (const channelBitrateBps of [8_000, 64_000, 96_000, 384_000]) {
      expect(target({ channelBitrateBps })).toBe(510);
      expect(target({ channelBitrateBps, qualityMode: 'manual', manualBitrateKbps: 320 })).toBe(320);
    }
  });
});

describe('encoder plan reporting', () => {
  it('reports the channel setting in kbps and explains when the target exceeds it', () => {
    const p = planEncoder({ ...base, channelBitrateBps: 64_400 });
    expect(p.channelBitrateKbps).toBe(64);
    expect(p.notes.some((n) => n.includes('64 kbps setting'))).toBe(true);
  });

  it('adds no "above the channel" note when the target fits the channel setting', () => {
    const p = planEncoder({ ...base, qualityMode: 'balanced', channelBitrateBps: 384_000 });
    expect(p.notes.join(' ')).not.toMatch(/Encoding above/);
    expect(planEncoder({ ...base, channelBitrateBps: null }).channelBitrateKbps).toBeNull();
  });

  it('only claims resampling when the source rate is known and not 48 kHz', () => {
    expect(planEncoder({ ...base, sourceSampleRateHz: 22_050 }).notes.join(' ')).toMatch(/22\.1 kHz/);
    expect(planEncoder({ ...base, sourceSampleRateHz: null }).resampled).toBe(false);
    expect(planEncoder({ ...base, sourceSampleRateHz: 48_000 }).resampled).toBe(false);
    expect(planEncoder({ ...base, sourceChannels: null }).monoUpmixed).toBe(false);
  });

  it('always outputs 48 kHz stereo Opus in 20 ms music-mode VBR frames', () => {
    for (const qualityMode of ['maximum', 'balanced', 'manual'] as const) {
      const p = planEncoder({ ...base, qualityMode, sourceSampleRateHz: 22_050, sourceChannels: 1 });
      expect(p).toMatchObject({
        codec: 'opus',
        qualityMode,
        sampleRateHz: 48_000,
        channels: 2,
        frameMs: 20,
        application: 'audio',
        vbr: 'on',
      });
      expect(p.notes.at(-1)).toMatch(/cannot restore detail/);
    }
  });

  it('passes the planned target to libopus', () => {
    const args = buildEncodeArgs(planEncoder({ ...base, qualityMode: 'manual', manualBitrateKbps: 256 }));
    expect(args[args.indexOf('-b:a') + 1]).toBe('256k');
    expect(args[args.indexOf('-vbr') + 1]).toBe('on');
    expect(args.at(-1)).toBe('pipe:1');
  });

  it('writes one Ogg page per 20 ms Opus packet and flushes it at once', () => {
    const plan = planEncoder(base);
    const args = buildEncodeArgs(plan);
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    // A page that spans one frame leaves the muxer one frame later: no 100–200 ms page hold.
    expect(Number(value('-page_duration'))).toBe(plan.frameMs * 1000);
    expect(value('-frame_duration')).toBe(String(plan.frameMs));
    expect(value('-flush_packets')).toBe('1');
    // Packets read while probing are kept for the encoder (the live queue trims the start itself).
    expect(value('-fflags')).toBe('+discardcorrupt');
    expect(value('-analyzeduration')).toBe('3000000');
    expect(value('-probesize')).toBe('1000000');
  });
});
