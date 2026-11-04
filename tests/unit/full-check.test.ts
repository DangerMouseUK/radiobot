import { describe, expect, it } from 'vitest';
import { ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import { seedPacks } from '../../src/catalogue/packs.ts';
import { Metrics } from '../../src/observability/metrics.ts';
import { type FullCheckState, FullSourceCheck } from '../../src/streams/full-check.ts';
import { emptyOutcome, type ProbeOutcome, type probeSource } from '../../src/streams/probe.ts';
import { SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import { isPaused, SourceService } from '../../src/streams/source-service.ts';
import { UrlPolicy } from '../../src/streams/url-policy.ts';
import { demoRegistry, memoryDb, silentLogger } from '../helpers.ts';

/**
 * "Check all sources again" over the made-up demo pack, with the network check replaced: what it
 * checks, what it leaves out, and how it stays behind playback. No network, Discord or stations.
 */
const DAY = 24 * 3_600_000;

const ok = (): ProbeOutcome => ({
  ...emptyOutcome(Date.now()),
  success: true,
  transport: 'http-continuous',
  effectiveHost: 'stream.example.org',
  container: 'mp3',
  codec: 'mp3',
  sampleRateHz: 44_100,
  channels: 2,
  channelLayout: 'stereo',
  advertisedBitrateKbps: 128,
  measuredBitrateKbps: 128,
  bitrateEvidence: 'measured',
  startupMs: 300,
});

interface Options {
  /** How each check ends: by default it passes at once. */
  check?: (id: string, signal: AbortSignal | undefined) => Promise<ProbeOutcome>;
  playing?: Set<string>;
  disabledSourceIds?: Set<string>;
}

function harness(opts: Options = {}) {
  const repos = memoryDb();
  const packs = demoRegistry();
  seedPacks(repos.stations, packs);
  // A custom station of one server, with a source of its own: never part of the full check.
  repos.stations.insertCustomStation({
    id: 'custom:my-own',
    guildId: '123456789012345678',
    slug: 'my-own',
    displayName: 'My Own',
    description: null,
    category: null,
    websiteUrl: null,
    language: null,
    createdById: '900000000000000001',
  });
  repos.stations.insertSource({
    id: 'custom-my-own-1',
    stationId: 'custom:my-own',
    url: 'https://radio.example.org/my-own',
    label: null,
    priority: 10,
    transportHint: 'http-continuous',
    codecHint: 'mp3',
    provenance: 'curated',
    provenanceDetail: null,
    rightsStatus: 'unreviewed',
  });
  const checked: string[] = [];
  let active = 0;
  let peak = 0;
  const probeImpl: typeof probeSource = async (_deps, url, _budget, signal) => {
    const id = repos.stations.listAllSources().find((s) => s.url === url)!.id;
    checked.push(id);
    active++;
    peak = Math.max(peak, active);
    try {
      return await (opts.check?.(id, signal) ?? Promise.resolve(ok()));
    } finally {
      active--;
    }
  };
  const service = new SourceService({
    stations: repos.stations,
    guilds: repos.guilds,
    client: new SafeHttpClient(new UrlPolicy({ allowInsecureHttp: true })),
    registry: new ProcessRegistry(),
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    maxConcurrentProbes: 4,
    logger: silentLogger(),
    metrics: new Metrics(),
    probeImpl,
    disabledSourceIds: opts.disabledSourceIds,
  });
  const full = new FullSourceCheck({
    stations: repos.stations,
    sources: service,
    packEnabled: (p) => packs.isEnabled(p),
    playing: (id) => opts.playing?.has(id) ?? false,
    logger: silentLogger(),
  });
  const progress: FullCheckState[] = [];
  const finished = () =>
    new Promise<FullCheckState>((resolve) => {
      const started = full.start((s) => {
        progress.push(s);
        if (s.status !== 'running') resolve(s);
      });
      if (!started) throw new Error('already running');
    });
  /** Every enabled demo source, as the pack ships it. */
  const enabled = () =>
    repos.stations
      .listAllSources()
      .filter((s) => s.stationId.startsWith('demo:') && s.enabled)
      .map((s) => s.id);
  return {
    repos,
    service,
    full,
    checked,
    progress,
    finished,
    enabled,
    peak: () => peak,
    source: (id: string) => repos.stations.getSource(id)!,
  };
}

/** A source that has failed for 8 days, 6 times in a row: paused, never checked automatically. */
function pause(t: ReturnType<typeof harness>, id: string): void {
  t.repos.stations.recordSuccess(id, new Date(Date.now() - 8 * DAY).toISOString());
  for (let n = 0; n < 6; n++) t.repos.stations.recordFailure(id, 'HTTP_TIMEOUT');
  t.repos.stations.applyProbePatch(id, {
    verificationState: 'offline',
    lastProbeAt: new Date().toISOString(),
  });
}

const until = async (cond: () => boolean, ms = 2_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('Check all sources again', () => {
  it('checks every enabled pack source, including paused and held ones, and they work at once', async () => {
    const t = harness();
    const [paused, held] = t.enabled();
    pause(t, paused!);
    t.repos.stations.setCooldown(held!, new Date(Date.now() + DAY).toISOString());
    // Neither would be checked by anything automatic.
    expect(isPaused(t.source(paused!))).toBe(true);
    expect(t.service.needsProbe(t.source(paused!), Date.now(), 'foreground')).toBe(false);
    expect(t.source(held!).verificationState).toBe('cooldown');

    const end = await t.finished();
    expect([...t.checked].sort()).toEqual([...t.enabled()].sort());
    expect(t.checked).not.toContain('custom-my-own-1');
    // The demo pack ships one source switched off: the curators' decision, so it is left alone.
    const shippedOff = t.repos.stations
      .listAllSources()
      .filter((s) => s.stationId.startsWith('demo:') && !s.enabled);
    expect(shippedOff).toHaveLength(1);
    expect(t.checked).not.toContain(shippedOff[0]!.id);

    expect(end).toMatchObject({ status: 'finished', total: t.enabled().length, done: t.enabled().length });
    expect(end.usable).toBe(t.enabled().length);
    expect(end.newlyUsable).toBe(t.enabled().length);
    expect(end.failed).toBe(0);
    for (const id of [paused!, held!]) {
      const s = t.source(id);
      expect(s.verificationState).toBe('eligible');
      expect(s.consecutiveFailures).toBe(0);
      expect(s.cooldownUntil).toBeNull();
      expect(isPaused(s)).toBe(false);
    }
    // Progress after each source, and once more at the end.
    expect(t.progress.filter((p) => p.status === 'running').at(-1)!.done).toBe(t.enabled().length);
    expect(t.full.state).toMatchObject({ status: 'finished' });
    expect(t.full.running).toBe(false);
  });

  it('keeps the back-off and pause of a source that still fails', async () => {
    const t = harness({
      check: async () => ({ ...emptyOutcome(Date.now()), failureCode: 'NOT_FOUND' }),
    });
    const [paused] = t.enabled();
    pause(t, paused!);
    const before = t.source(paused!).consecutiveFailures;
    const end = await t.finished();
    expect(end.failed).toBe(t.enabled().length);
    expect(end.usable).toBe(0);
    const s = t.source(paused!);
    expect(s.consecutiveFailures).toBe(before + 1);
    expect(s.lastFailureCode).toBe('NOT_FOUND');
    expect(isPaused(s)).toBe(true);
  });

  it('runs one check at a time and leaves out the bot owner’s switched-off and playing sources', async () => {
    const t = harness({
      disabledSourceIds: new Set(['demo-radio-mp3']),
      playing: new Set(['demo-radio-aac']),
    });
    const end = await t.finished();
    expect(t.peak()).toBe(1);
    expect(t.checked).not.toContain('demo-radio-mp3');
    expect(t.checked).not.toContain('demo-radio-aac');
    expect(end.total).toBe(t.enabled().length - 1);
    expect(end.playing).toBe(1);
    expect(end.done).toBe(end.total);
  });

  it('waits while a stream is starting', async () => {
    const t = harness();
    t.service.holdBackground(150);
    const startedAt = Date.now();
    let firstAt = 0;
    const done = t.finished();
    await until(() => t.checked.length > 0);
    firstAt = Date.now();
    await done;
    expect(firstAt - startedAt).toBeGreaterThanOrEqual(140);
  });

  it('lets only one run at a time', async () => {
    let release = () => {};
    const t = harness({ check: () => new Promise((r) => (release = () => r(ok()))) });
    const done = t.finished();
    await until(() => t.checked.length === 1);
    expect(t.full.running).toBe(true);
    expect(t.full.start()).toBeNull();
    // Release each check as it comes, so the run ends.
    const timer = setInterval(() => release(), 1);
    await done;
    clearInterval(timer);
    expect(t.checked).toHaveLength(t.enabled().length);
  });

  it('stops cleanly, recording nothing for the check it interrupted', async () => {
    const t = harness({
      check: (_id, signal) =>
        new Promise((resolve) =>
          signal?.addEventListener('abort', () =>
            resolve({ ...emptyOutcome(Date.now()), failureCode: 'CANCELLED' }),
          ),
        ),
    });
    const done = t.finished();
    await until(() => t.checked.length === 1);
    const first = t.checked[0]!;
    await t.full.stop();
    const end = await done;
    expect(end).toMatchObject({ status: 'stopped', done: 0, total: t.enabled().length });
    expect(t.full.running).toBe(false);
    expect(t.checked).toHaveLength(1);
    expect(t.source(first).lastProbeAt).toBeNull();
    // It can be started again afterwards.
    expect(t.full.start()).not.toBeNull();
    await t.full.stop();
  });

  it('waits out the settle period after a stream’s first audio', async () => {
    const t = harness();
    t.service.settleBackground(150);
    const startedAt = Date.now();
    const done = t.finished();
    await until(() => t.checked.length > 0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
    await done;
  });

  it('checks a source again after streams starting interrupt it, however often (not a give-way)', async () => {
    let calls = 0;
    const t = harness({
      check: (_id, signal) => {
        calls++;
        // The first five checks run until a stream start interrupts them; every later one passes.
        if (calls > 5) return Promise.resolve(ok());
        return new Promise((resolve) =>
          signal?.addEventListener('abort', () =>
            resolve({ ...emptyOutcome(Date.now()), failureCode: 'CANCELLED' }),
          ),
        );
      },
    });
    const done = t.finished();
    for (let n = 1; n <= 5; n++) {
      await until(() => calls === n);
      t.service.holdBackground(1);
    }
    const end = await done;
    const first = t.checked[0]!;
    expect(t.checked.filter((id) => id === first)).toHaveLength(6);
    expect(end.skipped).toBe(0);
    expect(end.done).toBe(end.total);
    expect(t.source(first).lastProbeAt).not.toBeNull();
  });

  it('gives way to a play on the same host, then checks that source again', async () => {
    let calls = 0;
    const t = harness({
      check: (_id, signal) => {
        calls++;
        // The first check waits until a play interrupts it; every later one passes.
        if (calls > 1) return Promise.resolve(ok());
        return new Promise((resolve) =>
          signal?.addEventListener('abort', () =>
            resolve({ ...emptyOutcome(Date.now()), failureCode: 'CANCELLED' }),
          ),
        );
      },
    });
    const done = t.finished();
    await until(() => t.checked.length === 1);
    const first = t.checked[0]!;
    // A listener's check of another source on the same host: the background check gives way.
    const other = t
      .enabled()
      .find((id) => id !== first && t.source(id).url.startsWith('https://stream.example.org/'))!;
    await t.service.probe(other);
    const end = await done;
    expect(t.checked.filter((id) => id === first)).toHaveLength(2);
    expect(end.skipped).toBe(0);
    expect(end.done).toBe(end.total);
  });
});
