import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type CheckpointReply,
  type CheckpointRunner,
  openCheckpointConnection,
  startCheckpointWorker,
  WalCheckpointer,
} from '../../src/persistence/checkpoint.ts';
import { Db } from '../../src/persistence/db.ts';
import { silentLogger } from '../helpers.ts';

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of dbs.splice(0)) db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fileDb(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'radiobot-wal-'));
  dirs.push(dir);
  const db = new Db(join(dir, 'radio-bot.sqlite'));
  dbs.push(db);
  db.raw.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
  return db;
}

const fill = (db: Db, rows: number) => {
  for (let i = 0; i < rows; i++) db.run('INSERT INTO t (v) VALUES (?)', ['x'.repeat(2000)]);
};

const reply = (o: Partial<CheckpointReply> = {}): CheckpointReply => ({
  ok: true,
  busy: false,
  walFrames: 10,
  checkpointedFrames: 10,
  ms: 1,
  error: null,
  ...o,
});

/** A runner that answers at once (or as `answer` says) and counts what it was asked. */
function fakeRunner(answer: () => Promise<CheckpointReply> = async () => reply()) {
  const runner = {
    alive: true,
    calls: 0,
    closed: 0,
    checkpoint: () => {
      runner.calls++;
      return answer();
    },
    close: async () => {
      runner.closed++;
      runner.alive = false;
    },
  };
  return runner;
}

function checkpointer(db: Db, runner: CheckpointRunner, size: { bytes: number } = { bytes: 0 }) {
  return new WalCheckpointer({
    db,
    logger: silentLogger(),
    intervalMs: 5 * 60_000,
    checkEveryMs: 30_000,
    walLimitBytes: 4 * 1024 * 1024,
    walSize: async () => size.bytes,
    startRunner: async () => runner,
  });
}

describe('Db checkpoint settings', () => {
  it('turns automatic checkpoints off and on, and checkpoints on request', () => {
    const db = fileDb();
    expect(db.autoCheckpoint()).toBe(1000);
    db.setAutoCheckpoint(0);
    expect(db.autoCheckpoint()).toBe(0);
    fill(db, 50);
    const walPath = `${db.path}-wal`;
    expect(statSync(walPath).size).toBeGreaterThan(0);
    const r = db.checkpoint('TRUNCATE');
    expect(r).toMatchObject({ busy: false, walFrames: 0, checkpointedFrames: 0 });
    expect(statSync(walPath).size).toBe(0);
    db.setAutoCheckpoint(1000);
    expect(db.autoCheckpoint()).toBe(1000);
  });
});

describe('WAL checkpoints on a worker thread', () => {
  it('copies the log into the database file without the bot’s connection doing it', async () => {
    const db = fileDb();
    const ckpt = new WalCheckpointer({ db, logger: silentLogger() });
    expect(await ckpt.start()).toBe(true);
    expect(ckpt.active).toBe(true);
    expect(db.autoCheckpoint()).toBe(0);
    // Well past the 1000 pages after which a commit would otherwise checkpoint by itself.
    fill(db, 2500);
    const r = (await ckpt.checkpoint())!;
    expect(r).toMatchObject({ ok: true, busy: false, error: null });
    expect(r.walFrames).toBeGreaterThan(1000);
    expect(r.checkpointedFrames).toBe(r.walFrames);
    await ckpt.stop();
    expect(ckpt.active).toBe(false);
  });

  it('never makes the bot’s connection wait: a write transaction carries on during a checkpoint', async () => {
    const db = fileDb();
    const ckpt = new WalCheckpointer({ db, logger: silentLogger() });
    await ckpt.start();
    fill(db, 200);
    db.raw.exec('BEGIN IMMEDIATE');
    db.run('INSERT INTO t (v) VALUES (?)', ['during']);
    // PASSIVE takes no lock the writer holds, so it runs (and copies what was committed).
    const r = (await ckpt.checkpoint())!;
    expect(r.ok).toBe(true);
    expect(r.checkpointedFrames).toBeGreaterThan(0);
    db.run('INSERT INTO t (v) VALUES (?)', ['still writing']);
    db.raw.exec('COMMIT');
    expect(db.get<{ n: number }>('SELECT COUNT(*) AS n FROM t')!.n).toBe(202);
    await ckpt.stop();
  });

  it('still backs up everything, including what is only in the log', async () => {
    const db = fileDb();
    const ckpt = new WalCheckpointer({ db, logger: silentLogger() });
    await ckpt.start();
    fill(db, 300);
    const path = db.backup('manual')!;
    const copy = new Db(path);
    dbs.push(copy);
    expect(copy.get<{ n: number }>('SELECT COUNT(*) AS n FROM t')!.n).toBe(300);
    // A second connection (as scripts/backup.ts opens) sees the log too.
    const other = new Db(db.path);
    dbs.push(other);
    expect(other.get<{ n: number }>('SELECT COUNT(*) AS n FROM t')!.n).toBe(300);
    await ckpt.stop();
  });

  it('starts nothing for an in-memory database', async () => {
    const db = new Db(':memory:');
    dbs.push(db);
    const start = vi.fn();
    const ckpt = new WalCheckpointer({ db, logger: silentLogger(), startRunner: start });
    expect(await ckpt.start()).toBe(false);
    expect(start).not.toHaveBeenCalled();
    expect(await ckpt.checkpoint()).toBeNull();
    await ckpt.stop();
  });

  it('leaves SQLite’s own checkpoints on when the worker cannot start', async () => {
    const db = fileDb();
    const warn = vi.fn();
    const logger = { child: () => ({ warn, debug: vi.fn() }) } as unknown as ReturnType<typeof silentLogger>;
    const ckpt = new WalCheckpointer({
      db,
      logger,
      startRunner: async () => {
        throw new Error('no threads here');
      },
    });
    expect(await ckpt.start()).toBe(false);
    expect(db.autoCheckpoint()).toBe(1000);
    expect(warn).toHaveBeenCalledWith({ err: 'no threads here' }, expect.stringMatching(/main thread/));
  });

  it('runs PASSIVE checkpoints on its own connection, reporting an error rather than throwing', () => {
    const db = fileDb();
    db.setAutoCheckpoint(0);
    fill(db, 100);
    const conn = openCheckpointConnection(db.path);
    const r = conn.checkpoint();
    expect(r).toMatchObject({ ok: true, busy: false, error: null });
    expect(r.checkpointedFrames).toBe(r.walFrames);
    conn.close();
    expect(conn.checkpoint()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/finalized|not open|closed/i),
    });
  });

  it('reports a worker that fails to open the database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'radiobot-wal-'));
    dirs.push(dir);
    // A folder is not a database.
    await expect(startCheckpointWorker(dir)).rejects.toThrow();
  });
});

