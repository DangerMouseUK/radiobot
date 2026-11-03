import { existsSync } from 'node:fs';
import type { Logger } from '../observability/logger.ts';
import { safeErr } from '../observability/logger.ts';
import type { StationRepository } from '../persistence/repositories/stations.ts';
import { RadioError } from '../shared/errors.ts';
import { botVersion, compareVersions } from '../shared/version.ts';
import { ownBuffer, runWorker, siblingModule } from '../shared/workers.ts';
import type { SafeHttpClient } from '../streams/safe-fetch.ts';
import {
  type CheckedBundle,
  fetchBundleBytes,
  fetchLibraryIndex,
  type LibraryIndex,
  type LibraryPack,
  OFFICIAL_LIBRARY_URL,
  tooNewFor,
} from './pack-library.ts';
import type { PackStore } from './pack-store.ts';
import type { PackWorkerRequest } from './pack-worker.ts';
import {
  discoverPackDirs,
  PACK_ID,
  type PackRegistry,
  packConflict,
  type StationPack,
  seedPackInSlices,
} from './packs.ts';

type WorkerReply<T> = { ok: true; result: T } | { ok: false; error: string };

async function packWorker<T>(req: PackWorkerRequest, signal?: AbortSignal): Promise<T> {
  const reply = await runWorker<WorkerReply<T>>(siblingModule(import.meta.url, 'pack-worker'), req, {
    timeoutMs: 30_000,
    signal,
    resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 },
    transfer: req.kind === 'bundle' ? ownBuffer(req.bytes) : [],
  });
  if (!reply.ok) throw new RadioError('PACK_INVALID', reply.error);
  return reply.result;
}

/** Checks a downloaded bundle on a worker thread. */
export const checkBundleInWorker = (bytes: Uint8Array, entry: LibraryPack, signal?: AbortSignal) =>
  packWorker<CheckedBundle>({ kind: 'bundle', bytes, id: entry.id, sha256: entry.sha256 }, signal);

/** Loads an installed pack folder on a worker thread. */
export const loadPackInWorker = (dir: string, signal?: AbortSignal) =>
  packWorker<StationPack>({ kind: 'dir', dir }, signal);

export interface PackChange {
  id: string;
  name: string;
  version: string | null;
  previousVersion: string | null;
  stations: number;
}

export interface PackManagerDeps {
  registry: PackRegistry;
  /** Null when the bot has no data folder (an in-memory database): nothing can be installed. */
  store: PackStore | null;
  stations: StationRepository;
  transaction: <T>(fn: () => T) => T;
  http: SafeHttpClient;
  logger: Logger;
  /** Runs a job with the bot's other background work: one at a time, never while a stream starts. */
  background: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Called after packs were added, replaced or removed (re-plan syncs, refresh views). */
  onChange: () => void;
  /** Called when a pack is removed or withdrawn, so anything playing its stations stops. */
  onGone: (packId: string) => void;
  /** Tests point this at a local library. */
  libraryUrl?: string;
  now?: () => number;
}

/** How long a downloaded index is reused before asking the library again. */
const INDEX_TTL_MS = 10 * 60_000;

/**
 * Installs, updates and removes packs from the official library while the bot runs, and puts back
 * packs an installation already uses when they're missing (after an update moved a bundled pack
 * into the library, or a backup was restored on a new machine).
 *
 * Everything heavy stays off the voice thread: downloads are network waits, checks run on a worker
 * thread, and the database is written in small slices (`seedPackInSlices`). Installs and updates
 * run as background jobs, so they wait for streams that are starting.
 */
export class PackManager {
  readonly #d: PackManagerDeps;
  readonly #url: string;
  readonly #now: () => number;
  #index: { at: number; value: LibraryIndex } | null = null;
  /** Newer versions in the library, by pack id, from the last check. */
  readonly updates = new Map<string, string>();
  /** Things an admin should know (a pack withdrawn from the library), newest first, at most 10. */
  readonly notices: string[] = [];

  constructor(deps: PackManagerDeps) {
    this.#d = deps;
    this.#url = deps.libraryUrl ?? OFFICIAL_LIBRARY_URL;
    this.#now = deps.now ?? Date.now;
  }

  get canInstall(): boolean {
    return this.#d.store !== null;
  }

