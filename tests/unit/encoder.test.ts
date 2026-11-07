import { describe, expect, it } from 'vitest';
import {
  BALANCED_CAP_KBPS,
  buildEncodeArgs,
  type EncoderInput,
  OPUS_ENCODER_MAX_KBPS,
  OPUS_MIN_KBPS,
  planEncoder,
  REENCODE_FLOOR_KBPS,
  REENCODE_FLOOR_MONO_KBPS,
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

describe('re-encode floor', () => {
  const plan = (kbps: number | null, o: Partial<EncoderInput> = {}) =>
    planEncoder({
      ...base,
      channelBitrateBps: null,
      sourceBitrate: kbps === null ? null : { kbps, evidence: 'measured' },
      ...o,
    });

  it('raises a low-rate stereo source to 128 kbps in maximum mode, whatever its codec', () => {
    expect(REENCODE_FLOOR_KBPS).toBe(128);
    for (const kbps of [24, 32, 48, 64, 96, 112, 127.4]) expect(plan(kbps).targetKbps).toBe(128);
  });

  it('raises a low-rate mono source to 96 kbps', () => {
    expect(REENCODE_FLOOR_MONO_KBPS).toBe(96);
    expect(plan(32, { sourceChannels: 1 }).targetKbps).toBe(96);
    expect(plan(64, { sourceChannels: 1 }).targetKbps).toBe(96);
    expect(plan(112, { sourceChannels: 1 }).targetKbps).toBe(112);
    // Channels unknown: treated as stereo, the safer side.
    expect(plan(64, { sourceChannels: null }).targetKbps).toBe(128);
  });

  it('leaves sources at or above the floor following their own rate', () => {
    expect(plan(128).targetKbps).toBe(128);
    expect(plan(128.1).targetKbps).toBe(129);
    expect(plan(192).targetKbps).toBe(192);
    expect(plan(320).targetKbps).toBe(320);
    expect(plan(128).notes.join(' ')).toContain("follows the source's 128 kbps");
  });

  it("never goes above the installation's limit to reach the floor", () => {
    const p = plan(48, { maxKbps: 96 });
    expect(p.targetKbps).toBe(96);
    expect(p.notes.join(' ')).toContain("this installation's limit; the usual minimum is 128 kbps");
    expect(plan(48, { maxKbps: 64, sourceChannels: 1 }).targetKbps).toBe(64);
  });

  it('applies to manual mode before a value is set, and nowhere else', () => {
    expect(plan(48, { qualityMode: 'manual', manualBitrateKbps: null }).targetKbps).toBe(128);
    expect(plan(48, { qualityMode: 'manual', manualBitrateKbps: 64 }).targetKbps).toBe(64);
    // Balanced is the explicit bandwidth saver: it never encodes above the source.
    expect(plan(48, { qualityMode: 'balanced' }).targetKbps).toBe(48);
    // Unknown bitrate: still the ceiling.
    expect(plan(null).targetKbps).toBe(510);
  });

  it('says why the target is above the source, without claiming added detail', () => {
    const notes = plan(48).notes.join(' ');
    expect(notes).toContain('The source is 48 kbps (measured); the encoder uses 128 kbps');
    expect(notes).toContain('keeps the stereo image and treble');
    expect(notes).toContain('adds no detail the source lacks');
    expect(notes).not.toMatch(/follows the source/);
    const mono = plan(48, { sourceChannels: 1 }).notes.join(' ');
    expect(mono).toContain('uses 96 kbps');
    expect(mono).not.toContain('stereo image');
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

  it('feeds libopus float samples whatever the source decodes to', () => {
    const args = buildEncodeArgs(planEncoder(base));
    // An output option: it must come after the input and before the encoder is chosen.
    expect(args[args.indexOf('-sample_fmt') + 1]).toBe('flt');
    expect(args.indexOf('-sample_fmt')).toBeGreaterThan(args.indexOf('-i'));
    expect(args.indexOf('-sample_fmt')).toBeLessThan(args.indexOf('-c:a'));
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
