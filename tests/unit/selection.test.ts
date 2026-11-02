import { describe, expect, it } from 'vitest';
import {
  CONCLUSION_TEXT,
  checkEligibility,
  compareSources,
  effectiveBitrate,
  selectSource,
  transportTier,
} from '../../src/streams/ranking.ts';
import { makeSource } from '../helpers.ts';

const now = Date.parse('2026-10-31T12:00:00Z');

describe('transport tiers (direct first, HLS last resort)', () => {
  it('orders direct < unknown < HLS, treating unexpected values as unknown', () => {
    expect(transportTier({ transport: 'http-continuous' })).toBe(0);
    expect(transportTier({ transport: 'unknown' })).toBe(1);
    expect(transportTier({ transport: 'hls' })).toBe(2);
    expect(transportTier({ transport: 'rtmp' as never })).toBe(1);
  });

  it('sorts a mixed set by tier before anything else', () => {
    const sorted = [
      makeSource({ id: 'hls', transport: 'hls', healthScore: 100, priority: 0 }),
      makeSource({ id: 'unknown', transport: 'unknown', priority: 0 }),
      makeSource({ id: 'direct', healthScore: 40, priority: 99 }),
    ].sort(compareSources);
    expect(sorted.map((s) => s.id)).toEqual(['direct', 'unknown', 'hls']);
  });
});

describe('tie-breaking between equivalent sources', () => {
  it('uses health (≥20 points), then startup time (>1.5 s), then priority and id', () => {
    const a = makeSource({ id: 'a', healthScore: 50, startupMs: 4000, priority: 20 });
    expect(compareSources(a, makeSource({ id: 'b', healthScore: 80 }))).toBeGreaterThan(0);
    expect(compareSources(a, makeSource({ id: 'b', healthScore: 65, startupMs: 1000 }))).toBeGreaterThan(0);
    expect(
      compareSources(a, makeSource({ id: 'b', healthScore: 65, startupMs: 3000, priority: 30 })),
    ).toBeLessThan(0);
    expect(compareSources(makeSource({ id: 'a' }), makeSource({ id: 'b' }))).toBeLessThan(0);
  });
});

describe('eligibility reasons', () => {
  const reasons = (o: Parameters<typeof makeSource>[0]) => checkEligibility(makeSource(o), now).reasons;

  it('explains each failed gate', () => {
    expect(reasons({ enabled: false, disabledReason: 'takedown' })).toContain('disabled: takedown');
    expect(reasons({ rightsStatus: 'blocked' })).toContain('blocked by rights/takedown policy');
    expect(reasons({ identityStatus: 'mismatch' })).toContain(
      'plays a different station (identity mismatch)',
    );
    expect(reasons({ verificationState: 'blocked_by_policy' })).toContain(
      'blocked by the bot’s safety rules',
    );
    expect(reasons({ verificationState: 'offline', lastFailureCode: 'HTTP_STATUS' })).toContain(
      'last check failed (HTTP_STATUS)',
    );
    expect(reasons({ lastProbeAt: null })).toContain('not checked yet');
    expect(reasons({ codec: null })).toContain('codec not verified');
  });

  it('only honours a cooldown that has not yet expired', () => {
    expect(
      checkEligibility(makeSource({ cooldownUntil: new Date(now - 1000).toISOString() }), now).eligible,
    ).toBe(true);
    expect(reasons({ cooldownUntil: new Date(now + 60_000).toISOString() })[0]).toMatch(
      /^resting after repeated failures until/,
    );
  });
});

describe('bitrate evidence', () => {
  it('prefers measured over codec metadata over advertised values', () => {
    expect(effectiveBitrate(makeSource({ measuredBitrateKbps: 120, codecBitrateKbps: 128 }))).toEqual({
      kbps: 120,
      strong: true,
    });
    expect(effectiveBitrate(makeSource({ measuredBitrateKbps: null, codecBitrateKbps: 128 }))).toEqual({
      kbps: 128,
      strong: true,
    });
    expect(
      effectiveBitrate(
        makeSource({ measuredBitrateKbps: null, codecBitrateKbps: null, advertisedBitrateKbps: 320 }),
      ),
    ).toEqual({ kbps: 320, strong: false });
  });
});

describe('selection preferences', () => {
  it('honours a preferred source, and falls back to automatic selection silently when it is unavailable', () => {
    const sources = [makeSource({ id: 'a', priority: 1 }), makeSource({ id: 'b', priority: 2 })];
    const pref = (sourceId: string) =>
      ({ guildId: 'g', stationId: 's', mode: 'prefer', sourceId, updatedAt: '' }) as const;
    const preferred = selectSource(sources, pref('b'), { now });
    expect(preferred.selected?.id).toBe('b');
    expect(preferred.fallback?.id).toBe('a');
    const missing = selectSource(sources, pref('gone'), { now });
    expect(missing.selected?.id).toBe('a');
    expect(missing.degraded).toBe(false);
    expect(missing.explanation[0]).toMatch(/Preferred source is unavailable/);
  });

  it('does not claim HLS is the only option when an administrator pins HLS over an eligible direct stream', () => {
    const sources = [makeSource({ id: 'direct' }), makeSource({ id: 'hls', transport: 'hls' })];
    const r = selectSource(
      sources,
      { guildId: 'g', stationId: 's', mode: 'pin', sourceId: 'hls', updatedAt: '' },
      { now },
    );
    expect(r.selected?.id).toBe('hls');
    expect(r.fallback?.id).toBe('direct');
    expect(r.explanation.join(' ')).not.toMatch(/Only HLS is available/);
  });

  it('has user-facing text for every conclusion', () => {
    for (const text of Object.values(CONCLUSION_TEXT)) expect(text.length).toBeGreaterThan(10);
  });
});
