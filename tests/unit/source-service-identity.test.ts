import { describe, expect, it, vi } from 'vitest';
import { ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import type { SourceProvenance } from '../../src/catalogue/types.ts';
import { Metrics } from '../../src/observability/metrics.ts';
import type { SourceProbePatch } from '../../src/persistence/repositories/stations.ts';
import { RadioError } from '../../src/shared/errors.ts';
import type { CorrelationResult } from '../../src/streams/identity.ts';
import { emptyOutcome, type ProbeOutcome, type probeSource } from '../../src/streams/probe.ts';
import { SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import { UrlPolicy } from '../../src/streams/url-policy.ts';
import { memoryDb, silentLogger } from '../helpers.ts';

/**
 * SourceService over an in-memory database with the network check and the audio comparison
 * replaced: what is recorded after a check, identity decisions, and the order of foreground checks.
 */
const comparisons = vi.hoisted(() => ({
  calls: [] as Array<{ a: string; b: string; owner: string }>,
  next: null as null | ((a: string, b: string) => Promise<CorrelationResult>),
}));

vi.mock('../../src/streams/identity.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/streams/identity.ts')>();
  return {
    ...actual,
    compareSources: (_deps: unknown, a: string, b: string, o: { owner: string }) => {
      comparisons.calls.push({ a, b, owner: o.owner });
      return comparisons.next!(a, b);
    },
  };
});

const { SourceService } = await import('../../src/streams/source-service.ts');

const STATION = 'mypack:my-station';

const ok = (o: Partial<ProbeOutcome> = {}): ProbeOutcome => ({
  ...emptyOutcome(Date.now()),
  success: true,
  transport: 'http-continuous',
  effectiveHost: 'stream.example.com',
  container: 'mp3',
  codec: 'mp3',
  sampleRateHz: 44_100,
  channels: 2,
  channelLayout: 'stereo',
  advertisedBitrateKbps: 128,
  measuredBitrateKbps: 128,
  bitrateEvidence: 'measured',
  startupMs: 300,
  ...o,
});
const failed = (failureCode: ProbeOutcome['failureCode']): ProbeOutcome => ({
  ...emptyOutcome(Date.now()),
  failureCode,
  failureDetail: 'test',
});

const verified = (o: SourceProbePatch = {}): SourceProbePatch => ({
  codec: 'mp3',
  sampleRateHz: 44_100,
  channels: 2,
  measuredBitrateKbps: 128,
  identityStatus: 'verified',
  identityConfidence: 'medium',
  verificationState: 'eligible',
  lastProbeAt: new Date().toISOString(),
  ...o,
});

interface SourceDef {
  id: string;
  provenance?: SourceProvenance;
  transportHint?: 'http-continuous' | 'hls';
  priority?: number;
  patch?: SourceProbePatch;
}

function setup(sources: SourceDef[], extra: { disabledStationIds?: string[] } = {}) {
  const repos = memoryDb();
  const station = (id: string, displayName: string) =>
    repos.stations.upsertProviderStation({
      id,
      provider: 'mypack',
      slug: id.split(':')[1]!,
      externalId: null,
      displayName,
      aliases: [],
      tags: [],
      category: null,
      sortOrder: 1,
      officialPageUrl: null,
      officialLastSeenAt: null,
      catalogueStatus: 'active',
      description: null,
    });
  station(STATION, 'My Station');
  station('mypack:other-station', 'Other Station');
  for (const s of sources) {
    repos.stations.upsertSeedSource({
      id: s.id,
      stationId: STATION,
      url: `https://${s.id}.example.com/live`,
      label: null,
      priority: s.priority ?? 10,
      transportHint: s.transportHint ?? 'http-continuous',
      codecHint: null,
      provenance: s.provenance ?? 'official-player',
      provenanceDetail: 'test',
      rightsStatus: 'unreviewed',
    });
    if (s.patch) repos.stations.applyProbePatch(s.id, s.patch);
  }
  const probed: string[] = [];
  const outcomes = new Map<string, () => ProbeOutcome | Promise<ProbeOutcome>>();
  const probeImpl: typeof probeSource = async (_deps, url) => {
    const id = new URL(url).hostname.split('.')[0]!;
    probed.push(id);
    const next = outcomes.get(id);
    return next ? next() : failed('HTTP_TIMEOUT');
  };
  const metrics = new Metrics();
  const service = new SourceService({
    stations: repos.stations,
    guilds: repos.guilds,
    client: new SafeHttpClient(new UrlPolicy({ allowInsecureHttp: true })),
    registry: new ProcessRegistry(),
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    maxConcurrentProbes: 2,
    logger: silentLogger(),
    metrics,
    probeImpl,
    disabledStationIds: new Set(extra.disabledStationIds ?? []),
  });
  const source = (id: string) => repos.stations.getSource(id)!;
  return { ...repos, service, metrics, probed, outcomes, source };
}

