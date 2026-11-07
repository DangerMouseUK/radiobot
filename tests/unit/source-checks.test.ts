import { spawn } from 'node:child_process';
import { constants, getPriority } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

// The background queue waits with `node:timers/promises`, which Vitest's fake timers don't reach.
// The same wait on the global timers behaves the same (abort included) and lets tests fake the clock.
vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  const setTimeoutPromise = <T>(
    ms?: number,
    value?: T,
    options: { signal?: AbortSignal; ref?: boolean } = {},
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const { signal, ref = true } = options;
      const abortError = () => Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value as T);
      }, ms);
      if (!ref) timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  return { ...actual, setTimeout: setTimeoutPromise };
});

import { lowerPriority, ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import type { StationSource } from '../../src/catalogue/types.ts';
import { failingLine, pausedLine } from '../../src/discord/ui/format.ts';
import { Metrics } from '../../src/observability/metrics.ts';
import type { SourceProbePatch } from '../../src/persistence/repositories/stations.ts';
import { emptyOutcome, type probeSource } from '../../src/streams/probe.ts';
import { SafeHttpClient, statusError } from '../../src/streams/safe-fetch.ts';
import {
  FAILED_RETRY_STEPS_MS,
  isPaused,
  nextAutomaticCheck,
  type ProbeReport,
  SourceService,
  type SourceServiceDeps,
} from '../../src/streams/source-service.ts';
import { UrlPolicy } from '../../src/streams/url-policy.ts';
import { makeSource, memoryDb, silentLogger } from '../helpers.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-11-01T12:00:00Z');
const failing = (failures: number, code = 'HTTP_TIMEOUT') =>
  makeSource({
    verificationState: 'offline',
    lastProbeAt: new Date(T0).toISOString(),
    lastFailureAt: new Date(T0).toISOString(),
    consecutiveFailures: failures,
    lastFailureCode: code,
  });

describe('failed sources back off', () => {
  it('waits about 10 min, 1 h, 6 h, 12 h, then a day between automatic checks', () => {
    expect(FAILED_RETRY_STEPS_MS).toEqual([10 * MIN, HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR]);
    const waits = [1, 2, 3, 4, 5, 9].map((n) => nextAutomaticCheck(failing(n))! - T0);
    expect(waits).toEqual([10 * MIN, HOUR, 6 * HOUR, 12 * HOUR, 24 * HOUR, 24 * HOUR]);
  });

  it('treats a gone address (HTTP 404/410) as long-term from the first failure', () => {
    expect(nextAutomaticCheck(failing(1, 'NOT_FOUND'))! - T0).toBe(12 * HOUR);
    expect(nextAutomaticCheck(failing(5, 'NOT_FOUND'))! - T0).toBe(24 * HOUR);
  });

  it('only applies to failing sources', () => {
    expect(nextAutomaticCheck(makeSource({ verificationState: 'eligible' }))).toBeNull();
    expect(nextAutomaticCheck(makeSource({ verificationState: 'offline', lastProbeAt: null }))).toBeNull();
  });

  it('reports 404 and 410 as NOT_FOUND, other errors as before', () => {
    expect(statusError(404).code).toBe('NOT_FOUND');
    expect(statusError(410).code).toBe('NOT_FOUND');
    expect(statusError(403).code).toBe('ACCESS_DENIED');
    expect(statusError(500).code).toBe('HTTP_STATUS');
  });

  it('describes a failing source in plain words', () => {
    const s = failing(5, 'NOT_FOUND');
    const line = failingLine(s, Date.now() + 22 * HOUR);
    expect(line).toMatch(/^Not working: 5 failed checks in a row, the last one <t:\d+:R> \(NOT_FOUND\)\. /);
    expect(line).toMatch(/Next automatic check: <t:\d+:R>\.$/);
    expect(failingLine(failing(1), Date.now() - 1)).toMatch(
      /1 failed check in a row.*Next automatic check: next time the station plays\.$/,
    );
  });
});

const svcDeps = (repos: ReturnType<typeof memoryDb>, extra: Partial<SourceServiceDeps> = {}) => ({
  stations: repos.stations,
  guilds: repos.guilds,
  client: new SafeHttpClient(new UrlPolicy({ allowInsecureHttp: true })),
  registry: new ProcessRegistry(),
  ffmpegPath: 'ffmpeg',
  ffprobePath: 'ffprobe',
  maxConcurrentProbes: 4,
  logger: silentLogger(),
  metrics: new Metrics(),
  ...extra,
});

