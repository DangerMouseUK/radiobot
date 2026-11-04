import { describe, expect, it, vi } from 'vitest';
import { ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import { seedPacks } from '../../src/catalogue/packs.ts';
import type { Station, StationAvailability, StationSource } from '../../src/catalogue/types.ts';
import { Metrics } from '../../src/observability/metrics.ts';
import type { SourceProbePatch } from '../../src/persistence/repositories/stations.ts';
import { checkEligibility, isEligibleNow } from '../../src/streams/ranking.ts';
import { SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import { COVERAGE_MAX_AGE_MS, type CoverageCounts, SourceService } from '../../src/streams/source-service.ts';
import { UrlPolicy } from '../../src/streams/url-policy.ts';
import { demoRegistry, makeSource, memoryDb, silentLogger } from '../helpers.ts';

const NOW = Date.parse('2026-11-01T12:00:00Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

/** The previous implementations, kept here as the reference the faster ones must match. */
function referenceCoverage(service: SourceService, stations: Station[], now: number): CoverageCounts {
  let withSources = 0;
  let usable = 0;
  let verifiedPlayable = 0;
  for (const st of stations) {
    const sources = service.sourcesFor(st.id).filter((s) => s.enabled);
    if (sources.length > 0) withSources++;
    if (sources.some((s) => s.codec !== null && s.lastSuccessAt !== null)) usable++;
    if (sources.some((s) => checkEligibility(s, now).eligible)) verifiedPlayable++;
  }
  return { catalogued: stations.length, withSources, usable, verifiedPlayable };
}

function referenceAvailability(service: SourceService, station: Station, now: number): StationAvailability {
  if (station.catalogueStatus === 'retired') return 'retired';
  const sources = service.sourcesFor(station.id).filter((s) => s.enabled);
  if (sources.length === 0) return service.isStationDisabled(station.id) ? 'unavailable' : 'no_source';
  const eligible = sources.filter((s) => checkEligibility(s, now).eligible);
  if (eligible.length > 0) {
    const best = Math.max(...eligible.map((s) => s.healthScore));
    return best < 30 || eligible.every((s) => s.verificationState === 'degraded') ? 'degraded' : 'available';
  }
  if (
    sources.some((s) => s.lastProbeAt === null || (s.identityStatus === 'unverified' && s.codec !== null))
  ) {
    return 'unverified';
  }
  return 'unavailable';
}

/** Ways a source can stand after checks and playback, applied round-robin to the demo pack's sources. */
const PATCHES: SourceProbePatch[] = [
  {},
  { verificationState: 'eligible', identityStatus: 'verified', codec: 'mp3', lastProbeAt: iso(-60_000) },
  { verificationState: 'degraded', identityStatus: 'verified', codec: 'aac', lastProbeAt: iso(-60_000) },
  { verificationState: 'offline', identityStatus: 'verified', codec: 'mp3', lastProbeAt: iso(-60_000) },
  { verificationState: 'eligible', identityStatus: 'unverified', codec: 'aac', lastProbeAt: iso(-60_000) },
  { verificationState: 'eligible', identityStatus: 'mismatch', codec: 'mp3', lastProbeAt: iso(-60_000) },
  { verificationState: 'blocked_by_policy', identityStatus: 'verified', lastProbeAt: iso(-60_000) },
  { verificationState: 'eligible', identityStatus: 'verified', codec: null, lastProbeAt: iso(-60_000) },
];

function setup(opts: { disabledSourceIds?: string[]; disabledStationIds?: string[] } = {}) {
  const repos = memoryDb();
  seedPacks(repos.stations, demoRegistry());
  const service = new SourceService({
    stations: repos.stations,
    guilds: repos.guilds,
    client: new SafeHttpClient(new UrlPolicy({ allowInsecureHttp: true })),
    registry: new ProcessRegistry(),
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    maxConcurrentProbes: 1,
    logger: silentLogger(),
    metrics: new Metrics(),
    disabledSourceIds: new Set(opts.disabledSourceIds ?? []),
    disabledStationIds: new Set(opts.disabledStationIds ?? []),
  });
  const all = repos.stations.listAllSources();
  all.forEach((s, i) => {
    const patch = PATCHES[i % PATCHES.length]!;
    if (Object.keys(patch).length > 0) repos.stations.applyProbePatch(s.id, patch);
    if (i % 3 === 0) repos.stations.recordSuccess(s.id, iso(-30_000));
    if (i % 5 === 1) repos.stations.setCooldown(s.id, iso(i % 2 ? 3_600_000 : -3_600_000));
    if (i % 7 === 2) repos.stations.setSourceEnabled(s.id, false, 'switched off by the pack');
  });
  const stations = repos.stations.listBuiltinStations();
  return { repos, service, stations, sources: all };
}

describe('coverage and availability', () => {
  it('count the demo pack exactly as before, with and without the owner’s switches', () => {
    const plain = setup();
    const ids = plain.sources.map((s) => s.id);
    const stationIds = plain.stations.map((s) => s.id);
    for (const t of [
      plain,
      setup({ disabledSourceIds: ids.filter((_, i) => i % 4 === 1) }),
      setup({ disabledStationIds: stationIds.filter((_, i) => i % 3 === 0) }),
    ]) {
      expect(t.stations.length).toBeGreaterThan(5);
      for (const at of [NOW, NOW + 2 * 3_600_000]) {
        expect(t.service.coverage(t.stations, at)).toEqual(referenceCoverage(t.service, t.stations, at));
        for (const st of t.stations) {
          expect(t.service.availability(st, at)).toBe(referenceAvailability(t.service, st, at));
        }
      }
      // Something of every kind, so the comparison means something.
      const counts = t.service.coverage(t.stations, NOW);
      expect(counts.verifiedPlayable).toBeGreaterThan(0);
      expect(counts.verifiedPlayable).toBeLessThan(counts.catalogued);
    }
  });

  it('agrees with the full eligibility check for every combination that matters', () => {
    const states = ['discovered', 'resolved', 'eligible', 'degraded', 'cooldown', 'offline', 'unverified'];
    for (const verificationState of [...states, 'blocked_by_policy'] as StationSource['verificationState'][])
      for (const identityStatus of ['verified', 'unverified', 'mismatch'] as const)
        for (const enabled of [true, false])
          for (const rightsStatus of ['unreviewed', 'blocked'] as const)
            for (const codec of ['mp3', null])
              for (const lastProbeAt of [iso(-1), null])
                for (const cooldownUntil of [null, iso(-1), iso(1)]) {
                  const s = makeSource({
                    verificationState,
                    identityStatus,
                    enabled,
                    rightsStatus,
                    codec,
                    lastProbeAt,
                    cooldownUntil,
                  });
                  expect(isEligibleNow(s, NOW)).toBe(checkEligibility(s, NOW).eligible);
                }
  });

  it('caches per pack until a source changes or a minute passes', () => {
    const t = setup();
    const list = vi.spyOn(t.repos.stations, 'listProviderStations');
    const active = t.stations.filter((s) => s.catalogueStatus !== 'retired');
    const first = t.service.coverageByProvider('demo', NOW);
    expect(first).toEqual(referenceCoverage(t.service, active, NOW));
    expect(t.service.coverageByProvider('demo', NOW + 1_000)).toEqual(first);
    expect(list).toHaveBeenCalledTimes(1);
    // A copy each time: a caller adding them up can't change the cached counts.
    t.service.coverageByProvider('demo', NOW + 1_000).usable = -1;
    expect(t.service.coverageByProvider('demo', NOW + 2_000)).toEqual(first);
    expect(list).toHaveBeenCalledTimes(1);

    // A check result changes the counts at once.
    for (const s of t.sources) {
      t.repos.stations.setSourceEnabled(s.id, true, null);
      t.repos.stations.applyProbePatch(s.id, PATCHES[1]!);
      t.repos.stations.setCooldown(s.id, null);
    }
    const after = t.service.coverageByProvider('demo', NOW + 3_000);
    expect(list).toHaveBeenCalledTimes(2);
    expect(after).toEqual(referenceCoverage(t.service, active, NOW + 3_000));
    expect(after.verifiedPlayable).toBeGreaterThan(first.verifiedPlayable);

    // Holds end with time, so the counts are at most a minute old.
    t.service.coverageByProvider('demo', NOW + 3_000 + COVERAGE_MAX_AGE_MS - 1);
    expect(list).toHaveBeenCalledTimes(2);
    t.service.coverageByProvider('demo', NOW + 3_000 + COVERAGE_MAX_AGE_MS);
    expect(list).toHaveBeenCalledTimes(3);
    // Other packs are counted on their own (and an unknown one has nothing).
    expect(t.service.coverageByProvider('other', NOW)).toEqual({
      catalogued: 0,
      withSources: 0,
      usable: 0,
      verifiedPlayable: 0,
    });
  });

  it('leaves retired stations out of a pack’s counts', () => {
    const t = setup();
    const before = t.service.coverageByProvider('demo', NOW);
    t.repos.stations.setCatalogueStatus(t.stations[0]!.id, 'retired');
    expect(t.service.coverageByProvider('demo', NOW).catalogued).toBe(before.catalogued - 1);
  });
});
