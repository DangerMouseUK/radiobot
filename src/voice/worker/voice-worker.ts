/**
 * The voice worker: runs every voice connection, player and Ogg demuxer on a thread of its own
 * (see `VoiceHost`), started by `VoiceThread` on the main thread. It never writes to the console;
 * its log lines go to the main thread's logger.
 */
import { parentPort } from 'node:worker_threads';
import { VoiceHost } from './host.ts';
import { serializeError } from './protocol.ts';
import { voiceSelfTest } from './self-test.ts';
import { LoopTelemetry } from './telemetry.ts';

const host = new VoiceHost({
  port: parentPort!,
  telemetry: new LoopTelemetry(),
  selfTest: () => voiceSelfTest(),
});
// As on the main thread: logged, not fatal (an uncaught exception ends the worker, which restarts).
process.on('unhandledRejection', (err) => {
  host.log('error', 'unhandled rejection in the voice worker', { err: serializeError(err) });
});