/**
 * A real SourceService over a seeded database, with the network check replaced: each check takes
 * `slowMs` (unless interrupted), fails with a timeout, and is logged with its timing.
 */
function harness(
  sources: Array<{ id: string; host: string; patch?: SourceProbePatch }>,
  slowMs = 60,
  extra: Partial<SourceServiceDeps> = {},
) {
  const repos = memoryDb();
  repos.stations.upsertProviderStation({
    id: 'mypack:my-station',
    provider: 'mypack',
    slug: 'my-station',
    externalId: null,
    displayName: 'My Station',
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
      stationId: 'mypack:my-station',
      url: `https://${s.host}/${s.id}`,
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
  const log: Array<{ id: string; start: number; end: number; interrupted: boolean }> = [];
  let active = 0;
  let peak = 0;
  const probeImpl: typeof probeSource = async (_deps, url, _budget, signal) => {
    const id = url.split('/').pop()!;
    const start = Date.now();
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, slowMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(t);
        resolve();
      });
    });
    active--;
    const interrupted = Boolean(signal?.aborted);
    log.push({ id, start, end: Date.now(), interrupted });
    return { ...emptyOutcome(start), failureCode: interrupted ? 'CANCELLED' : 'HTTP_TIMEOUT' };
  };
  const service = new SourceService(svcDeps(repos, { probeImpl, ...extra }));
  return { repos, service, log, peak: () => peak, source: (id: string) => repos.stations.getSource(id)! };
}

