import { RadioError } from './errors.ts';

export { setTimeout as delay } from 'node:timers/promises';

/** Limits concurrent async work. Waiters are served FIFO. */
export class Semaphore {
  #available: number;
  readonly #waiters: Array<() => void> = [];
  readonly size: number;

  constructor(size: number) {
    this.size = size;
    this.#available = size;
  }

  get inUse(): number {
    return this.size - this.#available;
  }

  get waiting(): number {
    return this.#waiters.length;
  }

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.#available > 0) {
      this.#available--;
      return this.#releaser();
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve(this.#releaser());
      };
      const onAbort = () => {
        const idx = this.#waiters.indexOf(grant);
        if (idx >= 0) this.#waiters.splice(idx, 1);
        reject(new RadioError('CANCELLED', 'Operation cancelled.'));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiters.push(grant);
    });
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  #releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) next();
      else this.#available++;
    };
  }
}

/** A keyed set of semaphores, e.g. one per remote host. */
export class KeyedSemaphore {
  readonly #map = new Map<string, Semaphore>();
  readonly sizePerKey: number;

  constructor(sizePerKey: number) {
    this.sizePerKey = sizePerKey;
  }

  async run<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let sem = this.#map.get(key);
    if (!sem) {
      sem = new Semaphore(this.sizePerKey);
      this.#map.set(key, sem);
    }
    try {
      return await sem.run(fn, signal);
    } finally {
      if (sem.inUse === 0 && sem.waiting === 0) this.#map.delete(key);
    }
  }
}

/** Returns an AbortSignal that aborts when any input aborts or the timeout elapses. */
export function linkedSignal(
  timeoutMs: number | null,
  ...signals: Array<AbortSignal | undefined>
): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => Boolean(s));
  if (timeoutMs !== null) list.push(AbortSignal.timeout(timeoutMs));
  if (list.length === 0) return new AbortController().signal;
  return list.length === 1 ? list[0]! : AbortSignal.any(list);
}

/** Gives the event loop a turn: timers, I/O and voice packets that are due go first. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * Splits long synchronous work into slices: `await slice()` gives the event loop a turn once
 * `budgetMs` have passed since the last one, so voice packets are not held up behind the work.
 */
export function timeSlicer(
  budgetMs: number,
  now: () => number = () => performance.now(),
): () => Promise<void> {
  let start = now();
  return async () => {
    if (now() - start < budgetMs) return;
    await yieldToEventLoop();
    start = now();
  };
}
