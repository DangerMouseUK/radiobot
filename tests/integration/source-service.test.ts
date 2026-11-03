import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import { Metrics } from '../../src/observability/metrics.ts';
import { SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import { CIRCUIT_BREAK_FAILURES, SourceService } from '../../src/streams/source-service.ts';
import { UrlPolicy } from '../../src/streams/url-policy.ts';
import { memoryDb, silentLogger } from '../helpers.ts';
import { binaries, generateFixtures, startTestRadio, type TestRadio } from './fixture-server.ts';

let radio: TestRadio;
const registry = new ProcessRegistry();

beforeAll(async () => {
  radio = await startTestRadio(generateFixtures());
}, 120_000);
afterAll(async () => {
  registry.killAll();
  await radio?.close();
});

function setup(path: string, provenance: 'official-player' | 'auto-discovered' = 'official-player') {
  const repos = memoryDb();
  repos.stations.upsertProviderStation({
    id: 'demo:test-station',
    provider: 'demo',
    slug: 'test-station',
    externalId: null,
    displayName: 'TEST STATION',
    aliases: [],
    tags: [],
    category: null,
    sortOrder: 1,
    officialPageUrl: null,
    officialLastSeenAt: null,
    catalogueStatus: 'active',
    description: null,
  });
  repos.stations.upsertSeedSource({
    id: 'test-src',
    stationId: 'demo:test-station',
    url: `${radio.base}${path}`,
    label: 'Direct',
    priority: 10,
    transportHint: 'http-continuous',
    codecHint: 'mp3',
    provenance,
    provenanceDetail: 'fixture',
    rightsStatus: 'unreviewed',
  });
  const { ffmpeg, ffprobe } = binaries();
  const service = new SourceService({
    stations: repos.stations,
    guilds: repos.guilds,
    client: new SafeHttpClient(
      new UrlPolicy({ allowInsecureHttp: true, testAllowedAddresses: ['127.0.0.1'] }),
    ),
    registry,
    ffmpegPath: ffmpeg,
    ffprobePath: ffprobe,
    maxConcurrentProbes: 2,
    logger: silentLogger(),
    metrics: new Metrics(),
    probeBudget: { totalMs: 20_000, sampleMs: 1_500, maxSampleBytes: 2 * 1024 * 1024 },
  });
  return { ...repos, service };
}

describe('SourceService', () => {
  it('probes on first play and makes an official mapping eligible', async () => {
    const t = setup('/mp3');
    expect(t.service.availability(t.stations.getStation('demo:test-station')!)).toBe('unverified');
    const sel = await t.service.prepareForPlayback('g', 'demo:test-station');
    expect(sel.selected?.id).toBe('test-src');
    const src = t.stations.getSource('test-src')!;
    expect(src.verificationState).toBe('eligible');
    expect(src.codec).toBe('mp3');
    expect(t.stations.listProbeResults('test-src')).toHaveLength(1);
    expect(t.service.availability(t.stations.getStation('demo:test-station')!)).toBe('available');
  }, 60_000);

  it('a cancelled waiter never records a failure or cancels another guild (review #2)', async () => {
    const t = setup('/mp3');
    const abort = new AbortController();
    const a = t.service.probe('test-src', { signal: abort.signal });
    const b = t.service.probe('test-src');
    abort.abort();
    await expect(a).rejects.toMatchObject({ code: 'CANCELLED' });
    const report = await b;
    expect(report.outcome.success).toBe(true);
    const src = t.stations.getSource('test-src')!;
    expect(src.verificationState).toBe('eligible');
    expect(src.failureCount).toBe(0);
  }, 60_000);

  it('an already-aborted playback request does not probe', async () => {
    const t = setup('/mp3');
    const abort = new AbortController();
    abort.abort();
    await expect(
      t.service.prepareForPlayback('g', 'demo:test-station', { signal: abort.signal }),
    ).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    expect(t.stations.getSource('test-src')!.lastProbeAt).toBeNull();
  });

  it('marks access-refused sources offline with ACCESS_DENIED evidence and keeps them out of selection', async () => {
    const t = setup('/forbidden');
    const sel = await t.service.prepareForPlayback('g', 'demo:test-station');
    expect(sel.selected).toBeNull();
    const src = t.stations.getSource('test-src')!;
    expect(src.verificationState).toBe('offline');
    expect(src.lastFailureCode).toBe('ACCESS_DENIED');
  }, 60_000);

  it('marks missing (HTTP 404) sources offline, recorded as NOT_FOUND (gone)', async () => {
    const t = setup('/nope');
    const sel = await t.service.prepareForPlayback('g', 'demo:test-station');
    expect(sel.selected).toBeNull();
    const src = t.stations.getSource('test-src')!;
    expect(src.verificationState).toBe('offline');
    expect(src.lastFailureCode).toBe('NOT_FOUND');
  }, 60_000);

  it('never verifies an auto-discovered source on its own', async () => {
    const t = setup('/icy', 'auto-discovered');
    const r = await t.service.probe('test-src');
    expect(r.outcome.success).toBe(true);
    expect(r.identity.status).not.toBe('verified');
  }, 60_000);

  it('trips the circuit breaker after repeated playback failures', () => {
    const t = setup('/mp3');
    // Failures a few seconds apart, as the session's retries make them.
    const start = Date.now();
    for (let n = 1; n < CIRCUIT_BREAK_FAILURES; n++) {
      expect(t.service.recordPlaybackFailure('test-src', 'STREAM_STALLED', start + n * 5_000)).toBe(false);
    }
    expect(t.stations.getSource('test-src')!.cooldownUntil).toBeNull();
    // The last one, more than a minute into the streak, trips it.
    expect(t.service.recordPlaybackFailure('test-src', 'STREAM_STALLED', start + 65_000)).toBe(true);
    expect(t.stations.getSource('test-src')!.cooldownUntil).not.toBeNull();
  });
});
