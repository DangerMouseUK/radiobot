import { constants, monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import type { WorkerGcSummary, WorkerLoopDelay, WorkerTelemetry } from './protocol.ts';

/** How often the delay histogram samples, ms. Readings include it, so it is subtracted. */
const RESOLUTION_MS = 10;
const MB = 1024 * 1024;

/** The parts of Node's delay histogram this reads (values in ns); tests pass a fake. */
export interface DelayHistogram {
  readonly count: number;
  readonly mean: number;
  readonly max: number;
  percentile(p: number): number;
  reset(): void;
  enable(): boolean;
  disable(): boolean;
}

const emptyGc = (): WorkerGcSummary => ({ count: 0, major: 0, maxMs: 0, totalMs: 0 });
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The voice worker's own event-loop delay and garbage collection, in windows (a minute by
 * default) like the main thread's monitor. This loop sends the voice packets, so these are the
 * figures that say whether a packet could have left late.
 */
export class LoopTelemetry {
  readonly #h: DelayHistogram;
  readonly #now: () => number;
  #gcObserver: PerformanceObserver | null = null;
  #since: number;
  #gc = emptyGc();
  #lastDelay: WorkerLoopDelay | null = null;
  #lastGc: WorkerGcSummary | null = null;

  constructor(opts: { histogram?: DelayHistogram; now?: () => number; observeGc?: boolean } = {}) {
    this.#h = opts.histogram ?? monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    this.#now = opts.now ?? Date.now;
    this.#since = this.#now();
    this.#h.enable();
    if (opts.observeGc !== false) {
      this.#gcObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          this.recordGc(e.duration, (e as { detail?: { kind?: number } }).detail?.kind);
        }
      });
      this.#gcObserver.observe({ entryTypes: ['gc'] });
    }
  }

  /** One garbage collection pause (from the observer; tests call it directly). */
  recordGc(durationMs: number, kind: number | undefined): void {
    const g = this.#gc;
    g.count++;
    if (kind === constants.NODE_PERFORMANCE_GC_MAJOR) g.major++;
    g.totalMs += durationMs;
    if (durationMs > g.maxMs) g.maxMs = durationMs;
  }

  #delay(): WorkerLoopDelay | null {
    const h = this.#h;
    if (h.count === 0) return null;
    const ms = (ns: number) => Math.max(0, round1(ns / 1e6 - RESOLUTION_MS));
    return {
      meanMs: ms(h.mean),
      p99Ms: ms(h.percentile(99)),
      maxMs: ms(h.max),
      windowSec: Math.round((this.#now() - this.#since) / 1000),
    };
  }

  /** Closes the window in progress: its figures become the last window's. */
  rotate(): void {
    this.#lastDelay = this.#delay();
    this.#lastGc = { ...this.#gc, maxMs: round1(this.#gc.maxMs), totalMs: round1(this.#gc.totalMs) };
    this.#h.reset();
    this.#gc = emptyGc();
    this.#since = this.#now();
  }

  sample(links: number): WorkerTelemetry {
    const heap = getHeapStatistics();
    const mem = process.memoryUsage();
    return {
      loopDelay: { current: this.#delay(), lastWindow: this.#lastDelay },
      gc: {
        current: { ...this.#gc, maxMs: round1(this.#gc.maxMs), totalMs: round1(this.#gc.totalMs) },
        lastWindow: this.#lastGc,
      },
      heapUsedMb: round1(heap.used_heap_size / MB),
      heapTotalMb: round1(heap.total_heap_size / MB),
      externalMb: round1(heap.external_memory / MB),
      arrayBuffersMb: round1(mem.arrayBuffers / MB),
      links,
      at: this.#now(),
    };
  }

  stop(): void {
    this.#h.disable();
    this.#gcObserver?.disconnect();
    this.#gcObserver = null;
  }
}
