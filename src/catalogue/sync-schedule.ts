/** Up to this much random delay is added to each run, so packs (and installations) don't all sync at once. */
const JITTER_MS = 15 * 60_000;

export interface SyncScheduleOptions {
  /** Packs that declare an official list. */
  packIds: string[];
  intervalMs: number;
  /** When a pack last synced (ISO time), or null if it never has. */
  lastSync: (packId: string) => string | null;
  sync: (packId: string) => Promise<unknown>;
  now?: () => number;
  random?: () => number;
}

/**
 * One independent, jittered schedule per pack: first run when due (about 10 min after start if
 * it has never run, and never sooner than a minute), then every `intervalMs`. Each pack holds a
 * single pending timer, replaced on every run, and nothing is scheduled after `stop()`, even by a
 * sync that was still running.
 */
export function scheduleCatalogueSyncs(o: SyncScheduleOptions): { stop(): void; pending(): number } {
  const now = o.now ?? Date.now;
  const random = o.random ?? Math.random;
  const timers = new Map<string, NodeJS.Timeout>();
  let stopped = false;
  const schedule = (packId: string, ms: number) => {
    if (stopped) return;
    const t = setTimeout(async () => {
      timers.delete(packId);
      try {
        await o.sync(packId);
      } finally {
        schedule(packId, o.intervalMs + Math.round(random() * JITTER_MS));
      }
    }, ms);
    t.unref?.();
    timers.set(packId, t);
  };
  for (const packId of o.packIds) {
    const last = o.lastSync(packId);
    const due = last ? Math.max(0, Date.parse(last) + o.intervalMs - now()) : 10 * 60_000;
    schedule(packId, Math.max(due, 60_000) + Math.round(random() * JITTER_MS));
  }
  return {
    stop() {
      stopped = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
    pending: () => timers.size,
  };
}