describe('WAL checkpoint schedule', () => {
  it('checkpoints every interval, looking at the log every 30 s', async () => {
    vi.useFakeTimers();
    const db = fileDb();
    const runner = fakeRunner();
    const ckpt = checkpointer(db, runner);
    await ckpt.start();
    await vi.advanceTimersByTimeAsync(4 * 60_000 + 30_000);
    expect(runner.calls).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runner.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runner.calls).toBe(2);
    await ckpt.stop();
    expect(runner.closed).toBe(1);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runner.calls).toBe(2);
  });

  it('checkpoints early when the log grows past the limit, but not again until it grows further', async () => {
    vi.useFakeTimers();
    const db = fileDb();
    const runner = fakeRunner();
    const size = { bytes: 1024 };
    const ckpt = checkpointer(db, runner, size);
    await ckpt.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runner.calls).toBe(0);
    size.bytes = 5 * 1024 * 1024;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runner.calls).toBe(1);
    // The file keeps its size after a checkpoint (SQLite reuses it): that alone is no reason.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runner.calls).toBe(1);
    size.bytes = 6 * 1024 * 1024;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runner.calls).toBe(2);
    await ckpt.stop();
  });

  it('runs one checkpoint at a time, and stop waits for the one running', async () => {
    vi.useFakeTimers();
    const db = fileDb();
    let finish: () => void = () => {};
    const runner = fakeRunner(
      () =>
        new Promise<CheckpointReply>((resolve) => {
          finish = () => resolve(reply());
        }),
    );
    const size = { bytes: 64 * 1024 * 1024 };
    const ckpt = checkpointer(db, runner, size);
    await ckpt.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runner.calls).toBe(1);
    const joined = ckpt.checkpoint();
    size.bytes *= 2;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(runner.calls).toBe(1);
    let stopped = false;
    const stopping = ckpt.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect((await joined)?.ok).toBe(true);
    expect(runner.closed).toBe(1);
  });

  it('hands checkpoints back to SQLite after repeated failures', async () => {
    vi.useFakeTimers();
    const db = fileDb();
    const runner = fakeRunner(async () => reply({ ok: false, error: 'disk I/O error' }));
    const ckpt = checkpointer(db, runner);
    await ckpt.start();
    expect(db.autoCheckpoint()).toBe(0);
    await ckpt.checkpoint();
    await ckpt.checkpoint();
    expect(db.autoCheckpoint()).toBe(0);
    await ckpt.checkpoint();
    expect(db.autoCheckpoint()).toBe(1000);
    expect(ckpt.active).toBe(false);
    expect(runner.closed).toBe(1);
    // Nothing more is scheduled.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(runner.calls).toBe(3);
  });

  it('hands checkpoints back to SQLite when the worker stops or a request fails', async () => {
    vi.useFakeTimers();
    const db = fileDb();
    const runner = fakeRunner();
    const ckpt = checkpointer(db, runner);
    await ckpt.start();
    runner.alive = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(db.autoCheckpoint()).toBe(1000);
    expect(runner.calls).toBe(0);

    const db2 = fileDb();
    const failing = fakeRunner(async () => {
      failing.alive = false;
      throw new Error('checkpoint worker exited with code 1');
    });
    const ckpt2 = checkpointer(db2, failing);
    await ckpt2.start();
    expect(await ckpt2.checkpoint()).toBeNull();
    expect(db2.autoCheckpoint()).toBe(1000);
  });
});
