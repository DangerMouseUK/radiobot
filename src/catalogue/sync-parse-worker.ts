/**
 * Reads an official station list on a worker thread (see `parseOfficialListInWorker` in sync.ts).
 * A list page can be several megabytes, and parsing it on the main thread would hold up voice
 * packets; only the short list of names and IDs comes back.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { type ParseRequest, parseOfficialList } from './sync-adapters.ts';

parentPort!.postMessage(parseOfficialList(workerData as ParseRequest));
