import { describe, expect, it } from 'vitest';
import {
  CONCLUSION_TEXT,
  checkEligibility,
  compareFidelity,
  selectSource,
} from '../../src/streams/ranking.ts';
import { makeSource } from '../helpers.ts';

const now = Date.now();

describe('eligibility gate (correctness before bitrate)', () => {
  it('requires verified identity, a successful probe and no cooldown', () => {
    expect(checkEligibility(makeSource(), now).eligible).toBe(true);
    expect(checkEligibility(makeSource({ identityStatus: 'unverified' }), now).eligible).toBe(false);
    expect(checkEligibility(makeSource({ identityStatus: 'mismatch' }), now).reasons.join()).toMatch(
      /plays a different station/,
    );
    expect(
      checkEligibility(makeSource({ lastProbeAt: null, verificationState: 'discovered' }), now).eligible,
    ).toBe(false);
    expect(checkEligibility(makeSource({ verificationState: 'offline' }), now).eligible).toBe(false);
    expect(checkEligibility(makeSource({ enabled: false }), now).eligible).toBe(false);
    expect(checkEligibility(makeSource({ rightsStatus: 'blocked' }), now).eligible).toBe(false);
    expect(
      checkEligibility(
        makeSource({ cooldownUntil: new Date(now + 60_000).toISOString(), verificationState: 'cooldown' }),
        now,
      ).eligible,
    ).toBe(false);
    expect(
      checkEligibility(
        makeSource({ cooldownUntil: new Date(now - 60_000).toISOString(), verificationState: 'cooldown' }),
        now,
      ).eligible,
    ).toBe(true);
  });
});

describe('fidelity comparison', () => {
  it('never ranks across codecs by bitrate alone', () => {
    const aac = makeSource({ id: 'aac', codec: 'aac', profile: 'LC', measuredBitrateKbps: 128 });
    const mp3 = makeSource({ id: 'mp3', codec: 'mp3', measuredBitrateKbps: 320 });
    expect(compareFidelity(mp3, aac).relation).toBe('inconclusive');
  });

  it('treats near-equal same-codec bitrates as equal', () => {
    expect(
      compareFidelity(makeSource({ measuredBitrateKbps: 128 }), makeSource({ measuredBitrateKbps: 131 }))
        .relation,
    ).toBe('equal');
  });

  it('prefers a measurably higher same-codec bitrate, but not an advertised-only one', () => {
    const hi = makeSource({ id: 'hi', measuredBitrateKbps: 256 });
    const lo = makeSource({ id: 'lo', measuredBitrateKbps: 128 });
    expect(compareFidelity(hi, lo).relation).toBe('a');
    const adv = makeSource({
      id: 'adv',
      measuredBitrateKbps: null,
      codecBitrateKbps: null,
      advertisedBitrateKbps: 256,
    });
    expect(compareFidelity(adv, lo).relation).toBe('inconclusive');
  });

  it('accepts stereo-vs-mono and audio bandwidth as evidence', () => {
    expect(compareFidelity(makeSource({ channels: 2 }), makeSource({ channels: 1 })).relation).toBe('a');
    expect(
      compareFidelity(makeSource({ sampleRateHz: 22_050 }), makeSource({ sampleRateHz: 44_100 })).relation,
    ).toBe('b');
  });
});

