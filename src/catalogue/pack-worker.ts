/**
 * Checks packs on a worker thread (see `checkBundleInWorker` and `loadPackInWorker` in
 * pack-manager.ts). Validating a pack of a couple of thousand stations takes tens of milliseconds,
 * which on the main thread would hold up voice packets; only the checked pack comes back (of a
 * bundle, only what installing it needs). The work itself is in pack-worker-job.ts.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { lowerThreadPriority } from '../shared/lower-thread-priority.ts';
import { type PackWorkerRequest, runPackJob } from './pack-worker-job.ts';

lowerThreadPriority();
const { reply, transfer } = runPackJob(workerData as PackWorkerRequest);
parentPort!.postMessage(reply, transfer);
