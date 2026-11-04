import { readFile } from 'node:fs/promises';
import { constants, monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';

/** How often the histogram samples, ms. Readings include it, so it is subtracted. */
const RESOLUTION_MS = 10;
/** /proc/stat is read this long before each window ends, so its figure covers that window. */
const STEAL_LEAD_MS = 1_000;

export interface LoopDelaySummary {
  /** Average extra delay of a timer, ms. */
  meanMs: number;
  p99Ms: number;
  maxMs: number;
  /** Length of the window the figures cover, s. */
  windowSec: number;
}

/** Garbage collections in the window. A long one stops the event loop, voice packets included. */
export interface GcSummary {
  count: number;
  /** Full (mark-compact) collections, the kind that can pause for tens of milliseconds. */
  major: number;
  maxMs: number;
  totalMs: number;
  /** Kind of the longest collection (major, minor, incremental, weakcb), or null when there was none. */
  maxKind: string | null;
}

/** The process's memory when the figures were taken, MB. */
export interface MemorySummary {
  heapUsedMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  rssMb: number;
}

/** CPU the process used in the window, and how often the system took the core away from it. */
export interface CpuSummary {
  userMs: number;
  systemMs: number;
  /** Times the process was preempted: on one core, other work (or a noisy neighbour) took its turn. */
  involuntarySwitches: number;
  /** Share of the host's CPU time the hypervisor gave to other guests, %. Linux only; null elsewhere. */
  stealPct: number | null;
}

/** One window's figures: the event-loop delay plus what may explain it. */
export interface LoopWindowSummary extends LoopDelaySummary {
  gc: GcSummary;
  memory: MemorySummary;
  cpu: CpuSummary;
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

/** A finished garbage collection: its length in ms and Node's `NODE_PERFORMANCE_GC_*` kind. */
export interface GcEntry {
  duration: number;
  kind: number;
}

/** Everything else the monitor reads from the process; tests replace any of it. */
export interface MonitorSeams {
  /** Starts delivering GC entries; returns the function that stops it. */
  observeGc?: (onEntry: (e: GcEntry) => void) => () => void;
  /** Cumulative CPU time, µs (`process.cpuUsage()`). */
  cpuUsage?: () => { user: number; system: number };
  /** Cumulative involuntary context switches (`process.resourceUsage()`). */
  involuntarySwitches?: () => number;
  /** Memory, bytes (`process.memoryUsage()`). */
  memoryUsage?: () => { heapUsed: number; external: number; arrayBuffers: number; rss: number };
  /** The contents of /proc/stat. */
  readProcStat?: () => Promise<string>;
  platform?: string;
}

/** Node's PerformanceObserver on 'gc' entries. Runs once per batch of collections, never per packet. */
function observeGcEntries(onEntry: (e: GcEntry) => void): () => void {
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      const kind = (e as { detail?: { kind?: number } | null }).detail?.kind ?? 0;
      onEntry({ duration: e.duration, kind });
    }
  });
  obs.observe({ entryTypes: ['gc'] });
  return () => obs.disconnect();
}

/** A readable name for a `NODE_PERFORMANCE_GC_*` kind. */
export function gcKindName(kind: number): string {
  switch (kind) {
    case constants.NODE_PERFORMANCE_GC_MAJOR:
      return 'major';
    case constants.NODE_PERFORMANCE_GC_MINOR:
    case constants.NODE_PERFORMANCE_GC_MINOR_MARK_SWEEP:
      return 'minor';
    case constants.NODE_PERFORMANCE_GC_INCREMENTAL:
      return 'incremental';
    case constants.NODE_PERFORMANCE_GC_WEAKCB:
      return 'weakcb';
    default:
      return 'other';
  }
}