describe('recording a check', () => {
  it("notes when a source's codec, bitrate or sample rate changes", async () => {
    const t = setup([{ id: 'a', patch: verified() }, { id: 'fresh' }]);
    const changed = () => t.metrics.get('source.characteristics_changed');
    t.outcomes.set('a', () => ok());
    await t.service.probe('a');
    expect(changed()).toBe(0);
    // Within 15 %: the same stream measured slightly differently.
    t.outcomes.set('a', () => ok({ measuredBitrateKbps: 140 }));
    await t.service.probe('a');
    expect(changed()).toBe(0);
    t.outcomes.set('a', () => ok({ measuredBitrateKbps: 192 }));
    await t.service.probe('a');
    expect(changed()).toBe(1);
    t.outcomes.set('a', () => ok({ measuredBitrateKbps: 192, codec: 'aac' }));
    await t.service.probe('a');
    expect(changed()).toBe(2);
    t.outcomes.set('a', () => ok({ measuredBitrateKbps: 192, codec: 'aac', sampleRateHz: 48_000 }));
    await t.service.probe('a');
    expect(changed()).toBe(3);
    expect(t.source('a')).toMatchObject({ codec: 'aac', sampleRateHz: 48_000, measuredBitrateKbps: 192 });
    // A first check has nothing to compare with.
    t.outcomes.set('fresh', () => ok({ codec: 'opus' }));
    await t.service.probe('fresh');
    expect(changed()).toBe(3);
    expect(t.metrics.get('probe.success')).toBe(6);
  });

  it('keeps sources the URL policy refuses apart from sources that are merely offline', async () => {
    const t = setup([{ id: 'blocked' }, { id: 'encrypted' }, { id: 'slow' }, { id: 'odd' }]);
    t.outcomes.set('blocked', () => failed('ADDRESS_BLOCKED'));
    t.outcomes.set('encrypted', () => failed('HLS_ENCRYPTED'));
    t.outcomes.set('odd', () => failed(null));
    for (const id of ['blocked', 'encrypted', 'slow', 'odd']) await t.service.probe(id);
    expect(t.source('blocked').verificationState).toBe('blocked_by_policy');
    expect(t.source('encrypted').verificationState).toBe('blocked_by_policy');
    expect(t.source('slow')).toMatchObject({ verificationState: 'offline', lastFailureCode: 'HTTP_TIMEOUT' });
    expect(t.source('odd')).toMatchObject({ verificationState: 'offline', lastFailureCode: 'PROBE_FAILED' });
    expect(t.metrics.get('probe.failure')).toBe(4);
  });

  it('marks a stream that decodes with many errors as degraded', async () => {
    const t = setup([{ id: 'a' }, { id: 'b' }]);
    t.outcomes.set('a', () => ok({ decodeErrors: 4 }));
    t.outcomes.set('b', () => ok({ decodeErrors: 3 }));
    await t.service.probe('a');
    await t.service.probe('b');
    expect(t.source('a').verificationState).toBe('degraded');
    expect(t.source('b').verificationState).toBe('eligible');
  });

  it('never makes a working but unconfirmed source eligible', async () => {
    const t = setup([{ id: 'found', provenance: 'auto-discovered' }, { id: 'named' }]);
    t.outcomes.set('found', () => ok());
    // An official source whose stream now names another catalogue station.
    t.outcomes.set('named', () => ok({ icyName: 'Other Station' }));
    const found = await t.service.probe('found');
    expect(found.identity.status).toBe('unverified');
    expect(t.source('found').verificationState).toBe('unverified');
    const named = await t.service.probe('named');
    expect(named.identity.status).toBe('mismatch');
    expect(t.source('named').verificationState).toBe('unverified');
  });

  it('reports an unknown source, and passes on a failed check to a waiting caller', async () => {
    const t = setup([{ id: 'a' }]);
    await expect(t.service.probe('nope')).rejects.toMatchObject({ code: 'INTERNAL' });
    t.outcomes.set('a', () => {
      throw new Error('socket hang up');
    });
    await expect(t.service.probe('a', { signal: new AbortController().signal })).rejects.toThrow(
      'socket hang up',
    );
  });

  it('lets a background check join a check a play is already waiting for', async () => {
    const t = setup([{ id: 'a' }]);
    let release!: (o: ProbeOutcome) => void;
    t.outcomes.set('a', () => new Promise<ProbeOutcome>((resolve) => (release = resolve)));
    const play = t.service.probe('a');
    t.service.refreshInBackground(['a']);
    await new Promise((r) => setTimeout(r, 20));
    release(ok());
    await play;
    await new Promise((r) => setTimeout(r, 20));
    expect(t.probed).toEqual(['a']);
  });
});

