import { describe, expect, it } from 'vitest';
import { timeSlicer } from '../../src/shared/async.ts';
import { ownBuffer, runWorker, siblingModule } from '../../src/shared/workers.ts';

/** A worker made from source text, so these tests need no file of their own. */
const inline = (code: string) => new URL(`data:text/javascript,${encodeURIComponent(code)}`);
const ANSWERS = inline(
  "import { parentPort, workerData } from 'node:worker_threads'; parentPort.postMessage(workerData * 2);",
);

describe('siblingModule', () => {
  it('keeps the extension of the module asking: .ts from source, .js when built', () => {
    expect(siblingModule('file:///app/src/catalogue/sync.ts', 'sync-parse-worker').href).toBe(
      'file:///app/src/catalogue/sync-parse-worker.ts',
    );
    expect(siblingModule('file:///app/dist/src/catalogue/sync.js', 'sync-parse-worker').href).toBe(
      'file:///app/dist/src/catalogue/sync-parse-worker.js',
    );
  });
});

describe('runWorker', () => {
  it('resolves with the first message the worker sends', async () => {
    expect(await runWorker<number>(ANSWERS, 21, { timeoutMs: 10_000 })).toBe(42);
  });

  it('hands a large buffer over without copying, but never a slice of Node’s shared pool', async () => {
    const large = Buffer.allocUnsafe(64 * 1024);
    expect(ownBuffer(large)).toEqual([large.buffer]);
    const pooled = Buffer.from('a short list');
    expect(ownBuffer(pooled)).toEqual([]);
    expect(ownBuffer(new Uint8Array(new SharedArrayBuffer(8)))).toEqual([]);
    const length = inline(
      "import { parentPort, workerData } from 'node:worker_threads'; parentPort.postMessage(workerData.byteLength);",
    );
    expect(await runWorker(length, large, { timeoutMs: 10_000, transfer: ownBuffer(large) })).toBe(64 * 1024);
    // Moved, not copied: the sender's view is now empty.
    expect(large.byteLength).toBe(0);
  });

  it('stops a worker that takes too long', async () => {
    const forever = inline('setInterval(() => {}, 1000);');
    await expect(runWorker(forever, null, { timeoutMs: 100 })).rejects.toThrow(/took too long/);
  });

  it('rejects when the worker fails or exits without answering', async () => {
    await expect(
      runWorker(inline("throw new Error('broken');"), null, { timeoutMs: 10_000 }),
    ).rejects.toThrow('broken');
    await expect(runWorker(inline('process.exit(3);'), null, { timeoutMs: 10_000 })).rejects.toThrow(
      /exit code 3/,
    );
  });

  it('can be cancelled before it starts or while it runs', async () => {
    const before = new AbortController();
    before.abort();
    await expect(runWorker(ANSWERS, 1, { timeoutMs: 10_000, signal: before.signal })).rejects.toMatchObject({
      code: 'CANCELLED',
    });
    const during = new AbortController();
    const running = runWorker(inline('setInterval(() => {}, 1000);'), null, {
      timeoutMs: 10_000,
      signal: during.signal,
    });
    during.abort();
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('timeSlicer', () => {
  it('gives the event loop a turn only once the budget is spent', async () => {
    let clock = 0;
    const slice = timeSlicer(4, () => clock);
    let turns = 0;
    const counter = setImmediate(() => turns++);
    clock = 3;
    await slice();
    expect(turns).toBe(0);
    clock = 4;
    await slice();
    expect(turns).toBe(1);
    // The budget starts again after a turn.
    clock = 7;
    await slice();
    clearImmediate(counter);
    expect(turns).toBe(1);
  });
});
