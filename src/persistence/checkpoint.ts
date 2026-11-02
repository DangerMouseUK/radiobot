import { stat } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import type { Logger } from '../observability/logger.ts';
import { errorMessage } from '../shared/errors.ts';
import { siblingModule } from '../shared/workers.ts';
import type { Db } from './db.ts';

export type CheckpointRequest = { type: 'checkpoint' } | { type: 'close' };

export interface CheckpointReply {
  ok: boolean;
  /** SQLite could not finish the checkpoint because a reader or writer was in the way. */
  busy: boolean;
  /** Frames in the write-ahead log, and how many of them are now in the database file. */
  walFrames: number;
  checkpointedFrames: number;
  ms: number;
  error: string | null;
}

export type CheckpointMessage = { type: 'ready' } | { type: 'result'; reply: CheckpointReply };

/** How often the log is copied back into the database file. */
export const CHECKPOINT_INTERVAL_MS = 5 * 60_000;
/** How often the log's size is looked at between checkpoints. */
export const CHECKPOINT_CHECK_MS = 30_000;
/** A log that grows past this is checkpointed at the next look, without waiting for the interval. */
export const WAL_LIMIT_BYTES = 4 * 1024 * 1024;
/** SQLite's own default, used again if checkpoints can't run on a worker thread. */
const SQLITE_DEFAULT_AUTOCHECKPOINT = 1000;
/** Consecutive failed checkpoints after which the worker is given up on. */
const MAX_FAILURES = 3;

/** Something that runs PASSIVE checkpoints off the main thread: the worker below, or a test double. */
export interface CheckpointRunner {
  readonly alive: boolean;
  checkpoint(): Promise<CheckpointReply>;
  close(): Promise<void>;
}

export interface WalCheckpointerOptions {
  db: Db;
  logger: Logger;
  intervalMs?: number;
  checkEveryMs?: number;
  walLimitBytes?: number;
  now?: () => number;
  /** Size of the write-ahead log file in bytes (0 if there is none). */
  walSize?: (walPath: string) => Promise<number>;
  startRunner?: (dbPath: string) => Promise<CheckpointRunner>;
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Keeps SQLite's write-ahead log (WAL) in check without touching the voice thread.
 *
 * By default SQLite checkpoints inside whichever commit pushes the log past 1000 pages: that commit
 * copies the log into the database file and syncs it to disk before returning, on the thread that
 * sends voice packets. Here the bot's connection never checkpoints (`wal_autocheckpoint = 0`);
 * instead a worker thread with its own connection runs a PASSIVE checkpoint every few minutes, and
 * sooner if the log file grows past `walLimitBytes`. A PASSIVE checkpoint takes no lock the bot's
 * connection waits for. If the worker can't start, or keeps failing, SQLite's own automatic
 * checkpoints are switched back on, so the log never grows without bound.
 */
export class WalCheckpointer {
  readonly #o: Required<Omit<WalCheckpointerOptions, 'db' | 'logger'>>;
  readonly #db: Db;
  readonly #log: Logger;
  #runner: CheckpointRunner | null = null;
  #timer: NodeJS.Timeout | null = null;
  #running: Promise<CheckpointReply | null> | null = null;
  #lastRun = 0;
  #highWater = 0;
  #failures = 0;

  constructor(o: WalCheckpointerOptions) {
    this.#db = o.db;
    this.#log = o.logger.child({ component: 'wal-checkpoint' });
    this.#o = {
      intervalMs: o.intervalMs ?? CHECKPOINT_INTERVAL_MS,
      checkEveryMs: o.checkEveryMs ?? CHECKPOINT_CHECK_MS,
      walLimitBytes: o.walLimitBytes ?? WAL_LIMIT_BYTES,
      now: o.now ?? Date.now,
      walSize: o.walSize ?? fileSize,
      startRunner: o.startRunner ?? startCheckpointWorker,
    };
  }

  /** True while checkpoints run on the worker (and not inside the bot's own commits). */
  get active(): boolean {
    return this.#runner?.alive === true;
  }