describe('identity outside a check', () => {
  it('records a contradiction from live metadata, unless audio comparison supports the source', () => {
    const t = setup([
      { id: 'plain', patch: verified() },
      {
        id: 'matched',
        patch: verified({
          identityEvidence: [
            {
              kind: 'correlation',
              verdict: 'supports',
              detail: 'Audio matches.',
              at: new Date().toISOString(),
            },
          ],
        }),
      },
    ]);
    t.service.flagIdentityContradiction('nope', 'irrelevant');
    expect(t.metrics.get('source.identity_contradiction')).toBe(0);
    t.service.flagIdentityContradiction('plain', 'Stream name "Other Station" is another station.');
    expect(t.source('plain')).toMatchObject({ identityStatus: 'mismatch', verificationState: 'unverified' });
    t.service.flagIdentityContradiction('matched', 'Stream name "Other Station" is another station.');
    expect(t.source('matched')).toMatchObject({ identityStatus: 'verified', verificationState: 'eligible' });
    expect(t.metrics.get('source.identity_contradiction')).toBe(2);
  });

  it("re-decides identity after an admin's review, without a network check", () => {
    const t = setup([
      {
        id: 'found',
        provenance: 'auto-discovered',
        patch: verified({ identityStatus: 'unverified', verificationState: 'unverified' }),
      },
      { id: 'wrong', patch: verified() },
      {
        id: 'policy',
        provenance: 'auto-discovered',
        patch: verified({ identityStatus: 'unverified', verificationState: 'blocked_by_policy' }),
      },
      { id: 'never', provenance: 'auto-discovered' },
      { id: 'named', patch: verified({ icyName: 'Other Station' }) },
    ]);
    expect(t.service.reevaluateIdentity('nope')).toBeNull();

    t.stations.setIdentityOverride('found', 'verified');
    expect(t.service.reevaluateIdentity('found')?.status).toBe('verified');
    expect(t.source('found').verificationState).toBe('eligible');

    t.stations.setIdentityOverride('wrong', 'mismatch');
    expect(t.service.reevaluateIdentity('wrong')?.status).toBe('mismatch');
    expect(t.source('wrong').verificationState).toBe('unverified');

    // A policy block is not lifted by an identity decision.
    t.stations.setIdentityOverride('policy', 'verified');
    t.service.reevaluateIdentity('policy');
    expect(t.source('policy')).toMatchObject({
      identityStatus: 'verified',
      verificationState: 'blocked_by_policy',
    });

    // A source never checked stays waiting for its first check.
    t.stations.setIdentityOverride('never', 'verified');
    t.service.reevaluateIdentity('never');
    expect(t.source('never')).toMatchObject({ identityStatus: 'verified', verificationState: 'discovered' });

    // The stream name stored at the last check still counts.
    expect(t.service.reevaluateIdentity('named')?.status).toBe('mismatch');
  });
});

