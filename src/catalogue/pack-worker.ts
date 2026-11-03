/**
 * Checks packs on a worker thread (see `checkBundleInWorker` and `loadPackInWorker` in
 * pack-manager.ts). Validating a pack of a couple of thousand stations takes tens of milliseconds,
 * which on the main thread would hold up voice packets; only the checked pack comes back.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { isRadioError } from '../shared/errors.ts';
import { checkBundle } from './pack-library.ts';
import { loadPack } from './packs.ts';

export type PackWorkerRequest =
  | { kind: 'bundle'; bytes: Uint8Array; id: string; sha256: string | null }
  | { kind: 'dir'; dir: string };

const req = workerData as PackWorkerRequest;
try {
  parentPort!.postMessage({
    ok: true,
    result: req.kind === 'bundle' ? checkBundle(req.bytes, req) : loadPack(req.dir, 'installed'),
  });
} catch (err) {
  const error = isRadioError(err) ? err.userMessage : err instanceof Error ? err.message : String(err);
  parentPort!.postMessage({ ok: false, error });
}