const until = async (cond: () => boolean, ms = 2_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('background checks stay out of the way', () => {
  it('runs background checks one at a time, even when more are allowed', async () => {
    const t = harness(['a', 'b', 'c', 'd'].map((id) => ({ id, host: `${id}.example.net` })));
    t.service.refreshInBackground(['a', 'b', 'c', 'd']);
    await until(() => t.log.length === 4);
    expect(t.log.map((x) => x.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(t.peak()).toBe(1);
  });

  it('queues a source once however often it is asked for, and skips it if a check already ran', async () => {
    const t = harness(['a', 'b'].map((id) => ({ id, host: `${id}.example.net` })));
    // Two servers on the same station, a failover and a reconnect, all asking at once.
    t.service.refreshInBackground(['a', 'b']);
    t.service.refreshInBackground(['a', 'b']);
    t.service.refreshInBackground(['b']);
    await until(() => t.log.length === 2);
    await new Promise((r) => setTimeout(r, 150));
    expect(t.log.map((x) => x.id)).toEqual(['a', 'b']);
    // Checked a moment ago (and now backing off): asking again finds nothing due.
    t.service.refreshInBackground(['a']);
    await new Promise((r) => setTimeout(r, 100));
    expect(t.log).toHaveLength(2);
  });

  it('keeps a single queue entry per source, so repeated requests cost nothing', async () => {
    const t = harness([{ id: 'a', host: 'a.example.net' }]);
    t.service.holdBackground(100);
    const reads = vi.spyOn(t.repos.stations, 'getSource');
    for (let i = 0; i < 100; i++) t.service.refreshInBackground(['a']);
    await until(() => t.log.length === 1);
    // One turn for the hundred requests: the check reads the source a handful of times, not 100.
    expect(reads.mock.calls.length).toBeLessThan(10);
  });

  it('skips a queued source whose station was disabled or which was deleted meanwhile', async () => {
    const t = harness([
      { id: 'a', host: 'a.example.net' },
      { id: 'b', host: 'b.example.net' },
    ]);
    t.service.holdBackground(50);
    t.service.refreshInBackground(['a', 'b']);
    t.repos.stations.deleteSource('a');
    t.repos.stations.setSourceEnabled('b', false, 'gone');
    await new Promise((r) => setTimeout(r, 150));
    expect(t.log).toEqual([]);
  });

  it('runs other background work (a scheduled sync) in the same queue, and not while a stream starts', async () => {
    const t = harness([{ id: 'a', host: 'a.example.net' }]);
    const held = Date.now();
    t.service.holdBackground(150);
    t.service.refreshInBackground(['a']);
    let ranAt = 0;
    let checksRunning = -1;
    const result = await t.service.runInBackground(async () => {
      ranAt = Date.now();
      checksRunning = t.service.activeProbes;
      return 'synced';
    });
    expect(result).toBe('synced');
    // After the hold, and after the check queued before it had finished: never alongside it.
    expect(ranAt - held).toBeGreaterThanOrEqual(140);
    expect(t.log).toHaveLength(1);
    expect(ranAt).toBeGreaterThanOrEqual(t.log[0]!.end);
    expect(checksRunning).toBe(0);
  });

  it('never lets a shorter hold cut a longer one short', async () => {
    const t = harness([{ id: 'a', host: 'a.example.net' }]);
    const held = Date.now();
    t.service.holdBackground(150);
    t.service.holdBackground(10);
    t.service.refreshInBackground(['a']);
    await until(() => t.log.length === 1);
    expect(t.log[0]!.start - held).toBeGreaterThanOrEqual(140);
  });

  it("writes a check's results in one transaction, and keeps PROBE_HISTORY_LIMIT results", async () => {
    const t = harness([{ id: 'a', host: 'a.example.net' }], 1, { probeHistoryLimit: 5 });
    for (let i = 0; i < 8; i++) await t.service.probe('a');
    expect(t.repos.stations.listProbeResults('a', 100)).toHaveLength(5);
    // If writing the history row fails, the source's new state is not saved either.
    const before = t.source('a').lastProbeAt;
    const insert = vi.spyOn(t.repos.stations, 'insertProbeResult').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(t.service.probe('a')).rejects.toThrow('disk full');
    insert.mockRestore();
    expect(t.source('a').lastProbeAt).toBe(before);
  });

  it('holds background checks while a stream is starting', async () => {
    const t = harness([{ id: 'a', host: 'a.example.net' }]);
    const held = Date.now();
    t.service.holdBackground(150);
    t.service.refreshInBackground(['a']);
    await until(() => t.log.length === 1);
    expect(t.log[0]!.start - held).toBeGreaterThanOrEqual(140);
  });

  it('lets a play interrupt a background check on the same host, and records nothing for it', async () => {
    const t = harness(
      [
        { id: 'bg', host: 'shared.example.net' },
        { id: 'wanted', host: 'shared.example.net' },
      ],
      300,
    );
    t.service.refreshInBackground(['bg']);
    await until(() => t.source('bg') !== null && t.peak() === 1);
    const asked = Date.now();
    await t.service.probe('wanted');
    // The play's check started at once instead of queuing ~300 ms behind the background one.
    expect(t.log.find((x) => x.id === 'wanted')!.start - asked).toBeLessThan(200); // well under the background check's 300 ms
    expect(t.log.find((x) => x.id === 'bg')?.interrupted).toBe(true);
    // The interrupted check is not a failure: the source is exactly as it was.
    expect(t.source('bg').lastProbeAt).toBeNull();
    expect(t.source('bg').consecutiveFailures).toBe(0);
    expect(t.source('wanted').lastFailureCode).toBe('HTTP_TIMEOUT');
  });

  it('never interrupts a background check that a play has joined', async () => {
    const t = harness(
      [
        { id: 'joined', host: 'shared.example.net' },
        { id: 'other', host: 'shared.example.net' },
      ],
      120,
    );
    t.service.refreshInBackground(['joined']);
    await until(() => t.peak() === 1);
    const first = t.service.probe('joined'); // a play now waits for this very check
    const second = t.service.probe('other');
    await Promise.all([first, second]);
    expect(t.log.find((x) => x.id === 'joined')?.interrupted).toBe(false);
    expect(t.source('joined').lastFailureCode).toBe('HTTP_TIMEOUT');
  });

  it('lets a stream that starts interrupt background checks nobody waits for, unrecorded', async () => {
    const t = harness([{ id: 'bg', host: 'a.example.net' }], 300);
    t.service.refreshInBackground(['bg']);
    await until(() => t.peak() === 1);
    t.service.holdBackground(10);
    await until(() => t.log.length === 1);
    expect(t.log[0]!.interrupted).toBe(true);
    expect(t.source('bg').lastProbeAt).toBeNull();
    expect(t.repos.stations.listProbeResults('bg', 10)).toEqual([]);
  });

  it('never interrupts a background check a play has joined when a stream starts', async () => {
    const t = harness([{ id: 'joined', host: 'a.example.net' }], 120);
    t.service.refreshInBackground(['joined']);
    await until(() => t.peak() === 1);
    const play = t.service.probe('joined');
    t.service.holdBackground(10);
    const report = await play;
    expect(report.outcome.failureCode).toBe('HTTP_TIMEOUT');
    expect(t.log.map((x) => x.interrupted)).toEqual([false]);
  });

  it('starts a new check for a play rather than sharing one a stream start interrupted', async () => {
    const t = harness([{ id: 'x', host: 'a.example.net' }], 100);
    t.service.refreshInBackground(['x']);
    await until(() => t.peak() === 1);
    // The session holds background work, then checks the station it is starting.
    t.service.holdBackground(10);
    const report = await t.service.probe('x');
    expect(report.outcome.failureCode).toBe('HTTP_TIMEOUT');
    expect(t.log.map((x) => x.interrupted)).toEqual([true, false]);
    expect(t.repos.stations.listProbeResults('x', 10)).toHaveLength(1);
  });

  it('waits out the settle period for automatic work only', async () => {
    // A fake clock: on a busy CI machine the real one made this test's timings unreliable.
    vi.useFakeTimers();
    try {
      const t = harness([{ id: 'a', host: 'a.example.net' }], 1);
      const t0 = Date.now();
      t.service.settleBackground(200);
      t.service.settleBackground(10); // a shorter one never cuts it short
      t.service.refreshInBackground(['a']);
      let userAt = -1;
      const user = t.service.runInBackground(async () => {
        userAt = Date.now();
      });
      await vi.advanceTimersByTimeAsync(0);
      await user;
      // Work a user asked for (an install, say) goes at once, ahead of the waiting check.
      expect(userAt).toBe(t0);
      expect(t.log).toEqual([]);
      let autoAt = -1;
      let checksBeforeAuto = -1;
      const auto = t.service.runInBackground(
        async () => {
          autoAt = Date.now();
          checksBeforeAuto = t.log.length;
        },
        { automatic: true },
      );
      await vi.advanceTimersByTimeAsync(199);
      expect(autoAt).toBe(-1);
      expect(t.log).toEqual([]);
      await vi.advanceTimersByTimeAsync(10);
      await auto;
      expect(autoAt - t0).toBeGreaterThanOrEqual(200);
      // The check that was queued first ran first.
      expect(checksBeforeAuto).toBe(1);
      expect(t.log[0]!.start - t0).toBeGreaterThanOrEqual(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps automatic work in order when the settle timer fires a moment early by the clock', async () => {
    // Timers are faked but the clock isn't: when the settle timer fires, the wall clock still says
    // the deadline is ahead, as it can by a millisecond on a busy host. The first in line used to
    // give its turn up then, and wait again, while the next went ahead.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const t = harness([{ id: 'a', host: 'a.example.net' }], 1);
      t.service.settleBackground(60_000);
      t.service.refreshInBackground(['a']);
      let checksBeforeAuto = -1;
      const auto = t.service.runInBackground(
        async () => {
          checksBeforeAuto = t.log.length;
        },
        { automatic: true },
      );
      await vi.advanceTimersByTimeAsync(60_000); // the settle timer fires; the clock barely moved
      await vi.advanceTimersByTimeAsync(10); // the check's own 1 ms probe
      expect(checksBeforeAuto).toBe(1);
      await auto;
      // A later stream start still makes automatic work wait again.
      t.service.settleBackground(60_000);
      let ran = false;
      const later = t.service.runInBackground(
        async () => {
          ran = true;
        },
        { automatic: true },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(ran).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      await later;
      expect(ran).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets user work go first when a stream starts while automatic work waits for its turn', async () => {
    const t = harness([{ id: 'a', host: 'a.example.net' }], 1);
    const t0 = Date.now();
    t.service.holdBackground(60);
    t.service.refreshInBackground(['a']); // takes its turn, then waits for the hold
    t.service.settleBackground(250); // the stream has its first audio
    let userAt = 0;
    await t.service.runInBackground(async () => {
      userAt = Date.now();
    });
    expect(userAt - t0).toBeGreaterThanOrEqual(50);
    expect(userAt - t0).toBeLessThan(200);
    expect(t.log).toEqual([]);
    await until(() => t.log.length === 1);
    expect(t.log[0]!.start - t0).toBeGreaterThanOrEqual(240);
  });

  it('stops waiting for the settle period when a full check is stopped', async () => {
    const t = harness([{ id: 'a', host: 'a.example.net' }], 1);
    t.service.settleBackground(10_000);
    const stop = new AbortController();
    const check = t.service.checkInBackground('a', stop.signal, () => true);
    setTimeout(() => stop.abort(), 10);
    await expect(check).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(t.log).toEqual([]);
  });

  it('queues a full-check item again when a stream start interrupts it', async () => {
    const t = harness([{ id: 'x', host: 'a.example.net' }], 100);
    const stop = new AbortController();
    const check = t.service.checkInBackground('x', stop.signal, () => true);
    await until(() => t.peak() === 1);
    t.service.holdBackground(20);
    const r = await check;
    expect(r?.report.outcome.failureCode).toBe('HTTP_TIMEOUT');
    expect(t.log.map((x) => x.interrupted)).toEqual([true, false]);
    expect(t.log[1]!.start - t.log[0]!.end).toBeGreaterThanOrEqual(10);
  });

  it('stopping a full check never cancels a play that joined the same check (it gets the result)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const started: string[] = [];
    const probeImpl: typeof probeSource = async (_deps, url, _budget, signal) => {
      started.push(url);
      await new Promise<void>((resolve) => {
        void gate.then(resolve);
        signal?.addEventListener('abort', () => resolve());
      });
      return { ...emptyOutcome(Date.now()), failureCode: signal?.aborted ? 'CANCELLED' : 'HTTP_TIMEOUT' };
    };
    const t = harness([{ id: 'x', host: 'a.example.net' }], 0, { probeImpl });
    const stop = new AbortController();
    const check = t.service.checkInBackground('x', stop.signal, () => true);
    await until(() => started.length === 1);
    const play = t.service.probe('x');
    stop.abort();
    // The full check stops waiting at once, before the check itself has finished…
    await expect(check).rejects.toMatchObject({ code: 'CANCELLED' });
    release();
    // …and the play still gets the check's result, recorded once.
    const report = await play;
    expect(report.outcome.failureCode).toBe('HTTP_TIMEOUT');
    expect(started).toHaveLength(1);
    expect(t.repos.stations.listProbeResults('x', 10)).toHaveLength(1);
  });

  it('interrupts a full-check item nobody else waits for when the check is stopped', async () => {
    const t = harness([{ id: 'x', host: 'a.example.net' }], 300);
    const stop = new AbortController();
    const check = t.service.checkInBackground('x', stop.signal, () => true);
    await until(() => t.peak() === 1);
    stop.abort();
    await expect(check).rejects.toMatchObject({ code: 'CANCELLED' });
    await until(() => t.log.length === 1);
    expect(t.log[0]!.interrupted).toBe(true);
    expect(t.repos.stations.listProbeResults('x', 10)).toEqual([]);
  });

  it('respects the back-off when deciding what is due in the background', () => {
    const t = harness([]);
    expect(t.service.needsProbe(failing(1), T0 + 9 * MIN)).toBe(false);
    expect(t.service.needsProbe(failing(1), T0 + 11 * MIN)).toBe(true);
    expect(t.service.needsProbe(failing(5), T0 + 23 * HOUR)).toBe(false);
    expect(t.service.needsProbe(makeSource({ lastProbeAt: null }), T0)).toBe(true);
  });

  it('reports progress while an admin re-checks a station', async () => {
    const repos = memoryDb();
    const progress: Array<[number, number]> = [];
    class Instant extends SourceService {
      override async probe(): Promise<ProbeReport> {
        return {} as ProbeReport;
      }
      override sourcesFor(): StationSource[] {
        return [makeSource({ id: 'x1' }), makeSource({ id: 'x2' }), makeSource({ id: 'x3', enabled: false })];
      }
    }
    const service = new Instant(svcDeps(repos));
    const reports = await service.rescanStation('mypack:my-station', undefined, (d, n) =>
      progress.push([d, n]),
    );
    expect(reports).toHaveLength(2);
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });
});

describe('dead sources stop being checked', () => {
  const DAY = 24 * HOUR;
  const src = (o: { failures: number; lastSuccessDaysAgo?: number; addedDaysAgo: number; code?: string }) =>
    makeSource({
      verificationState: 'offline',
      consecutiveFailures: o.failures,
      lastFailureCode: o.code ?? 'HTTP_TIMEOUT',
      lastProbeAt: new Date(T0 - 30 * MIN).toISOString(),
      lastSuccessAt:
        o.lastSuccessDaysAgo === undefined ? null : new Date(T0 - o.lastSuccessDaysAgo * DAY).toISOString(),
      createdAt: new Date(T0 - o.addedDaysAgo * DAY).toISOString(),
    });

  it('pauses a source only after a week with no success and at least 5 failures in a row', () => {
    expect(isPaused(src({ failures: 6, lastSuccessDaysAgo: 8, addedDaysAgo: 30 }), T0)).toBe(true);
    expect(isPaused(src({ failures: 9, addedDaysAgo: 8 }), T0)).toBe(true); // never worked since added
    // A temporary outage never pauses, however many checks failed during it.
    expect(isPaused(src({ failures: 200, lastSuccessDaysAgo: 2, addedDaysAgo: 30 }), T0)).toBe(false);
    // Thin evidence never pauses, however long ago it last worked.
    expect(isPaused(src({ failures: 3, lastSuccessDaysAgo: 20, addedDaysAgo: 30 }), T0)).toBe(false);
    expect(isPaused(makeSource({ verificationState: 'eligible', consecutiveFailures: 9 }), T0)).toBe(false);
  });

  it('never checks a paused source automatically, in the background or for a play', () => {
    const t = harness([]);
    const paused = src({ failures: 9, lastSuccessDaysAgo: 10, addedDaysAgo: 30 });
    for (const later of [HOUR, DAY, 30 * DAY]) {
      expect(t.service.needsProbe(paused, T0 + later, 'background')).toBe(false);
      expect(t.service.needsProbe(paused, T0 + later, 'foreground')).toBe(false);
    }
  });

  it('retries failing sources for a play every 10 min, hourly after a day, despite the back-off', () => {
    const t = harness([]);
    const fresh = src({ failures: 2, lastSuccessDaysAgo: 0.1, addedDaysAgo: 30, code: 'NOT_FOUND' });
    // The background back-off would wait 12 h after a 404, but a play with nothing else retries sooner.
    expect(t.service.needsProbe(fresh, T0, 'background')).toBe(false);
    expect(t.service.needsProbe(fresh, T0, 'foreground')).toBe(true); // checked 30 min ago
    expect(t.service.needsProbe(fresh, T0 - 25 * MIN, 'foreground')).toBe(false); // only 5 min ago
    const older = src({ failures: 4, lastSuccessDaysAgo: 2, addedDaysAgo: 30 });
    expect(t.service.needsProbe(older, T0, 'foreground')).toBe(false); // 30 min < 1 h
    expect(t.service.needsProbe(older, T0 + 31 * MIN, 'foreground')).toBe(true);
  });

  it('a play skips paused sources and checks the failing ones that are due', async () => {
    const day = (n: number) => new Date(Date.now() - n * 24 * HOUR).toISOString();
    const offline = (o: SourceProbePatch): SourceProbePatch => ({
      verificationState: 'offline',
      lastProbeAt: new Date(Date.now() - 30 * MIN).toISOString(),
      ...o,
    });
    const t = harness([
      { id: 'dead', host: 'a.example.net' },
      { id: 'blip', host: 'b.example.net' },
    ]);
    // 'dead' last worked 9 days ago and has failed 6 times since; 'blip' worked about an hour ago.
    t.repos.stations.recordSuccess('dead', day(9));
    t.repos.stations.recordSuccess('blip', day(0.05));
    for (let i = 0; i < 6; i++) t.repos.stations.recordFailure('dead', 'NOT_FOUND');
    t.repos.stations.recordFailure('blip', 'NOT_FOUND');
    for (const id of ['dead', 'blip']) t.repos.stations.applyProbePatch(id, offline({}));
    await t.service.prepareForPlayback('123456789012345678', 'mypack:my-station');
    expect(t.log.map((x) => x.id)).toEqual(['blip']);
  });

  it('says plainly when a source is paused', () => {
    const line = pausedLine(
      src({ failures: 9, lastSuccessDaysAgo: 10, addedDaysAgo: 30, code: 'NOT_FOUND' }),
    );
    expect(line).toBe(
      'Paused: no successful check for over a week (9 failed in a row, last NOT_FOUND). It is no longer checked automatically; an admin can test it with **Check sources again**.',
    );
  });
});

describe('check processes yield the CPU', () => {
  it('gives a background process the lowest priority', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']);
    try {
      await new Promise((r) => child.once('spawn', r));
      lowerPriority(child);
      expect(getPriority(child.pid!)).toBe(constants.priority.PRIORITY_LOW);
    } finally {
      child.kill();
    }
  });
});
