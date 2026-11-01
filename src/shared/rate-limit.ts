/** Simple in-memory token bucket keyed by an arbitrary string (user, guild, scope). */
export class RateLimiter {
  readonly #buckets = new Map<string, { tokens: number; updatedAt: number }>();
  readonly capacity: number;
  readonly refillPerMs: number;
  readonly #now: () => number;

  constructor(capacity: number, refillPerMs: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.refillPerMs = refillPerMs;
    this.#now = now;
  }

  static perWindow(count: number, windowMs: number, now?: () => number): RateLimiter {
    return new RateLimiter(count, count / windowMs, now);
  }

  /** Consumes a token. Returns 0 if allowed, otherwise the ms to wait. */
  take(key: string): number {
    const t = this.#now();
    const bucket = this.#buckets.get(key) ?? { tokens: this.capacity, updatedAt: t };
    bucket.tokens = Math.min(this.capacity, bucket.tokens + (t - bucket.updatedAt) * this.refillPerMs);
    bucket.updatedAt = t;
    this.#buckets.set(key, bucket);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - bucket.tokens) / this.refillPerMs);
  }

  /** Drops full buckets so the map cannot grow without bound. */
  sweep(): void {
    const t = this.#now();
    for (const [key, b] of this.#buckets) {
      if (b.tokens + (t - b.updatedAt) * this.refillPerMs >= this.capacity) this.#buckets.delete(key);
    }
  }

  get size(): number {
    return this.#buckets.size;
  }
}