  /** Starts the worker; returns false (leaving SQLite's automatic checkpoints on) if it can't. */
  async start(): Promise<boolean> {
    if (this.#db.path === ':memory:' || this.#runner) return false;
    try {
      this.#runner = await this.#o.startRunner(this.#db.path);
    } catch (err) {
      this.#log.warn({ err: errorMessage(err) }, 'WAL checkpoints stay on the main thread: no worker');
      return false;
    }
    this.#db.setAutoCheckpoint(0);
    this.#lastRun = this.#o.now();
    this.#timer = setInterval(() => void this.#tick(), this.#o.checkEveryMs);
    this.#timer.unref?.();
    return true;
  }

  async #tick(): Promise<void> {
    if (this.#running || !this.#runner) return;
    if (!this.#runner.alive) {
      this.#fallBack('the checkpoint worker stopped');
      return;
    }
    const size = await this.#o.walSize(`${this.#db.path}-wal`);
    const due =
      this.#o.now() - this.#lastRun >= this.#o.intervalMs ||
      size > Math.max(this.#o.walLimitBytes, this.#highWater);
    if (!due || this.#running) return;
    this.#highWater = Math.max(this.#highWater, size);
    await this.checkpoint();
  }

  /** Runs one PASSIVE checkpoint on the worker now (or joins the one already running). */
  checkpoint(): Promise<CheckpointReply | null> {
    if (this.#running) return this.#running;
    const runner = this.#runner;
    if (!runner) return Promise.resolve(null);
    this.#lastRun = this.#o.now();
    this.#running = runner
      .checkpoint()
      .then(
        (reply) => {
          if (reply.ok) {
            this.#failures = 0;
            this.#log.debug({ ...reply }, 'WAL checkpoint');
          } else this.#failed(reply.error ?? 'unknown error');
          return reply;
        },
        (err: unknown) => {
          this.#failed(errorMessage(err));
          return null;
        },
      )
      .finally(() => {
        this.#running = null;
      });
    return this.#running;
  }

  #failed(error: string): void {
    this.#failures++;
    this.#log.warn({ error, failures: this.#failures }, 'WAL checkpoint failed');
    if (this.#failures >= MAX_FAILURES || !this.#runner?.alive) this.#fallBack(error);
  }

  /** Hands checkpoints back to SQLite (inside commits, on the main thread): better than a log that only grows. */
  #fallBack(reason: string): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    const runner = this.#runner;
    this.#runner = null;
    void runner?.close().catch(() => {});
    try {
      this.#db.setAutoCheckpoint(SQLITE_DEFAULT_AUTOCHECKPOINT);
    } catch {
      /* the database is closing */
    }
    this.#log.warn({ reason }, 'WAL checkpoints moved back to the main thread');
  }

  /** Stops the timer and the worker, waiting for a checkpoint that is still running. */
  async stop(): Promise<void> {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#running;
    const runner = this.#runner;
    this.#runner = null;
    await runner?.close();
  }
}

/**
 * The worker's side (checkpoint-worker.ts): a connection of its own that only ever runs PASSIVE
 * checkpoints. Copying the log into the database file and syncing it to disk can take tens of
 * milliseconds on slow storage. PASSIVE never waits for a lock and takes none that the bot's
 * connection waits for: the bot's writes carry on meanwhile, and whatever can't be copied now is
 * copied next time.
 */
export function openCheckpointConnection(path: string): { checkpoint(): CheckpointReply; close(): void } {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA busy_timeout = 0');
  // Copying pages needs next to no cache; keep this connection small.
  db.exec('PRAGMA cache_size = -256');
  const stmt = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
  return {
    checkpoint(): CheckpointReply {
      const started = performance.now();
      try {
        const r = stmt.get() as { busy: number; log: number; checkpointed: number };
        const ms = performance.now() - started;
        return {
          ok: true,
          busy: r.busy !== 0,
          walFrames: r.log,
          checkpointedFrames: r.checkpointed,
          ms,
          error: null,
        };
      } catch (err) {
        const ms = performance.now() - started;
        return { ok: false, busy: false, walFrames: 0, checkpointedFrames: 0, ms, error: errorMessage(err) };
      }
    },
    close: () => db.close(),
  };
}

/**
 * Starts the checkpoint worker and resolves once its connection is open. Start-up waits for it,
 * so it gives up after `timeoutMs` (the caller then keeps SQLite's own checkpoints).
 */
export function startCheckpointWorker(dbPath: string, timeoutMs = 10_000): Promise<CheckpointRunner> {
  const worker = new Worker(siblingModule(import.meta.url, 'checkpoint-worker'), {
    workerData: { path: dbPath },
    // It holds one statement and a tiny page cache; a small heap is plenty.
    resourceLimits: { maxOldGenerationSizeMb: 16, maxYoungGenerationSizeMb: 2, stackSizeMb: 1 },
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.removeAllListeners();
      void worker.terminate();
      reject(new Error('checkpoint worker did not start in time'));
    }, timeoutMs);
    timer.unref?.();
    const failed = (err: unknown) => {
      clearTimeout(timer);
      reject(err);
    };
    worker.once('error', failed);
    worker.once('exit', (code) => failed(new Error(`checkpoint worker exited with code ${code}`)));
    worker.once('message', (msg: CheckpointMessage) => {
      clearTimeout(timer);
      worker.off('error', failed);
      worker.removeAllListeners('exit');
      if (msg.type === 'ready') resolve(new WorkerRunner(worker));
      else {
        void worker.terminate();
        reject(new Error('checkpoint worker did not start'));
      }
    });
  });
}

class WorkerRunner implements CheckpointRunner {
  readonly #worker: Worker;
  #pending: { resolve: (r: CheckpointReply) => void; reject: (e: Error) => void } | null = null;
  #dead: Error | null = null;
  #closing = false;

  constructor(worker: Worker) {
    this.#worker = worker;
    worker.on('message', (msg: CheckpointMessage) => {
      if (msg.type !== 'result') return;
      const p = this.#pending;
      this.#pending = null;
      p?.resolve(msg.reply);
    });
    worker.on('error', (err) => this.#die(err));
    worker.on('exit', (code) => this.#die(new Error(`checkpoint worker exited with code ${code}`)));
  }

  get alive(): boolean {
    return this.#dead === null && !this.#closing;
  }

  #die(err: Error): void {
    this.#dead ??= err;
    const p = this.#pending;
    this.#pending = null;
    p?.reject(err);
  }

  checkpoint(): Promise<CheckpointReply> {
    if (!this.alive) return Promise.reject(this.#dead ?? new Error('checkpoint worker is closing'));
    if (this.#pending) return Promise.reject(new Error('a checkpoint is already running'));
    return new Promise((resolve, reject) => {
      this.#pending = { resolve, reject };
      this.#worker.postMessage({ type: 'checkpoint' } satisfies CheckpointRequest);
    });
  }

  async close(): Promise<void> {
    if (this.#dead || this.#closing) return;
    this.#closing = true;
    const exited = new Promise<void>((resolve) => this.#worker.once('exit', () => resolve()));
    this.#worker.postMessage({ type: 'close' } satisfies CheckpointRequest);
    // Bounded: a worker stuck in a slow sync to disk is stopped rather than waited for.
    const timer = setTimeout(() => void this.#worker.terminate(), 2_000);
    timer.unref?.();
    await exited;
    clearTimeout(timer);
  }
}
