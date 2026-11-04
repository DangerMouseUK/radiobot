/**
 * Runs the database's WAL checkpoints on a worker thread with its own SQLite connection (see
 * `WalCheckpointer` in checkpoint.ts), so they never hold up the thread that sends voice packets.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { lowerThreadPriority } from '../shared/lower-thread-priority.ts';
import { type CheckpointMessage, type CheckpointRequest, openCheckpointConnection } from './checkpoint.ts';

lowerThreadPriority();
const port = parentPort!;
const connection = openCheckpointConnection((workerData as { path: string }).path);
port.on('message', (msg: CheckpointRequest) => {
  if (msg.type === 'close') {
    connection.close();
    port.close();
    return;
  }
  port.postMessage({ type: 'result', reply: connection.checkpoint() } satisfies CheckpointMessage);
});
port.postMessage({ type: 'ready' } satisfies CheckpointMessage);
