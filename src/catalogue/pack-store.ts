import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { InstallableBundle } from './pack-library.ts';
import { PACK_ID } from './packs.ts';

/**
 * The installed-packs folder: packs downloaded from a pack library, one folder per pack, inside
 * the bot's data directory (next to the database), so they survive updates. Backups hold only the
 * database; after a restore on a new machine the bot downloads the packs it uses again at start-up
 * (PackManager.restoreMissing). A small record file says where each came from:
 *
 *   <data>/installed-packs/<pack-id>/{pack.json,stations.json,sources.json}
 *   <data>/installed-packs/installed.json
 *
 * Both the bot and the `radio-bot packs` command write here. Each install is written to a hidden
 * folder first and then renamed into place, so a half-written pack is never loaded (folders
 * starting with "." are ignored by the loader).
 */

export function installedPacksDir(databasePath: string): string | null {
  if (databasePath === ':memory:') return null;
  return join(dirname(resolve(databasePath)), 'installed-packs');
}

const RECORD_FILE = 'installed.json';

const recordSchema = z.object({
  schemaVersion: z.literal(1),
  packs: z
    .record(
      z.string(),
      z.object({
        version: z.string().nullable(),
        /** "official", another library's index URL, or a file path. */
        source: z.string(),
        sha256: z.string().nullable(),
        installedAt: z.string(),
      }),
    )
    .default({}),
  /** Packs someone removed on purpose: never restored automatically. */
  removed: z.array(z.string()).default([]),
});
export type InstalledRecord = z.infer<typeof recordSchema>;
export type InstalledEntry = InstalledRecord['packs'][string];

export class PackStore {
  readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** The record file; a missing or damaged one reads as empty (the folders are what loads). */
  async readRecord(): Promise<InstalledRecord> {
    try {
      const r = recordSchema.safeParse(JSON.parse(await readFile(join(this.dir, RECORD_FILE), 'utf8')));
      if (r.success) return r.data;
    } catch {
      // Missing or not JSON: start again.
    }
    return { schemaVersion: 1, packs: {}, removed: [] };
  }

  async #writeRecord(record: InstalledRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tmp = join(this.dir, `.${RECORD_FILE}.${randomBytes(4).toString('hex')}`);
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`);
    await rename(tmp, join(this.dir, RECORD_FILE));
  }

  packDir(id: string): string {
    if (!PACK_ID.test(id)) throw new Error(`"${id}" is not a pack id`);
    return join(this.dir, id);
  }

  has(id: string): boolean {
    return existsSync(join(this.packDir(id), 'pack.json'));
  }

  /** Writes a checked bundle as a pack folder, replacing any older copy, and records it. */
  async install(bundle: InstallableBundle, source: string, now: Date = new Date()): Promise<string> {
    const id = bundle.pack.meta.id;
    const target = this.packDir(id);
    const tag = randomBytes(4).toString('hex');
    const staging = join(this.dir, `.new-${id}-${tag}`);
    const old = join(this.dir, `.old-${id}-${tag}`);
    await mkdir(staging, { recursive: true });
    try {
      for (const [name, text] of Object.entries(bundle.files)) {
        if (text !== null) await writeFile(join(staging, name), text);
      }
      if (existsSync(target)) await rename(target, old);
      await rename(staging, target);
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      if (existsSync(old) && !existsSync(target)) await rename(old, target);
      throw err;
    }
    await rm(old, { recursive: true, force: true });
    const record = await this.readRecord();
    record.packs[id] = {
      version: bundle.pack.meta.version,
      source,
      sha256: bundle.sha256,
      installedAt: now.toISOString(),
    };
    record.removed = record.removed.filter((r) => r !== id);
    await this.#writeRecord(record);
    return target;
  }

  /**
   * Deletes an installed pack's folder. `byRequest` (someone removed it) also marks it as removed,
   * so it isn't restored automatically; a pack withdrawn from its library is not marked.
   */
  async remove(id: string, byRequest = true): Promise<boolean> {
    const target = this.packDir(id);
    const existed = existsSync(target);
    if (existed) {
      const gone = join(this.dir, `.gone-${id}-${randomBytes(4).toString('hex')}`);
      await rename(target, gone);
      await rm(gone, { recursive: true, force: true });
    }
    const record = await this.readRecord();
    delete record.packs[id];
    if (byRequest && !record.removed.includes(id)) record.removed.push(id);
    await this.#writeRecord(record);
    return existed;
  }
}
