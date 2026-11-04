import { constants } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loopDelayLine, processLoadLine, silenceLine, voiceThreadLine } from '../../src/discord/ui/format.ts';
import {
  type DelayHistogram,
  EventLoopMonitor,
  type GcEntry,
  gcKindName,
  type MonitorSeams,
  parseProcStat,
} from '../../src/observability/event-loop.ts';

/** Fake GC, CPU and memory sources; `gc()` delivers an entry as Node's observer would. */
function seams(extra: MonitorSeams = {}) {
  let onEntry: ((e: GcEntry) => void) | null = null;
  let observers = 0;
  const cpu = { user: 1_000_000, system: 200_000 };
  const state = {
    cpu,
    switches: 30,
    observers: () => observers,
    gc: (e: GcEntry) => onEntry?.(e),
    observeGc: (cb: (e: GcEntry) => void) => {
      observers++;
      onEntry = cb;
      return () => {
        observers--;
        onEntry = null;
      };
    },
    cpuUsage: () => ({ ...cpu }),
    involuntarySwitches: (): number => state.switches,
    memoryUsage: () => ({
      heapUsed: 40 * 1_048_576,
      external: 3.5 * 1_048_576,
      arrayBuffers: 1_048_576,
      rss: 120.3 * 1_048_576,
    }),
    platform: 'darwin',
    ...extra,
  };
  return state;
}

/** A histogram that returns fixed readings in nanoseconds, like Node's. */
class FakeHistogram implements DelayHistogram {
  count: number;
  readonly mean: number;
  readonly max: number;
  readonly #p99: number;
  resets = 0;
  enabled = false;
  constructor(r: { count: number; meanMs: number; p99Ms: number; maxMs: number }) {
    this.count = r.count;
    this.mean = r.meanMs * 1e6;
    this.max = r.maxMs * 1e6;
    this.#p99 = r.p99Ms * 1e6;
  }
  percentile(): number {
    return this.#p99;
  }
  reset(): void {
    this.resets++;
    this.count = 0;
  }
  enable(): boolean {
    this.enabled = true;
    return true;
  }
  disable(): boolean {
    this.enabled = false;
    return true;
  }
}
const fakeHistogram = (r: ConstructorParameters<typeof FakeHistogram>[0]) => new FakeHistogram(r);
/** A histogram with the same readings in every window (its reset keeps the count). */
const steadyHistogram = () => {
  const h = new FakeHistogram({ count: 5, meanMs: 10, p99Ms: 10, maxMs: 10 });
  h.reset = () => {};
  return h;
};

