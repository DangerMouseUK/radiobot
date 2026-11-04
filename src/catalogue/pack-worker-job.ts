/**
 * What the pack worker thread does (pack-worker.ts runs it; see `checkBundleInWorker`,
 * `loadPackInWorker` and `reloadPackInWorker` in pack-manager.ts), kept apart so it can be tested
 * without a thread.
 */
import { isRadioError } from '../shared/errors.ts';
import { checkBundle, installable, installableTransfer } from './pack-library.ts';
import { loadPack, packFolderHash, type StationPack } from './packs.ts';

export type PackWorkerRequest =
  | { kind: 'bundle'; bytes: Uint8Array; id: string; sha256: string | null }
  /** With `unlessHash`, a folder whose files still have that hash isn't loaded at all. */
  | { kind: 'dir'; dir: string; unlessHash?: string | null };

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

/** A folder whose files haven't changed since it was last loaded (`unlessHash`). */
export interface UnchangedPack {
  unchanged: true;
}

export type PackWorkerReply = { ok: true; result: unknown } | { ok: false; error: string };

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

/**
 * Answers one request: the reply to post, and the buffers to hand over with it. Never throws. A
 * folder is hashed before anything is parsed, so a reload of an unchanged pack costs a read.
 */
export function runPackJob(
  req: PackWorkerRequest,
  load: (dir: string, origin: 'installed') => StationPack = loadPack,
): { reply: PackWorkerReply; transfer: ArrayBuffer[] } {
  try {
    if (req.kind === 'bundle') {
      const bundle = installable(checkBundle(req.bytes, req));
      return { reply: { ok: true, result: bundle }, transfer: installableTransfer(bundle) };
    }
    if (req.unlessHash && packFolderHash(req.dir) === req.unlessHash) {
      return { reply: { ok: true, result: { unchanged: true } satisfies UnchangedPack }, transfer: [] };
    }
    return { reply: { ok: true, result: chunked(load(req.dir, 'installed')) }, transfer: [] };
  } catch (err) {
    const error = isRadioError(err) ? err.userMessage : err instanceof Error ? err.message : String(err);
    return { reply: { ok: false, error }, transfer: [] };
  }
}