describe('selection', () => {
  it('prefers direct over HLS when audio is equivalent and explains why (FR-006 example)', () => {
    const direct = makeSource({
      id: 'aac-direct',
      codec: 'aac',
      profile: 'LC',
      transport: 'http-continuous',
      priority: 30,
    });
    const hls = makeSource({ id: 'aac-hls', codec: 'aac', profile: 'LC', transport: 'hls', priority: 10 });
    const r = selectSource([hls, direct], null, { now });
    expect(r.selected?.id).toBe('aac-direct');
    expect(r.fallback?.id).toBe('aac-hls');
    expect(r.conclusion).toBe('no-higher-quality-source-verified');
    expect(r.explanation.join(' ')).toMatch(/direct feed selected for simpler live delivery/);
    expect(r.explanation.join(' ')).toMatch(/No independently verified higher-quality source found/);
  });

  it('never prioritises an unverified "256" source over a verified 128 kbps source (FR-006 acceptance)', () => {
    const verified = makeSource({ id: 'v128', measuredBitrateKbps: 128 });
    const hd = makeSource({
      id: 'hd256',
      measuredBitrateKbps: 256,
      identityStatus: 'unverified',
      verificationState: 'unverified',
    });
    const r = selectSource([hd, verified], null, { now });
    expect(r.selected?.id).toBe('v128');
    expect(r.fallback).toBeNull();
  });

  it('labels MP3-vs-AAC at similar bitrates as not conclusively determined', () => {
    const r = selectSource(
      [makeSource({ id: 'mp3' }), makeSource({ id: 'aac', codec: 'aac', profile: 'LC', priority: 20 })],
      null,
      { now },
    );
    expect(r.conclusion).toBe('not-conclusively-determined');
  });

  it('honours a pin and warns (degraded) when the pinned source is unavailable', () => {
    const a = makeSource({ id: 'a' });
    const b = makeSource({ id: 'b', priority: 20 });
    const pin = {
      guildId: 'g',
      stationId: 'fg:fg-dj-radio',
      mode: 'pin' as const,
      sourceId: 'b',
      updatedAt: '',
    };
    expect(selectSource([a, b], pin, { now }).selected?.id).toBe('b');
    const r = selectSource([a, { ...b, verificationState: 'offline' as const }], pin, { now });
    expect(r.selected?.id).toBe('a');
    expect(r.degraded).toBe(true);
    expect(r.explanation[0]).toMatch(/Degraded: the pinned source can’t be used/);
  });

  it('excludes sources that failed during this session', () => {
    const r = selectSource([makeSource({ id: 'a' }), makeSource({ id: 'b', priority: 20 })], null, {
      now,
      exclude: new Set(['a']),
    });
    expect(r.selected?.id).toBe('b');
  });

  it('reports no eligible source honestly', () => {
    const r = selectSource([makeSource({ identityStatus: 'unverified' })], null, { now });
    expect(r.selected).toBeNull();
    expect(r.conclusion).toBe('no-eligible-source');
  });

  it('prefers healthier sources when fidelity is equal', () => {
    const r = selectSource(
      [
        makeSource({ id: 'sick', healthScore: 10, priority: 1 }),
        makeSource({ id: 'well', healthScore: 90, priority: 99 }),
      ],
      null,
      { now },
    );
    expect(r.selected?.id).toBe('well');
  });

  it('keeps HLS as a last resort even when it measures a higher bitrate', () => {
    const direct = makeSource({
      id: 'direct-aac',
      codec: 'aac',
      profile: 'LC',
      measuredBitrateKbps: 96,
      priority: 50,
    });
    const hls = makeSource({
      id: 'hls-aac',
      codec: 'aac',
      profile: 'LC',
      transport: 'hls',
      measuredBitrateKbps: 256,
      healthScore: 100,
      priority: 1,
    });
    const r = selectSource([hls, direct], null, { now });
    expect(r.selected?.id).toBe('direct-aac');
    expect(r.fallback?.id).toBe('hls-aac');
    expect(r.explanation.join(' ')).toMatch(/last-resort fallback/);
  });

  it('says when a measurably better source loses on transport tier, not that it is inconclusive', () => {
    const direct = makeSource({
      id: 'direct-aac',
      codec: 'aac',
      profile: 'LC',
      measuredBitrateKbps: 96,
      codecBitrateKbps: null,
    });
    const hls = makeSource({
      id: 'hls-aac',
      codec: 'aac',
      profile: 'LC',
      transport: 'hls',
      measuredBitrateKbps: 256,
    });
    const r = selectSource([hls, direct], null, { now });
    expect(r.selected?.id).toBe('direct-aac');
    expect(r.conclusion).toBe('higher-quality-source-ranked-lower');
    expect(CONCLUSION_TEXT[r.conclusion]).not.toMatch(/different codecs/);
    expect(r.explanation.join(' ')).toMatch(/measures higher \(256 vs 96 kbps AAC-LC\) but direct streams/);
  });

  it('uses HLS only when no direct stream is eligible, and says so', () => {
    const r = selectSource(
      [
        makeSource({ id: 'direct', verificationState: 'offline' }),
        makeSource({ id: 'hls', transport: 'hls' }),
      ],
      null,
      { now },
    );
    expect(r.selected?.id).toBe('hls');
    expect(r.explanation.join(' ')).toMatch(/Only HLS is available/);
  });
});

describe('selection order', () => {
  it('picks the same source whatever order the database returns them in', () => {
    // A beats B on fidelity, B beats C on health, C beats A on priority: a preference cycle.
    const a = makeSource({
      id: 'a',
      measuredBitrateKbps: 320,
      codecBitrateKbps: 320,
      healthScore: 50,
      priority: 5,
    });
    const b = makeSource({ id: 'b', healthScore: 90, priority: 5 });
    const c = makeSource({
      id: 'c',
      codec: 'aac',
      codecHint: 'aac',
      profile: 'LC',
      healthScore: 60,
      priority: 1,
    });
    const orders = [
      [a, b, c],
      [a, c, b],
      [b, a, c],
      [b, c, a],
      [c, a, b],
      [c, b, a],
    ];
    const picks = new Set(orders.map((o) => selectSource(o, null, { now }).selected?.id));
    expect(picks.size).toBe(1);
  });
});