describe('event-loop delay', () => {
  it('reports the delay beyond the 10 ms sampling interval', () => {
    const h = fakeHistogram({ count: 100, meanMs: 10.3, p99Ms: 11.2, maxMs: 129 });
    const m = new EventLoopMonitor(() => h);
    expect(m.current()).toBeNull();
    m.start(60_000);
    expect(h.enabled).toBe(true);
    const s = m.current()!;
    expect(s.meanMs).toBeCloseTo(0.3);
    expect(s.p99Ms).toBeCloseTo(1.2);
    expect(s.maxMs).toBe(119);
    m.stop();
    expect(h.enabled).toBe(false);
    expect(m.current()).toBeNull();
  });

  it('keeps the last complete window after rotating', () => {
    const h = fakeHistogram({ count: 50, meanMs: 12, p99Ms: 40, maxMs: 70 });
    const m = new EventLoopMonitor(() => h);
    m.start(60_000);
    expect(m.lastWindow()).toBeNull();
    const done = m.rotate();
    expect(done?.maxMs).toBe(60);
    expect(h.resets).toBe(1);
    expect(m.lastWindow()?.maxMs).toBe(60);
    // An empty window after the rotation doesn't replace the last complete one.
    expect(m.rotate()).toBeNull();
    expect(m.lastWindow()?.maxMs).toBe(60);
    m.stop();
  });

  it('summarises each window’s collections, memory and CPU from injected samplers', () => {
    const s = seams();
    const m = new EventLoopMonitor(() => steadyHistogram(), s);
    expect(s.observers()).toBe(0);
    m.start(60_000);
    expect(s.observers()).toBe(1);
    s.gc({ duration: 1.25, kind: constants.NODE_PERFORMANCE_GC_MINOR });
    s.gc({ duration: 23.44, kind: constants.NODE_PERFORMANCE_GC_MAJOR });
    s.gc({ duration: 3, kind: constants.NODE_PERFORMANCE_GC_INCREMENTAL });
    s.cpu.user += 450_000;
    s.cpu.system += 51_400;
    s.switches += 7;
    const w = m.rotate()!;
    expect(w.gc).toEqual({ count: 3, major: 1, maxMs: 23.4, totalMs: 27.7, maxKind: 'major' });
    expect(w.memory).toEqual({ heapUsedMb: 40, externalMb: 3.5, arrayBuffersMb: 1, rssMb: 120.3 });
    expect(w.cpu).toEqual({ userMs: 450, systemMs: 51, involuntarySwitches: 7, stealPct: null });
    // The next window starts from zero.
    s.gc({ duration: 0.4, kind: constants.NODE_PERFORMANCE_GC_WEAKCB });
    const next = m.current()!;
    expect(next.gc).toEqual({ count: 1, major: 0, maxMs: 0.4, totalMs: 0.4, maxKind: 'weakcb' });
    expect(next.cpu).toMatchObject({ userMs: 0, systemMs: 0, involuntarySwitches: 0 });
    m.stop();
    // The observer is disconnected, and late entries change nothing.
    expect(s.observers()).toBe(0);
    s.gc({ duration: 99, kind: constants.NODE_PERFORMANCE_GC_MAJOR });
    expect(m.lastWindow()!.gc.maxMs).toBe(23.4);
  });

  it('reports a window with no collections as such', () => {
    const m = new EventLoopMonitor(
      () => fakeHistogram({ count: 1, meanMs: 10, p99Ms: 10, maxMs: 10 }),
      seams(),
    );
    m.start(60_000);
    expect(m.current()!.gc).toEqual({ count: 0, major: 0, maxMs: 0, totalMs: 0, maxKind: null });
    m.stop();
  });

  it('names every kind of collection', () => {
    expect(gcKindName(constants.NODE_PERFORMANCE_GC_MAJOR)).toBe('major');
    expect(gcKindName(constants.NODE_PERFORMANCE_GC_MINOR)).toBe('minor');
    expect(gcKindName(constants.NODE_PERFORMANCE_GC_MINOR_MARK_SWEEP)).toBe('minor');
    expect(gcKindName(constants.NODE_PERFORMANCE_GC_INCREMENTAL)).toBe('incremental');
    expect(gcKindName(constants.NODE_PERFORMANCE_GC_WEAKCB)).toBe('weakcb');
    expect(gcKindName(12345)).toBe('other');
  });

  it('parses the CPU line of /proc/stat', () => {
    expect(parseProcStat('cpu  100 0 50 800 10 0 0 40 7 0\ncpu0 1 2 3\n')).toEqual({
      steal: 40,
      total: 1000,
    });
    expect(parseProcStat('cpu  1 2 3 4 5 6 7 8')).toEqual({ steal: 8, total: 36 });
    expect(parseProcStat('cpu0 1 2 3 4 5 6 7 8\n')).toBeNull();
    expect(parseProcStat('cpu  1 2 3\n')).toBeNull();
    expect(parseProcStat('cpu  1 2 3 x 5 6 7 8\n')).toBeNull();
    expect(parseProcStat('')).toBeNull();
  });

  describe('CPU steal on Linux', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('reads /proc/stat just before each window ends, so the window carries its own steal', async () => {
      vi.useFakeTimers();
      const stats = [
        'cpu  100 0 0 900 0 0 0 0\n',
        'cpu  200 0 0 1700 0 0 0 100\n',
        'cpu  300 0 0 2700 0 0 0 100\n',
      ];
      const reads: number[] = [];
      const s = seams({
        platform: 'linux',
        readProcStat: async () => {
          reads.push(Date.now());
          return stats.shift() ?? 'garbage';
        },
      });
      const windows: Array<number | null> = [];
      const m = new EventLoopMonitor(() => steadyHistogram(), s);
      vi.setSystemTime(0);
      m.start(60_000, (w) => windows.push(w.cpu.stealPct));
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toEqual([0]); // the baseline
      expect(m.current()!.cpu.stealPct).toBeNull();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reads).toEqual([0, 59_000]);
      expect(windows).toEqual([10]); // 100 steal of 1000 ticks
      await vi.advanceTimersByTimeAsync(60_000);
      expect(windows).toEqual([10, 0]);
      // An unreadable file makes the figure unknown rather than stale.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(windows).toEqual([10, 0, null]);
      m.stop();
      const before = reads.length;
      await vi.advanceTimersByTimeAsync(180_000);
      expect(reads).toHaveLength(before);
    });

    it('leaves the steal unknown when the file can’t be read, or the counters did not move', async () => {
      vi.useFakeTimers();
      let fail = true;
      const m = new EventLoopMonitor(
        () => steadyHistogram(),
        seams({
          platform: 'linux',
          readProcStat: async () => {
            if (fail) throw new Error('ENOENT');
            return 'cpu  1 1 1 1 1 1 1 1\n';
          },
        }),
      );
      m.start(10_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(m.lastWindow()!.cpu.stealPct).toBeNull();
      fail = false;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(m.lastWindow()!.cpu.stealPct).toBeNull(); // same counters twice: no time passed
      m.stop();
    });

    it('ignores a reading that finishes after stop()', async () => {
      const pending: Array<(text: string) => void> = [];
      const m = new EventLoopMonitor(
        () => steadyHistogram(),
        seams({
          platform: 'linux',
          readProcStat: () => new Promise<string>((r) => pending.push(r)),
        }),
      );
      m.start(60_000);
      m.stop();
      m.start(60_000);
      expect(pending).toHaveLength(2);
      pending[1]!('cpu  0 0 0 1000 0 0 0 0\n'); // the new run's baseline
      await new Promise((r) => setImmediate(r));
      pending[0]!('cpu  0 0 0 1500 0 0 0 500\n'); // the stopped run's reading: would be 50 % if used
      await new Promise((r) => setImmediate(r));
      expect(m.current()!.cpu.stealPct).toBeNull();
      m.stop();
    });

    it('never reads /proc/stat on other platforms', async () => {
      vi.useFakeTimers();
      const read = vi.fn(async () => 'cpu  1 2 3 4 5 6 7 8\n');
      const m = new EventLoopMonitor(
        () => steadyHistogram(),
        seams({ platform: 'win32', readProcStat: read }),
      );
      m.start(60_000);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(read).not.toHaveBeenCalled();
      expect(m.lastWindow()!.cpu.stealPct).toBeNull();
      m.stop();
    });
  });

  it('uses Node’s own GC observer, CPU and memory figures by default', async () => {
    const m = new EventLoopMonitor(() => steadyHistogram());
    m.start(60_000);
    // Enough short-lived garbage for a young-generation collection, which the observer then reports.
    let kept = 0;
    for (let round = 0; round < 20; round++) {
      const junk: Array<{ n: number }> = [];
      for (let i = 0; i < 50_000; i++) junk.push({ n: i });
      kept += junk.length;
    }
    expect(kept).toBe(1_000_000);
    await new Promise((r) => setTimeout(r, 50));
    const w = m.current()!;
    expect(w.gc.count).toBeGreaterThanOrEqual(0);
    expect(w.memory.rssMb).toBeGreaterThan(0);
    expect(w.cpu.userMs).toBeGreaterThanOrEqual(0);
    expect(w.cpu.involuntarySwitches).toBeGreaterThanOrEqual(0);
    m.stop();
  });

  it('flags delays long enough to send voice packets late', () => {
    expect(loopDelayLine(null)).toBe('Event-loop delay: not measured yet');
    const calm = loopDelayLine({ meanMs: 0.3, p99Ms: 1.2, maxMs: 3, windowSec: 60 });
    expect(calm).toBe('Event-loop delay (last 60 s): typical 0.3 ms · 99% under 1.2 ms · worst 3 ms');
    expect(loopDelayLine({ meanMs: 1, p99Ms: 25, maxMs: 120, windowSec: 60 })).toMatch(
      /high enough to send voice packets late/,
    );
  });

  it('shows what can explain a delay: memory clean-up, CPU and host steal', () => {
    expect(processLoadLine(null)).toBe('Memory clean-up and CPU: not measured yet');
    const base = { meanMs: 1, p99Ms: 2, maxMs: 3, windowSec: 60 };
    const memory = { heapUsedMb: 40, externalMb: 5, arrayBuffersMb: 2, rssMb: 120 };
    expect(
      processLoadLine({
        ...base,
        gc: { count: 12, major: 1, maxMs: 81.4, totalMs: 95, maxKind: 'major' },
        memory,
        cpu: { userMs: 3000, systemMs: 600, involuntarySwitches: 42, stealPct: 1.5 },
      }),
    ).toBe(
      'Memory clean-up (last 60 s): 12 pauses, longest 81.4 ms (major) · CPU 6% of one core, preempted 42× · host steal 1.5%',
    );
    expect(
      processLoadLine({
        ...base,
        windowSec: 0,
        gc: { count: 0, major: 0, maxMs: 0, totalMs: 0, maxKind: null },
        memory,
        cpu: { userMs: 0, systemMs: 0, involuntarySwitches: 0, stealPct: null },
      }),
    ).toBe('Memory clean-up (last 0 s): no pauses · CPU —% of one core, preempted 0×');
  });

  it('shows the voice worker, and the main loop as not sending voice when the worker does', () => {
    expect(loopDelayLine(null, false)).toBe('Main event-loop delay: not measured yet');
    expect(loopDelayLine({ meanMs: 1, p99Ms: 25, maxMs: 120, windowSec: 60 }, false)).toBe(
      'Main event-loop delay (last 60 s): typical 1 ms · 99% under 25 ms · worst 120 ms',
    );
    expect(voiceThreadLine(null)).toBeNull();
    const stats = {
      alive: true,
      restarts: 0,
      links: 1,
      loopDelay: { current: null, lastWindow: { meanMs: 0.2, p99Ms: 1.1, maxMs: 4, windowSec: 60 } },
      gc: { current: { count: 3, major: 0, maxMs: 0.8, totalMs: 1.5 }, lastWindow: null },
      heapUsedMb: 11,
      heapTotalMb: 16,
      externalMb: 2,
      arrayBuffersMb: 1,
      ageMs: 1_000,
    };
    expect(voiceThreadLine(stats)).toBe(
      'Voice thread: delay worst 4 ms, 99% under 1.1 ms (last 60 s) · memory clean-up longest 0.8 ms · heap 11 MB',
    );
    expect(
      voiceThreadLine({
        ...stats,
        alive: false,
        restarts: 2,
        loopDelay: { current: { meanMs: 3, p99Ms: 30, maxMs: 64, windowSec: 12 }, lastWindow: null },
      }),
    ).toBe(
      'Voice thread: delay worst 64 ms, 99% under 30 ms (last 12 s) (high enough to send voice packets late) · memory clean-up longest 0.8 ms · heap 11 MB · restarted 2× · not running',
    );
    expect(voiceThreadLine({ ...stats, loopDelay: { current: null, lastWindow: null } })).toMatch(
      /^Voice thread: delay not measured yet/,
    );
  });

  it('shows silence the voice player filled in', () => {
    expect(silenceLine(undefined, undefined)).toBe('Silence filled in: —');
    expect(silenceLine(null, null)).toBe('Silence filled in: —');
    expect(silenceLine(120, null)).toBe('Silence filled in (no audio ready): 120 ms this stream');
    expect(silenceLine(120, 40)).toBe(
      'Silence filled in (no audio ready): 120 ms this stream · 40 ms in the last minute',
    );
  });
});
