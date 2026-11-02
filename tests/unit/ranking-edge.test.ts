import { describe, expect, it } from 'vitest';
import type { StationSource } from '../../src/catalogue/types.ts';
import { compareFidelity, compareSources, selectSource, transportTier } from '../../src/streams/ranking.ts';
import { makeSource } from '../helpers.ts';

const now = Date.now();
const STATION = 'mypack:my-station';
const src = (o: Partial<StationSource>) => makeSource({ stationId: STATION, ...o });
const pref = (mode: 'pin' | 'prefer', sourceId: string) => ({
  guildId: '123456789012345678',
  stationId: STATION,
  mode,
  sourceId,
  updatedAt: '',
});

describe('fidelity evidence, both directions', () => {
  it('prefers stereo whichever side it is on', () => {
    const mono = src({ id: 'mono', channels: 1 });
    const stereo = src({ id: 'stereo', channels: 2 });
    expect(compareFidelity(mono, stereo)).toEqual({ relation: 'b', reason: 'stereo vs mono' });
    expect(compareFidelity(stereo, mono)).toEqual({ relation: 'a', reason: 'stereo vs mono' });
    // 2 vs 6 channels is not a stereo-vs-mono difference: falls through to bitrate.
    expect(compareFidelity(src({ channels: 6 }), src({ channels: 2 })).relation).toBe('equal');
  });

  it('accepts a clear audio-bandwidth difference whichever side it is on', () => {
    const wide = src({ id: 'wide', sampleRateHz: 48_000 });
    const narrow = src({ id: 'narrow', sampleRateHz: 24_000 });
    expect(compareFidelity(wide, narrow)).toEqual({
      relation: 'a',
      reason: '48 kHz vs 24 kHz audio bandwidth',
    });
    expect(compareFidelity(narrow, wide).relation).toBe('b');
    // 32 kHz vs 44.1 kHz is not a clear enough difference on its own.
    expect(compareFidelity(src({ sampleRateHz: 32_000 }), src({ sampleRateHz: 44_100 })).relation).toBe(
      'equal',
    );
  });

  it('is inconclusive when a codec or the bitrates are unknown', () => {
    expect(compareFidelity(src({ codec: null }), src({})).reason).toBe('codec unknown');
    expect(compareFidelity(src({}), src({ codec: null })).relation).toBe('inconclusive');
    const unmeasured = src({
      measuredBitrateKbps: null,
      codecBitrateKbps: null,
      advertisedBitrateKbps: null,
    });
    expect(compareFidelity(unmeasured, src({}))).toEqual({
      relation: 'inconclusive',
      reason: 'bitrate not measured',
    });
  });

  it('ranks a measurably higher bitrate of the same codec on the other side as b', () => {
    const lo = src({ id: 'lo', measuredBitrateKbps: 128 });
    const hi = src({ id: 'hi', measuredBitrateKbps: 320 });
    expect(compareFidelity(lo, hi)).toEqual({ relation: 'b', reason: '320 vs 128 kbps MP3' });
    // Codec metadata counts as strong evidence too.
    const meta = src({ id: 'meta', measuredBitrateKbps: null, codecBitrateKbps: 320 });
    expect(compareFidelity(meta, lo).relation).toBe('a');
  });
});

describe('source ordering', () => {
  it('puts unknown delivery between direct streams and HLS', () => {
    expect(transportTier({ transport: 'http-continuous' })).toBe(0);
    expect(transportTier({ transport: 'unknown' })).toBe(1);
    expect(transportTier({ transport: 'hls' })).toBe(2);
    expect(transportTier({ transport: 'something-else' as StationSource['transport'] })).toBe(1);
  });

  it('breaks ties by fidelity, health, start-up time, priority and then ID', () => {
    const base = { measuredBitrateKbps: 128 };
    expect(compareSources(src({ id: 'a', channels: 1 }), src({ id: 'b', channels: 2 }))).toBe(1);
    expect(compareSources(src({ id: 'a', channels: 2 }), src({ id: 'b', channels: 1 }))).toBe(-1);
    expect(
      compareSources(src({ id: 'a', ...base, startupMs: 4_000 }), src({ id: 'b', ...base, startupMs: 500 })),
    ).toBe(3_500);
    // Within 1.5 s the start-up time doesn't count.
    expect(
      compareSources(
        src({ id: 'a', startupMs: 1_000, priority: 1 }),
        src({ id: 'b', startupMs: 2_000, priority: 2 }),
      ),
    ).toBe(-1);
    expect(
      compareSources(src({ id: 'a', startupMs: null }), src({ id: 'b', startupMs: 9_000 })),
    ).toBeLessThan(0);
    expect(compareSources(src({ id: 'b' }), src({ id: 'a' }))).toBeGreaterThan(0);
  });
});

