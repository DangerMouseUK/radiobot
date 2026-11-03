import { describe, expect, it } from 'vitest';
import { ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import { Metrics } from '../../src/observability/metrics.ts';
import type { SourceProbePatch } from '../../src/persistence/repositories/stations.ts';
import { SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import { SourceService } from '../../src/streams/source-service.ts';
import { UrlPolicy } from '../../src/streams/url-policy.ts';
import { memoryDb, silentLogger } from '../helpers.ts';

const HOUR = 3_600_000;

/** Offline checks of the availability/kill-switch logic; nothing here probes the network. */
function setup(opts: { disabledSourceIds?: string[]; disabledStationIds?: string[] } = {}) {
  const repos = memoryDb();
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
  const station = (slug: string, sources: Array<{ id: string; patch?: SourceProbePatch }> = []) => {
    const id = `demo:${slug}`;
    repos.stations.upsertProviderStation({
      id,
      provider: 'demo',
      slug,
      externalId: null,
      displayName: slug.toUpperCase(),
      aliases: [],
      tags: [],
      category: null,
      sortOrder: 1,
      officialPageUrl: null,
      officialLastSeenAt: null,
      catalogueStatus: 'active',
      description: null,
    });
    for (const s of sources) {
      repos.stations.upsertSeedSource({
        id: s.id,
        stationId: id,
        url: `https://stream.example.com/${s.id}`,
        label: null,
        priority: 10,
        transportHint: 'http-continuous',
        codecHint: null,
        provenance: 'official-player',
        provenanceDetail: 'test',
        rightsStatus: 'unreviewed',
      });
      if (s.patch) repos.stations.applyProbePatch(s.id, s.patch);
    }
    return repos.stations.getStation(id)!;
  };
  return { ...repos, service, station };
}

const verified = (o: SourceProbePatch = {}): SourceProbePatch => ({
  codec: 'mp3',
  identityStatus: 'verified',
  identityConfidence: 'medium',
  verificationState: 'eligible',
  lastProbeAt: new Date().toISOString(),
  ...o,
});

describe('station availability (FR-001)', () => {
  it('distinguishes no source, unverified, available, degraded, unavailable and retired', () => {
    const t = setup();
    expect(t.service.availability(t.station('none'))).toBe('no_source');
    expect(t.service.availability(t.station('fresh', [{ id: 'fresh-a' }]))).toBe('unverified');
    expect(t.service.availability(t.station('good', [{ id: 'good-a', patch: verified() }]))).toBe(
      'available',
    );
    expect(
      t.service.availability(
        t.station('meh', [{ id: 'meh-a', patch: verified({ verificationState: 'degraded' }) }]),
      ),
    ).toBe('degraded');
    expect(
      t.service.availability(
        t.station('down', [{ id: 'down-a', patch: verified({ verificationState: 'offline' }) }]),
      ),
    ).toBe('unavailable');
    t.stations.setCatalogueStatus('demo:good', 'retired');
    expect(t.service.availability(t.stations.getStation('demo:good')!)).toBe('retired');
  });

  it('ignores disabled sources', () => {
    const t = setup();
    const st = t.station('off', [{ id: 'off-a', patch: verified() }]);
    t.stations.setSourceEnabled('off-a', false, 'takedown');
    expect(t.service.availability(st)).toBe('no_source');
  });

  it('counts catalogue coverage honestly', () => {
    const t = setup();
    const list = [
      t.station('none'),
      t.station('fresh', [{ id: 'fresh-a' }]),
      t.station('good', [{ id: 'good-a', patch: verified() }]),
    ];
    t.stations.recordSuccess('good-a');
    expect(t.service.coverage(list)).toEqual({
      catalogued: 3,
      withSources: 2,
      usable: 1,
      verifiedPlayable: 1,
    });
  });
});

describe('operator kill switches', () => {
  it('disables listed sources and every source of listed stations, with a reason', () => {
    const t = setup({ disabledSourceIds: ['a-1'], disabledStationIds: ['demo:b'] });
    const a = t.station('a', [
      { id: 'a-1', patch: verified() },
      { id: 'a-2', patch: verified() },
    ]);
    const b = t.station('b', [{ id: 'b-1', patch: verified() }]);
    expect(t.service.sourcesFor(a.id).map((s) => [s.id, s.enabled])).toEqual([
      ['a-1', false],
      ['a-2', true],
    ]);
    expect(t.service.sourcesFor(a.id)[0]!.disabledReason).toBe('switched off by the bot owner');
    expect(t.service.isStationDisabled(b.id)).toBe(true);
    expect(t.service.availability(b)).toBe('unavailable');
    expect(t.service.select('g', b.id).selected).toBeNull();
    expect(t.service.select('g', a.id).selected?.id).toBe('a-2');
    // The database still holds the source as enabled: the switch is applied at read time.
    expect(t.stations.getSource('a-1')!.enabled).toBe(true);
  });
});

describe('probe freshness', () => {
  it('probes new and stale sources, retries failures after ten minutes, never disabled ones', () => {
    const t = setup();
    t.station('x', [{ id: 'x-1' }]);
    const now = Date.now();
    const src = t.stations.getSource('x-1')!;
    expect(t.service.needsProbe(src, now)).toBe(true);
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();
    expect(t.service.needsProbe({ ...src, lastProbeAt: at(HOUR) }, now)).toBe(false);
    expect(t.service.needsProbe({ ...src, lastProbeAt: at(25 * HOUR) }, now)).toBe(true);
    const offline = { ...src, verificationState: 'offline' as const };
    expect(t.service.needsProbe({ ...offline, lastProbeAt: at(5 * 60_000) }, now)).toBe(false);
    expect(t.service.needsProbe({ ...offline, lastProbeAt: at(11 * 60_000) }, now)).toBe(true);
    expect(t.service.needsProbe({ ...src, enabled: false }, now)).toBe(false);
    expect(t.service.needsProbe({ ...src, rightsStatus: 'blocked' }, now)).toBe(false);
  });
});

describe('guild source preferences', () => {
  it('applies a pinned source to selection for that guild only', () => {
    const t = setup();
    t.station('p', [
      { id: 'p-1', patch: verified() },
      { id: 'p-2', patch: verified() },
    ]);
    t.guilds.setPreference('g1', 'demo:p', 'pin', 'p-2', null);
    expect(t.service.select('g1', 'demo:p')).toMatchObject({ mode: 'pin', selected: { id: 'p-2' } });
    expect(t.service.select('g2', 'demo:p')).toMatchObject({ mode: 'auto', selected: { id: 'p-1' } });
    expect(t.service.select('g1', 'demo:p', new Set(['p-2'])).degraded).toBe(true);
  });

  it('recovers a cooled-down source once it plays again', () => {
    const t = setup();
    t.station('c', [{ id: 'c-1', patch: verified({ verificationState: 'cooldown' }) }]);
    t.service.recordPlaybackSuccess('c-1');
    expect(t.stations.getSource('c-1')!.verificationState).toBe('eligible');
  });
});