describe('preparing to play', () => {
  it('checks nothing for a station the operator disabled', async () => {
    const t = setup([{ id: 'a' }], { disabledStationIds: [STATION] });
    const sel = await t.service.prepareForPlayback('123456789012345678', STATION);
    expect(sel.selected).toBeNull();
    expect(t.probed).toEqual([]);
    t.service.refreshStation(STATION);
    await new Promise((r) => setTimeout(r, 20));
    expect(t.probed).toEqual([]);
  });

  it("checks a server's chosen source first, then direct streams by priority, HLS last", async () => {
    const t = setup([
      { id: 'hls', transportHint: 'hls', priority: 1 },
      { id: 'late', priority: 20 },
      { id: 'early', priority: 10 },
      { id: 'chosen', transportHint: 'hls', priority: 30 },
    ]);
    t.guilds.setPreference('123456789012345678', STATION, 'pin', 'chosen', null);
    const sel = await t.service.prepareForPlayback('123456789012345678', STATION);
    expect(sel.selected).toBeNull();
    expect(t.probed).toEqual(['chosen', 'early', 'late', 'hls']);
  });

  it('stops checking as soon as one source works', async () => {
    const t = setup([
      { id: 'hls', transportHint: 'hls', priority: 1 },
      { id: 'late', priority: 20 },
      { id: 'early', priority: 10 },
    ]);
    t.outcomes.set('early', () => ok());
    const sel = await t.service.prepareForPlayback('123456789012345678', STATION);
    expect(sel.selected?.id).toBe('early');
    expect(t.probed).toEqual(['early']);
  });

  it('re-checks the due sources of a station once its stream has settled', async () => {
    const t = setup([{ id: 'a', patch: verified() }, { id: 'b' }]);
    t.service.refreshStation(STATION);
    const start = Date.now();
    while (t.probed.length === 0 && Date.now() - start < 2_000) await new Promise((r) => setTimeout(r, 5));
    expect(t.probed).toEqual(['b']);
  });
});

describe('deep verification', () => {
  const result = (score: number, prominence: number): CorrelationResult => ({
    score,
    lagSeconds: 1.5,
    prominence,
    uniqueness: 2,
    overlapSeconds: 30,
  });

  it('needs a verified source to compare against', async () => {
    const t = setup([{ id: 'found', provenance: 'auto-discovered' }]);
    await expect(t.service.deepVerify('123456789012345678', STATION)).rejects.toMatchObject({
      code: 'NO_ELIGIBLE_SOURCE',
    });
  });

  it('verifies a candidate whose audio matches the verified source, and reports failures plainly', async () => {
    const t = setup([
      { id: 'good', patch: verified() },
      {
        id: 'twin',
        provenance: 'auto-discovered',
        patch: verified({ identityStatus: 'unverified', verificationState: 'unverified' }),
      },
      {
        id: 'other',
        provenance: 'auto-discovered',
        patch: verified({ identityStatus: 'unverified', verificationState: 'unverified' }),
      },
      {
        id: 'flaky',
        provenance: 'auto-discovered',
        patch: verified({ identityStatus: 'unverified', verificationState: 'unverified' }),
      },
      {
        id: 'broken',
        provenance: 'auto-discovered',
        patch: verified({ identityStatus: 'unverified', verificationState: 'unverified' }),
      },
    ]);
    comparisons.calls.length = 0;
    comparisons.next = async (_a, b) => {
      if (b.includes('twin')) return result(0.8, 12);
      if (b.includes('other')) return result(0.1, 3);
      if (b.includes('flaky')) throw new RadioError('HTTP_TIMEOUT', 'The station took too long to answer.');
      throw new Error('decoder crashed');
    };
    const results = await t.service.deepVerify('123456789012345678', STATION);
    // Every unverified candidate, one after another (sources of equal priority go by ID).
    expect(comparisons.calls.map((c) => [c.a, c.b, c.owner])).toEqual(
      ['broken', 'flaky', 'other', 'twin'].map((id) => [
        'https://good.example.com/live',
        `https://${id}.example.com/live`,
        `identity:${id}`,
      ]),
    );
    expect(results.map((r) => [r.sourceId, r.evidence?.verdict ?? null, r.error])).toEqual([
      ['broken', null, 'comparison failed'],
      ['flaky', null, 'The station took too long to answer.'],
      ['other', 'inconclusive', null],
      ['twin', 'supports', null],
    ]);
    expect(t.source('twin')).toMatchObject({ identityStatus: 'verified', verificationState: 'eligible' });
    expect(t.source('other')).toMatchObject({
      identityStatus: 'unverified',
      verificationState: 'unverified',
    });
    // A later comparison replaces the earlier one rather than piling up.
    comparisons.next = async () => result(0.1, 3);
    await t.service.deepVerify('123456789012345678', STATION, { all: true });
    expect(t.source('twin').identityEvidence.filter((e) => e.kind === 'correlation')).toHaveLength(1);
    // With `all`, verified sources are compared again too (the incumbent never against itself).
    expect(comparisons.calls.slice(4).map((c) => c.b)).toEqual(
      ['broken', 'flaky', 'other', 'twin'].map((id) => `https://${id}.example.com/live`),
    );
  });
});

