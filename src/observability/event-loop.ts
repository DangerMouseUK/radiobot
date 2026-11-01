import { monitorEventLoopDelay } from 'node:perf_hooks';

/** How often the histogram samples, ms. Readings include it, so it is subtracted. */
const RESOLUTION_MS = 10;

export interface LoopDelaySummary {
  /** Average extra delay of a timer, ms. */
  meanMs: number;
  p99Ms: number;
  maxMs: number;
  /** Length of the window the figures cover, s. */
  windowSec: number;
}

/** The parts of Node's delay histogram the monitor reads (values in ns); tests pass a fake. */
export interface DelayHistogram {
  readonly count: number;
  readonly mean: number;
  readonly max: number;
  percentile(p: number): number;
  reset(): void;
  enable(): boolean;
  disable(): boolean;
}

/**
 * Measures how late Node's event loop runs timers. The voice player sends one packet every
 * 20 ms from this loop, so a delay of tens of milliseconds here goes out to Discord as a short
 * gap followed by a burst, which listeners hear as a drop and a catch-up. Keeps the last
 * complete window (a minute by default) alongside the current one.
 */
export class EventLoopMonitor {
  readonly #create: () => DelayHistogram;
  #h: DelayHistogram | null = null;
  #timer: NodeJS.Timeout | null = null;
  #since = 0;
  #last: LoopDelaySummary | null = null;

  constructor(create: () => DelayHistogram = () => monitorEventLoopDelay({ resolution: RESOLUTION_MS })) {
    this.#create = create;
  }

  /** Starts sampling. `onWindow` receives each completed window's figures. */
  start(windowMs = 60_000, onWindow?: (s: LoopDelaySummary) => void): void {
    if (this.#h) return;
    this.#h = this.#create();
    this.#h.enable();
    this.#since = Date.now();
    this.#timer = setInterval(() => {
      const s = this.rotate();
      if (s && onWindow) onWindow(s);
    }, windowMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#h?.disable();
    this.#h = null;
  }

  /** Figures for the window in progress, or null before any sample. */
  current(now = Date.now()): LoopDelaySummary | null {
    const h = this.#h;
    if (!h || h.count === 0) return null;
    const ms = (ns: number) => Math.max(0, Math.round((ns / 1e6 - RESOLUTION_MS) * 10) / 10);
    return {
      meanMs: ms(h.mean),
      p99Ms: ms(h.percentile(99)),
      maxMs: ms(h.max),
      windowSec: Math.round((now - this.#since) / 1000),
    };
  }

  /** The last complete window, or null until one has finished. */
  lastWindow(): LoopDelaySummary | null {
    return this.#last;
  }

  /** Closes the current window and starts the next. */
  rotate(now = Date.now()): LoopDelaySummary | null {
    const s = this.current(now);
    if (s) this.#last = s;
    this.#h?.reset();
    this.#since = now;
    return s;
  }
}
