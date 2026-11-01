import { describe, expect, it } from 'vitest';
import { loopDelayLine } from '../../src/discord/ui/format.ts';
import { type DelayHistogram, EventLoopMonitor } from '../../src/observability/event-loop.ts';

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

  it('flags delays long enough to send voice packets late', () => {
    expect(loopDelayLine(null)).toBe('Event-loop delay: not measured yet');
    const calm = loopDelayLine({ meanMs: 0.3, p99Ms: 1.2, maxMs: 3, windowSec: 60 });
    expect(calm).toBe('Event-loop delay (last 60 s): typical 0.3 ms · 99% under 1.2 ms · worst 3 ms');
    expect(loopDelayLine({ meanMs: 1, p99Ms: 25, maxMs: 120, windowSec: 60 })).toMatch(
      /high enough to send voice packets late/,
    );
  });
});