describe('playback health', () => {
  it('keeps a source in cooldown until its cooldown has run out', () => {
    const t = setup([
      {
        id: 'a',
        patch: verified({ verificationState: 'cooldown' }),
      },
    ]);
    t.stations.setCooldown('a', new Date(Date.now() + 60_000).toISOString());
    t.service.recordPlaybackSuccess('a');
    expect(t.source('a').verificationState).toBe('cooldown');
    t.stations.setCooldown('a', new Date(Date.now() - 1).toISOString());
    t.service.recordPlaybackSuccess('a');
    expect(t.source('a').verificationState).toBe('eligible');
    // An unknown source is ignored.
    expect(() => t.service.recordPlaybackSuccess('nope')).not.toThrow();
  });
});

describe('playback health: blips, holds and the playing source', () => {
  it('needs repeated failures over a minute to put a source on hold, and counts one blip once', () => {
    const t = setup([{ id: 'a', patch: verified() }]);
    const start = Date.now();
    // Four quick failures (a 12 s blip and its retries) don't trip the breaker.
    for (const at of [0, 1_000, 4_000, 12_000])
      expect(t.service.recordPlaybackFailure('a', 'STREAM_EOF', start + at)).toBe(false);
    expect(t.source('a').cooldownUntil).toBeNull();
    // Several servers hearing the same blip at once count once.
    expect(t.service.recordPlaybackFailure('a', 'STREAM_EOF', start + 12_200)).toBe(false);
    expect(t.source('a').consecutiveFailures).toBe(4);
    // Still failing a minute later: now it is put on hold.
    expect(t.service.recordPlaybackFailure('a', 'STREAM_EOF', start + 61_000)).toBe(true);
    expect(t.source('a').cooldownUntil).not.toBeNull();
  });

  it('starts a new streak after a good check, so an old failover never makes a later blip trip it', () => {
    const t = setup([{ id: 'a', patch: verified() }]);
    const start = Date.now();
    for (const at of [0, 1_000, 4_000, 12_000])
      t.service.recordPlaybackFailure('a', 'STREAM_EOF', start + at);
    t.stations.recordSuccess('a'); // a background check worked
    const hour = start + 60 * 60_000;
    for (const at of [0, 1_000, 4_000]) t.service.recordPlaybackFailure('a', 'STREAM_EOF', hour + at);
    expect(t.service.recordPlaybackFailure('a', 'STREAM_EOF', hour + 12_000)).toBe(false);
    expect(t.source('a').cooldownUntil).toBeNull();
  });

  it('never re-checks a source the safety rules block just because its last check failed', () => {
    const t = setup([{ id: 'a', patch: verified({ verificationState: 'blocked_by_policy' }) }]);
    const failedAt = Date.now() + 1_000;
    t.stations.recordFailure('a', 'ADDRESS_BLOCKED', new Date(failedAt).toISOString());
    expect(t.service.needsProbe(t.source('a'), failedAt + 6 * 60_000)).toBe(false);
  });

  it('starts a new streak after steady playback, and steady playback clears a failed check', () => {
    const t = setup([{ id: 'a', patch: verified({ verificationState: 'offline' }) }]);
    const start = Date.now();
    t.service.recordPlaybackFailure('a', 'STREAM_EOF', start);
    t.service.recordPlaybackSuccess('a');
    expect(t.source('a').verificationState).toBe('eligible');
    for (const at of [70_000, 71_000, 74_000]) t.service.recordPlaybackFailure('a', 'STREAM_EOF', start + at);
    // The streak began at 70 s, so 82 s is only 12 s into it.
    expect(t.service.recordPlaybackFailure('a', 'STREAM_EOF', start + 82_000)).toBe(false);
  });

  it('re-checks a source on hold every couple of minutes when nothing else can play, and a good check ends the hold', async () => {
    const twoMinAgo = new Date(Date.now() - 3 * 60_000).toISOString();
    const t = setup([
      {
        id: 'a',
        patch: verified({
          verificationState: 'cooldown',
          lastProbeAt: twoMinAgo,
        }),
      },
    ]);
    t.stations.setCooldown('a', new Date(Date.now() + 60 * 60_000).toISOString());
    expect(t.service.needsProbe(t.source('a'), Date.now(), 'background')).toBe(false);
    expect(t.service.needsProbe(t.source('a'), Date.now(), 'foreground')).toBe(true);
    t.outcomes.set('a', () => ok());
    const selection = await t.service.prepareForPlayback('g1', STATION);
    expect(selection.selected?.id).toBe('a');
    expect(t.source('a')).toMatchObject({ cooldownUntil: null, verificationState: 'eligible' });
  });

  it('keeps an earlier measurement when a check is too short to measure', async () => {
    const t = setup([{ id: 'a', patch: verified({ codec: 'aac', measuredBitrateKbps: 128.1 }) }]);
    t.outcomes.set('a', () =>
      ok({
        codec: 'aac',
        measuredBitrateKbps: null,
        codecBitrateKbps: 113.7,
        bitrateEvidence: 'codec-metadata',
      }),
    );
    await t.service.probe('a');
    expect(t.source('a')).toMatchObject({
      measuredBitrateKbps: 128.1,
      codecBitrateKbps: 113.7,
      bitrateConfidence: 'measured',
    });
    // A different codec is a different stream: the old figure no longer applies.
    t.outcomes.set('a', () =>
      ok({
        codec: 'mp3',
        measuredBitrateKbps: null,
        codecBitrateKbps: 192,
        bitrateEvidence: 'codec-metadata',
      }),
    );
    await t.service.probe('a');
    expect(t.source('a').measuredBitrateKbps).toBeNull();
  });

  it('never re-checks the source that is playing in the background', () => {
    const old = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    const t = setup([
      { id: 'a', patch: verified({ lastProbeAt: old }) },
      { id: 'b', patch: verified({ lastProbeAt: old }) },
    ]);
    const queued: string[][] = [];
    t.service.refreshInBackground = (ids: string[]) => void queued.push(ids);
    t.service.refreshStation(STATION, 'a');
    expect(queued).toEqual([['b']]);
  });

  it('checks a source that failed in playback again a few minutes later, so the bot can move back to it', () => {
    const t = setup([{ id: 'a', patch: verified() }]);
    const failedAt = Date.now() + 1_000;
    t.stations.recordFailure('a', 'STREAM_EOF', new Date(failedAt).toISOString());
    expect(t.service.needsProbe(t.source('a'), failedAt + 60_000)).toBe(false);
    expect(t.service.needsProbe(t.source('a'), failedAt + 6 * 60_000)).toBe(true);
    // A failed check marks it offline, which keeps its own, longer back-off.
    t.stations.applyProbePatch('a', { verificationState: 'offline' });
    expect(t.service.needsProbe(t.source('a'), failedAt + 6 * 60_000)).toBe(false);
  });
});