/** The steal and total CPU time from the first line of /proc/stat, in ticks; null if it can't be read. */
export function parseProcStat(text: string): { steal: number; total: number } | null {
  const end = text.indexOf('\n');
  const parts = (end === -1 ? text : text.slice(0, end)).trim().split(/\s+/);
  if (parts[0] !== 'cpu' || parts.length < 9) return null;
  // user nice system idle iowait irq softirq steal; guest time is already counted in user.
  let total = 0;
  for (let i = 1; i <= 8; i++) {
    const n = Number(parts[i]);
    if (!Number.isFinite(n) || n < 0) return null;
    total += n;
  }
  return { steal: Number(parts[8]), total };
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const mb = (bytes: number) => round1(bytes / 1_048_576);

/**
 * Measures how late Node's event loop runs timers. The voice player sends one packet every
 * 20 ms from this loop, so a delay of tens of milliseconds here goes out to Discord as a short
 * gap followed by a burst, which listeners hear as a drop and a catch-up. Keeps the last
 * complete window (a minute by default) alongside the current one, with the garbage
 * collections, memory and CPU figures that usually explain a delay. All of it costs a few
 * microseconds a window, plus one short callback per batch of collections.
 */
export class EventLoopMonitor {
  readonly #create: () => DelayHistogram;
  readonly #observeGc: (onEntry: (e: GcEntry) => void) => () => void;
  readonly #cpuUsage: () => { user: number; system: number };
  readonly #switches: () => number;
  readonly #memory: () => { heapUsed: number; external: number; arrayBuffers: number; rss: number };
  readonly #readProcStat: () => Promise<string>;
  readonly #readSteal: boolean;
  #h: DelayHistogram | null = null;
  #timer: NodeJS.Timeout | null = null;
  #stealTimer: NodeJS.Timeout | null = null;
  #stopGc: (() => void) | null = null;
  #since = 0;
  #last: LoopWindowSummary | null = null;
  // The current window's collections.
  #gcCount = 0;
  #gcMajor = 0;
  #gcTotalMs = 0;
  #gcMaxMs = 0;
  #gcMaxKind = -1;
  // CPU counters at the start of the current window.
  #cpuBase = { user: 0, system: 0 };
  #switchBase = 0;
  // The two latest /proc/stat readings, and the steal share between them.
  #statPrev: { steal: number; total: number } | null = null;
  #stealPct: number | null = null;
  #run = 0;

  constructor(
    create: () => DelayHistogram = () => monitorEventLoopDelay({ resolution: RESOLUTION_MS }),
    seams: MonitorSeams = {},
  ) {
    this.#create = create;
    this.#observeGc = seams.observeGc ?? observeGcEntries;
    this.#cpuUsage = seams.cpuUsage ?? (() => process.cpuUsage());
    this.#switches = seams.involuntarySwitches ?? (() => process.resourceUsage().involuntaryContextSwitches);
    this.#memory = seams.memoryUsage ?? (() => process.memoryUsage());
    this.#readProcStat = seams.readProcStat ?? (() => readFile('/proc/stat', 'utf8'));
    this.#readSteal = (seams.platform ?? process.platform) === 'linux';
  }

  /** Starts sampling. `onWindow` receives each completed window's figures. */
  start(windowMs = 60_000, onWindow?: (s: LoopWindowSummary) => void): void {
    if (this.#h) return;
    const run = ++this.#run;
    this.#h = this.#create();
    this.#h.enable();
    this.#since = Date.now();
    this.#resetWindow();
    this.#stopGc = this.#observeGc((e) => this.#onGc(e));
    this.#timer = setInterval(() => {
      const s = this.rotate();
      if (s && onWindow) onWindow(s);
    }, windowMs);
    this.#timer.unref?.();
    if (this.#readSteal) {
      // A baseline now, then a reading shortly before each window ends, so each window's
      // summary carries the steal measured over (almost exactly) that window.
      void this.#sampleSteal(run);
      const lead = Math.min(STEAL_LEAD_MS, Math.floor(windowMs / 10));
      const loop = () => {
        void this.#sampleSteal(run);
        this.#stealTimer = setTimeout(loop, windowMs);
        this.#stealTimer.unref?.();
      };
      this.#stealTimer = setTimeout(loop, windowMs - lead);
      this.#stealTimer.unref?.();
    }
  }

  stop(): void {
    this.#run++;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#stealTimer) clearTimeout(this.#stealTimer);
    this.#stealTimer = null;
    this.#stopGc?.();
    this.#stopGc = null;
    this.#h?.disable();
    this.#h = null;
    this.#statPrev = null;
    this.#stealPct = null;
  }

  /** Figures for the window in progress, or null before any sample. */
  current(now = Date.now()): LoopWindowSummary | null {
    const h = this.#h;
    if (!h || h.count === 0) return null;
    const ms = (ns: number) => Math.max(0, Math.round((ns / 1e6 - RESOLUTION_MS) * 10) / 10);
    const cpu = this.#cpuUsage();
    const mem = this.#memory();
    return {
      meanMs: ms(h.mean),
      p99Ms: ms(h.percentile(99)),
      maxMs: ms(h.max),
      windowSec: Math.round((now - this.#since) / 1000),
      gc: {
        count: this.#gcCount,
        major: this.#gcMajor,
        maxMs: round1(this.#gcMaxMs),
        totalMs: round1(this.#gcTotalMs),
        maxKind: this.#gcCount > 0 ? gcKindName(this.#gcMaxKind) : null,
      },
      memory: {
        heapUsedMb: mb(mem.heapUsed),
        externalMb: mb(mem.external),
        arrayBuffersMb: mb(mem.arrayBuffers),
        rssMb: mb(mem.rss),
      },
      cpu: {
        userMs: Math.round((cpu.user - this.#cpuBase.user) / 1000),
        systemMs: Math.round((cpu.system - this.#cpuBase.system) / 1000),
        involuntarySwitches: this.#switches() - this.#switchBase,
        stealPct: this.#stealPct,
      },
    };
  }

  /** The last complete window, or null until one has finished. */
  lastWindow(): LoopWindowSummary | null {
    return this.#last;
  }

  /** Closes the current window and starts the next. */
  rotate(now = Date.now()): LoopWindowSummary | null {
    const s = this.current(now);
    if (s) this.#last = s;
    this.#h?.reset();
    this.#since = now;
    if (this.#h) this.#resetWindow();
    return s;
  }

  #resetWindow(): void {
    this.#gcCount = 0;
    this.#gcMajor = 0;
    this.#gcTotalMs = 0;
    this.#gcMaxMs = 0;
    this.#gcMaxKind = -1;
    this.#cpuBase = this.#cpuUsage();
    this.#switchBase = this.#switches();
  }

  #onGc(e: GcEntry): void {
    this.#gcCount++;
    this.#gcTotalMs += e.duration;
    if (e.kind === constants.NODE_PERFORMANCE_GC_MAJOR) this.#gcMajor++;
    if (this.#gcMaxKind === -1 || e.duration > this.#gcMaxMs) {
      this.#gcMaxMs = e.duration;
      this.#gcMaxKind = e.kind;
    }
  }

  /** Reads /proc/stat without blocking the loop; any failure just leaves the steal unknown. */
  async #sampleSteal(run: number): Promise<void> {
    let stat: { steal: number; total: number } | null = null;
    try {
      stat = parseProcStat(await this.#readProcStat());
    } catch {
      stat = null;
    }
    if (run !== this.#run) return; // stopped (or restarted) while the file was being read
    const prev = this.#statPrev;
    this.#statPrev = stat;
    if (!stat) {
      this.#stealPct = null;
      return;
    }
    if (!prev) return;
    const dTotal = stat.total - prev.total;
    this.#stealPct = dTotal > 0 ? round1(Math.max(0, ((stat.steal - prev.steal) / dTotal) * 100)) : null;
  }
}