  /** The official library's index, from memory if fetched in the last ten minutes. */
  async index(force = false, signal?: AbortSignal): Promise<LibraryIndex> {
    if (!force && this.#index && this.#now() - this.#index.at < INDEX_TTL_MS) return this.#index.value;
    const value = await fetchLibraryIndex(this.#d.http, this.#url, signal);
    this.#index = { at: this.#now(), value };
    this.#noteUpdates(value);
    return value;
  }

  /** The cached index, if there is one (for views that shouldn't wait for the network). */
  cachedIndex(): LibraryIndex | null {
    return this.#index?.value ?? null;
  }

  #noteUpdates(index: LibraryIndex): void {
    this.updates.clear();
    for (const entry of index.packs) {
      const loaded = this.#d.registry.get(entry.id);
      if (entry.status !== 'available' || loaded?.origin !== 'installed') continue;
      if (!loaded.meta.version || compareVersions(entry.version, loaded.meta.version) > 0)
        this.updates.set(entry.id, entry.version);
    }
  }

  #store(): PackStore {
    if (!this.#d.store)
      throw new RadioError('INTERNAL', 'This bot has no data folder, so it can’t install station packs.');
    return this.#d.store;
  }

  /** Installs a pack from the official library, or updates it. Runs as a background job. */
  install(id: string, signal?: AbortSignal): Promise<PackChange> {
    return this.#d.background(async () => {
      const index = await this.index(false, signal);
      const entry = index.packs.find((p) => p.id === id);
      if (entry?.status !== 'available')
        throw new RadioError('NOT_FOUND', `The pack library has no pack called "${id}".`);
      return this.#installEntry(entry, signal);
    });
  }

  async #installEntry(entry: LibraryPack, signal?: AbortSignal): Promise<PackChange> {
    const store = this.#store();
    const loaded = this.#d.registry.get(entry.id);
    if (loaded && loaded.origin !== 'installed') {
      throw new RadioError(
        'PACK_INVALID',
        `A pack called "${entry.id}" is already loaded from ${loaded.origin === 'extra' ? 'EXTRA_PACKS_DIR' : 'the bot itself'}, so it can’t be installed from the library too.`,
      );
    }
    // Asked before downloading: the bundle check would refuse it anyway.
    const tooNew = tooNewFor(entry, botVersion());
    if (tooNew) throw new RadioError('PACK_INVALID', tooNew);
    const bytes = await fetchBundleBytes(this.#d.http, entry, this.#url, signal);
    const checked = await checkBundleInWorker(bytes, entry, signal);
    // Checked again before writing: another pack may use one of its source ids.
    const conflict = packConflict(
      this.#d.registry.packs,
      {
        ...checked.pack,
        dir: store.packDir(entry.id),
        origin: 'installed',
        contentHash: '',
      },
      { replacing: true },
    );
    if (conflict) throw new RadioError('PACK_INVALID', conflict);
    const dir = await store.install(checked, 'official');
    const pack = await loadPackInWorker(dir, signal);
    await this.#activate(pack);
    this.updates.delete(entry.id);
    this.#d.logger.info(
      { pack: pack.meta.id, version: pack.meta.version, previous: loaded?.meta.version ?? null },
      loaded ? 'station pack updated' : 'station pack installed',
    );
    return {
      id: pack.meta.id,
      name: pack.meta.name,
      version: pack.meta.version,
      previousVersion: loaded?.meta.version ?? null,
      stations: pack.stations.length,
    };
  }

  /** Writes a loaded pack's stations (in slices) and then makes it visible. */
  async #activate(pack: StationPack): Promise<void> {
    await seedPackInSlices(this.#d.stations, this.#d.transaction, pack);
    this.#d.registry.put(pack);
    this.#d.onChange();
  }

  /** Removes an installed pack. Its stations are hidden; favourites come back if it's reinstalled. */
  remove(id: string): Promise<boolean> {
    return this.#d.background(async () => {
      const loaded = this.#d.registry.get(id);
      if (loaded && loaded.origin !== 'installed')
        throw new RadioError(
          'PACK_INVALID',
          `"${id}" wasn’t installed from a library (it comes from ${loaded.origin === 'extra' ? 'EXTRA_PACKS_DIR' : 'the bot itself'}), so it can’t be removed here.`,
        );
      const existed = await this.#store().remove(id, true);
      const dropped = this.#d.registry.drop(id);
      this.updates.delete(id);
      if (dropped) {
        this.#d.onGone(id);
        this.#d.onChange();
      }
      this.#d.logger.info({ pack: id }, 'station pack removed');
      return existed || dropped;
    });
  }

  /**
   * Reads the installed-packs folder again (after `radio-bot packs` changed it): loads new and
   * changed packs, unloads removed ones. Runs as a background job.
   */
  reload(signal?: AbortSignal): Promise<{ loaded: string[]; removed: string[]; skipped: string[] }> {
    return this.#d.background(async () => {
      const store = this.#store();
      const out = { loaded: [] as string[], removed: [] as string[], skipped: [] as string[] };
      const seen = new Set<string>();
      for (const dir of discoverPackDirs(store.dir)) {
        let pack: StationPack;
        try {
          pack = await loadPackInWorker(dir, signal);
        } catch (err) {
          this.#skip(dir, (err as Error).message);
          out.skipped.push(dir);
          continue;
        }
        seen.add(pack.meta.id);
        const current = this.#d.registry.get(pack.meta.id);
        if (current?.contentHash === pack.contentHash && current.dir === pack.dir) continue;
        const conflict =
          current && current.origin !== 'installed'
            ? `A pack called "${pack.meta.id}" is already loaded from ${current.origin === 'extra' ? 'EXTRA_PACKS_DIR' : 'the bot itself'}`
            : packConflict(this.#d.registry.packs, pack, { replacing: true });
        if (conflict) {
          this.#skip(dir, conflict);
          out.skipped.push(dir);
          continue;
        }
        await this.#activate(pack);
        out.loaded.push(pack.meta.id);
      }
      for (const p of [...this.#d.registry.packs]) {
        if (p.origin === 'installed' && !seen.has(p.meta.id) && !existsSync(p.dir)) {
          this.#d.registry.drop(p.meta.id);
          this.#d.onGone(p.meta.id);
          out.removed.push(p.meta.id);
        }
      }
      if (out.removed.length) this.#d.onChange();
      this.#d.logger.info(out, 'installed station packs reloaded');
      return out;
    });
  }

  #skip(dir: string, reason: string): void {
    const r = this.#d.registry;
    r.skipped = [...r.skipped.filter((s) => s.dir !== dir), { dir, reason }];
    this.#d.logger.warn({ dir, reason }, 'installed station pack skipped');
  }

  /**
   * Puts back packs this installation already uses (its database has their stations) but that
   * aren't loaded, from the official library: after an update stops bundling a pack, or a backup
   * is restored on a new machine. Packs someone removed on purpose stay removed. Called at start-up
   * before anything plays; a library that can't be reached is tried again at the next check.
   */
  async restoreMissing(signal?: AbortSignal): Promise<string[]> {
    if (!this.#d.store) return [];
    const record = await this.#d.store.readRecord();
    const missing = this.#d.stations
      .providerIds()
      .filter((p) => PACK_ID.test(p) && !this.#d.registry.get(p) && !record.removed.includes(p));
    if (missing.length === 0) return [];
    let index: LibraryIndex;
    try {
      index = await this.index(true, signal);
    } catch (err) {
      this.#d.logger.warn(
        { err: safeErr(err), missing },
        'could not reach the pack library to restore missing station packs; will try again later',
      );
      return [];
    }
    const restored: string[] = [];
    for (const id of missing) {
      const entry = index.packs.find((p) => p.id === id && p.status === 'available');
      if (!entry) continue;
      try {
        await this.#installEntry(entry, signal);
        restored.push(id);
      } catch (err) {
        this.#d.logger.warn({ err: safeErr(err), pack: id }, 'could not restore a missing station pack');
      }
    }
    if (restored.length) this.#d.logger.info({ restored }, 'restored station packs from the pack library');
    return restored;
  }

  /**
   * The daily check: notes newer versions (an admin installs them), removes official packs the
   * library has withdrawn, and retries restoring missing packs. Runs as a background job.
   */
  check(signal?: AbortSignal): Promise<void> {
    return this.#d.background(async () => {
      if (!this.#d.store) return;
      const index = await this.index(true, signal);
      const record = await this.#d.store.readRecord();
      for (const entry of index.packs) {
        const loaded = this.#d.registry.get(entry.id);
        if (entry.status !== 'withdrawn' || loaded?.origin !== 'installed') continue;
        if (record.packs[entry.id]?.source !== 'official') continue;
        await this.#d.store.remove(entry.id, false);
        this.#d.registry.drop(entry.id);
        this.#d.onGone(entry.id);
        this.#d.onChange();
        const why = entry.withdrawnReason ? ` (${entry.withdrawnReason})` : '';
        this.#notice(
          `**${loaded.meta.name}** was withdrawn from the pack library${why} and has been removed.`,
        );
        this.#d.logger.warn(
          { pack: entry.id, reason: entry.withdrawnReason },
          'station pack withdrawn and removed',
        );
      }
      await this.restoreMissing(signal);
    });
  }

  #notice(text: string): void {
    this.notices.unshift(text);
    this.notices.length = Math.min(this.notices.length, 10);
  }
}
