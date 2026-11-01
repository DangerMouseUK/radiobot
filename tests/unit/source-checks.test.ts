import { spawn } from 'node:child_process';
import { constants, getPriority } from 'node:os';
import { describe, expect, it } from 'vitest';
import { lowerPriority, ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import type { StationSource } from '../../src/catalogue/types.ts';
import { failingLine } from '../../src/discord/ui/format.ts';
import { Metrics } from '../../src/observability/metrics.ts';
import { SafeHttpClient, statusError } from '../../src/streams/safe-fetch.ts';
import {
  FAILED_RETRY_STEPS_MS,
  nextAutomaticCheck,
  type ProbeReport,
  SourceService,
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

/** A SourceService whose network check is replaced, so scheduling can be observed offline. */
function harness() {
  const repos = memoryDb();
  let active = 0;
  let peak = 0;
  const probed: string[] = [];
  class Observed extends SourceService {
    override async probe(sourceId: string): Promise<ProbeReport> {
      active++;
      peak = Math.max(peak, active);
      probed.push(sourceId);
      await new Promise((r) => setTimeout(r, 15));
      active--;
      return {} as ProbeReport;
    }
  }
  const service = new Observed({
    stations: repos.stations,
    guilds: repos.guilds,
    client: new SafeHttpClient(new UrlPolicy({ allowInsecureHttp: true })),
    registry: new ProcessRegistry(),
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    maxConcurrentProbes: 4,
    logger: silentLogger(),
    metrics: new Metrics(),
  });
  return { service, probed, peak: () => peak };
}

describe('background checks stay out of the way', () => {
  it('runs background checks one at a time, even when more are allowed', async () => {
    const t = harness();
    t.service.refreshInBackground(['a', 'b', 'c', 'd']);
    await new Promise((r) => setTimeout(r, 120));
    expect(t.probed).toEqual(['a', 'b', 'c', 'd']);
    expect(t.peak()).toBe(1);
  });

  it('respects the back-off when deciding what is due', () => {
    const t = harness();
    const realNow = Date.now();
    const due = (s: StationSource, at: number) => t.service.needsProbe(s, at);
    expect(due(failing(1), T0 + 9 * MIN)).toBe(false);
    expect(due(failing(1), T0 + 11 * MIN)).toBe(true);
    expect(due(failing(5), T0 + 23 * HOUR)).toBe(false);
    expect(due(failing(5), T0 + 25 * HOUR)).toBe(true);
    expect(due(makeSource({ lastProbeAt: null }), realNow)).toBe(true);
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
    const service = new Instant({
      stations: repos.stations,
      guilds: repos.guilds,
      client: new SafeHttpClient(new UrlPolicy({ allowInsecureHttp: true })),
      registry: new ProcessRegistry(),
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      maxConcurrentProbes: 2,
      logger: silentLogger(),
      metrics: new Metrics(),
    });
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