describe('selection explanations', () => {
  it('reports a verified higher-quality choice', () => {
    const r = selectSource(
      [src({ id: 'lo', measuredBitrateKbps: 128 }), src({ id: 'hi', measuredBitrateKbps: 320 })],
      null,
      { now },
    );
    expect(r.selected?.id).toBe('hi');
    expect(r.conclusion).toBe('higher-quality-verified');
    expect(r.explanation[0]).toBe('Selected direct MP3 ≈320 kbps: 320 vs 128 kbps MP3.');
    expect(r.explanation.at(-1)).toBe('Fallback: direct MP3 ≈128 kbps.');
  });

  it('says when an admin’s choice outranks a better source', () => {
    const lo = src({ id: 'lo', measuredBitrateKbps: 128 });
    const hi = src({ id: 'hi', measuredBitrateKbps: 320 });
    const r = selectSource([lo, hi], pref('prefer', 'lo'), { now });
    expect(r.selected?.id).toBe('lo');
    expect(r.degraded).toBe(false);
    expect(r.conclusion).toBe('higher-quality-source-ranked-lower');
    expect(r.explanation[0]).toBe('Using the preferred source an admin chose.');
    expect(r.explanation.join(' ')).toMatch(/measures higher \(320 vs 128 kbps MP3\) but an admin chose/);
  });

  it('ignores the source ID of an automatic preference', () => {
    const lo = src({ id: 'lo', measuredBitrateKbps: 128 });
    const hi = src({ id: 'hi', measuredBitrateKbps: 320 });
    const r = selectSource([lo, hi], { ...pref('pin', 'lo'), mode: 'auto' as const }, { now });
    expect(r.mode).toBe('auto');
    expect(r.selected?.id).toBe('hi');
    expect(r.conclusion).toBe('higher-quality-verified');
  });

  it('falls back silently when a preferred source is gone, and degrades a pin to a removed source', () => {
    const a = src({ id: 'a' });
    const b = src({ id: 'b', priority: 20 });
    const preferred = selectSource([a, b], pref('prefer', 'gone'), { now });
    expect(preferred.degraded).toBe(false);
    expect(preferred.explanation[0]).toBe(
      'Preferred source is unavailable, so the bot chose one automatically.',
    );
    const pinned = selectSource([a, b], pref('pin', 'gone'), { now });
    expect(pinned.degraded).toBe(true);
    expect(pinned.explanation[0]).toBe(
      'Degraded: the pinned source can’t be used (source removed), so a fallback is playing.',
    );
  });

  it('explains an admin-pinned HLS source when a direct stream is usable', () => {
    const direct = src({ id: 'direct' });
    const hls = src({ id: 'hls', transport: 'hls', priority: 20 });
    const r = selectSource([direct, hls], pref('pin', 'hls'), { now });
    expect(r.selected?.id).toBe('hls');
    expect(r.explanation[0]).toBe('Using the pinned source an admin chose.');
    expect(r.explanation).toContain(
      'An admin chose this HLS source; a usable direct stream would normally come first.',
    );
  });

  it('describes sources of unknown delivery and unknown bitrate', () => {
    const r = selectSource(
      [
        src({
          id: 'only',
          transport: 'unknown',
          measuredBitrateKbps: null,
          codecBitrateKbps: null,
          advertisedBitrateKbps: null,
        }),
      ],
      null,
      { now },
    );
    expect(r.conclusion).toBe('single-source');
    expect(r.explanation).toEqual(['Only one usable source: unknown-delivery MP3.']);
    expect(r.fallback).toBeNull();
  });
});
