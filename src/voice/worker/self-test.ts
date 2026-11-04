import { getHeapStatistics } from 'node:v8';
import { DAVE_PROTOCOL_VERSION, DAVESession } from '@snazzah/davey';
import type { SelfTestResult } from './protocol.ts';

/** A made-up ID of the kind the docs and tests use (never a real user or channel). */
const FAKE_ID = '123456789012345678';

/**
 * Checks, without any network, that the voice worker can do its job: the DAVE native library
 * loads in this thread and creates a session (a native addon that cannot run in a worker thread
 * fails here, at start-up or in the smoke test, rather than at the first join).
 */
export function voiceSelfTest(
  createSession: (version: number) => { protocolVersion: number } = (version) =>
    new DAVESession(version, FAKE_ID, FAKE_ID),
): SelfTestResult {
  const heapUsedMb = () => Math.round((getHeapStatistics().used_heap_size / (1024 * 1024)) * 10) / 10;
  try {
    const ok = createSession(DAVE_PROTOCOL_VERSION).protocolVersion === DAVE_PROTOCOL_VERSION;
    return { ok, daveProtocolVersion: DAVE_PROTOCOL_VERSION, heapUsedMb: heapUsedMb(), error: null };
  } catch (err) {
    return {
      ok: false,
      daveProtocolVersion: null,
      heapUsedMb: heapUsedMb(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
