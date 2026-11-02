import { type ResourceLimits, Worker } from 'node:worker_threads';
import { RadioError } from './errors.ts';

/**
 * The URL of the worker module `name` next to the module at `moduleUrl`, with that module's own
 * extension: `.ts` when Node runs the source (and in tests), `.js` in the compiled build.
 */
export function siblingModule(moduleUrl: string, name: string): URL {
  const ext = new URL(moduleUrl).pathname.endsWith('.ts') ? '.ts' : '.js';
  return new URL(`./${name}${ext}`, moduleUrl);
}

export interface RunWorkerOptions {
  /** The worker is stopped, and the promise rejected, if it hasn't answered by then. */
  timeoutMs: number;
  signal?: AbortSignal;
  resourceLimits?: ResourceLimits;
  /** Buffers in `data` handed over to the worker rather than copied (they are unusable afterwards). */
  transfer?: ArrayBuffer[];
}

/**
 * The buffer to hand a worker for `bytes` without copying, if `bytes` has one of its own: copying
 * megabytes into a new worker takes milliseconds on the main thread. Small Buffers share Node's
 * pool, which must never be handed over, so they are copied (which costs next to nothing).
 */
export function ownBuffer(bytes: Uint8Array): ArrayBuffer[] {
  const buf = bytes.buffer;
  return buf instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === buf.byteLength
    ? [buf]
    : [];
}

/**
 * Runs a one-off job on a worker thread: starts the worker with `data`, resolves with the first
 * message it sends back and then stops it. Work that would hold up the main thread (parsing a large
 * page, say) runs there, so voice packets keep leaving on time.
 */
export function runWorker<T>(url: URL, data: unknown, o: RunWorkerOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (o.signal?.aborted) {
      reject(new RadioError('CANCELLED', 'The job was cancelled.'));
      return;
    }
    const worker = new Worker(url, {
      workerData: data,
      resourceLimits: o.resourceLimits,
      transferList: o.transfer,
    });
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      void worker.terminate();
      fn();
    };
    const onAbort = () => finish(() => reject(new RadioError('CANCELLED', 'The job was cancelled.')));
    const timer = setTimeout(
      () =>
        finish(() => reject(new RadioError('INTERNAL', 'A background job took too long and was stopped.'))),
      o.timeoutMs,
    );
    o.signal?.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (msg: T) => finish(() => resolve(msg)));
    worker.once('error', (err) => finish(() => reject(err)));
    worker.once('exit', (code) =>
      finish(() =>
        reject(new RadioError('INTERNAL', `A background job stopped unexpectedly (exit code ${code}).`)),
      ),
    );
  });
}
