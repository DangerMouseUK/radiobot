/**
 * Checks packs on a worker thread (see `checkBundleInWorker` and `loadPackInWorker` in
 * pack-manager.ts). Validating a pack of a couple of thousand stations takes tens of milliseconds,
 * which on the main thread would hold up voice packets; only the checked pack comes back (of a
 * bundle, only what installing it needs).
 */
import { parentPort, workerData } from 'node:worker_threads';
import { isRadioError } from '../shared/errors.ts';
import { checkBundle, installable } from './pack-library.ts';
import { loadPack, type StationPack } from './packs.ts';

export type PackWorkerRequest =
  | { kind: 'bundle'; bytes: Uint8Array; id: string; sha256: string | null }
  | { kind: 'dir'; dir: string };

/**
 * A loaded pack with its stations and sources as JSON text, a chunk at a time: text crosses to
 * the main thread as a plain copy, and each chunk is parsed there in a turn of its own. Copying
 * thousands of rows as objects would hold the main thread up for over 10 ms in one go.
 */
export interface ChunkedPack {
  /** Its `stations` and `sources` are empty: they are in the chunks. */
  pack: StationPack;
  stations: string[];
  sources: string[];
}

/** Rows per chunk: a few hundred parse in well under a millisecond. */
const CHUNK_ROWS = 250;

function chunked(pack: StationPack): ChunkedPack {
  const json = (rows: readonly unknown[]) => {
    const out: string[] = [];
    for (let i = 0; i < rows.length; i += CHUNK_ROWS) out.push(JSON.stringify(rows.slice(i, i + CHUNK_ROWS)));
    return out;
  };
  return {
    pack: { ...pack, stations: [], sources: [] },
    stations: json(pack.stations),
    sources: json(pack.sources),
  };
}

const req = workerData as PackWorkerRequest;
try {
  parentPort!.postMessage({
    ok: true,
    result:
      req.kind === 'bundle'
        ? installable(checkBundle(req.bytes, req))
        : chunked(loadPack(req.dir, 'installed')),
  });
} catch (err) {
  const error = isRadioError(err) ? err.userMessage : err instanceof Error ? err.message : String(err);
  parentPort!.postMessage({ ok: false, error });
}
