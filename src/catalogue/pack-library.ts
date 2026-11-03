import { createHash } from 'node:crypto';
import { z } from 'zod';
import { RadioError } from '../shared/errors.ts';
import { compareText } from '../shared/text.ts';
import { compareVersions } from '../shared/version.ts';
import type { SafeHttpClient } from '../streams/safe-fetch.ts';
import {
  PACK_ID,
  PACK_OWNER_KINDS,
  PACK_VERSION,
  type PackFiles,
  parsePack,
  type StationPack,
} from './packs.ts';

/**
 * Pack libraries: where packs are downloaded from. A library publishes one `index.json` that
 * describes every pack, and one bundle file per pack holding that pack's three files:
 *
 *   index.json   { schemaVersion, generatedAt, packs: [...], collections: [...] }
 *   <id>.json    { schemaVersion, pack, stations, sources }   (the parsed pack.json, stations.json, sources.json)
 *
 * The index gives each bundle's address and SHA-256, so a download that was altered or cut short
 * is refused. Every download goes through SafeHttpClient, and every bundle is checked with the
 * same rules as a pack folder (`parsePack`) before it is written anywhere.
 *
 * Discord installs only from the official library; its address is fixed here and can't be
 * configured. The `radio-bot packs` command (scripts/packs.ts) may name another library with --from.
 */
export const OFFICIAL_LIBRARY_URL =
  'https://github.com/DangerMouseUK/radiobot-packs/releases/latest/download/index.json';
export const OFFICIAL_LIBRARY_NAME = 'the official Radio Bot pack library';

/** Limits on what a library may send. */
export const MAX_INDEX_BYTES = 2 * 1024 * 1024;
export const MAX_BUNDLE_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

const SHA256 = /^[0-9a-f]{64}$/;

const indexPackSchema = z.object({
  id: z.string().regex(PACK_ID),
  name: z.string().min(1).max(80),
  description: z.string().max(500).default(''),
  version: z.string().regex(PACK_VERSION),
  owner: z
    .object({
      name: z.string().min(1).max(100),
      kind: z.enum(PACK_OWNER_KINDS),
      brand: z.string().min(1).max(100).nullable().default(null),
    })
    .nullable()
    .default(null),
  countries: z.array(z.string().max(2)).max(50).default([]),
  regions: z.array(z.string().max(60)).max(50).default([]),
  languages: z.array(z.string().max(20)).max(20).default([]),
  stations: z.number().int().min(0),
  sources: z.number().int().min(0),
  /** When the pack's streams were last checked by a person (YYYY-MM-DD), if known. */
  lastChecked: z.string().max(10).nullable().default(null),
  minBotVersion: z.string().max(20).nullable().default(null),
  /** `withdrawn`: removed from the library (at its owner's request, for example); installs remove it too. */
  status: z.enum(['available', 'withdrawn']).default('available'),
  withdrawnReason: z.string().max(300).nullable().default(null),
  /** The bundle's address, absolute or relative to the index. Absent for a withdrawn pack. */
  file: z.string().max(500).nullable().default(null),
  sha256: z.string().regex(SHA256).nullable().default(null),
  bytes: z.number().int().min(0).max(MAX_BUNDLE_BYTES).nullable().default(null),
});

const collectionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().min(1).max(80),
  description: z.string().max(300).default(''),
  packs: z.array(z.string().regex(PACK_ID)).max(500),
});

export const libraryIndexSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string().max(40),
  packs: z.array(indexPackSchema).max(5000),
  collections: z.array(collectionSchema).max(500).default([]),
});

export type LibraryIndex = z.infer<typeof libraryIndexSchema>;
export type LibraryPack = z.infer<typeof indexPackSchema>;
export type LibraryCollection = z.infer<typeof collectionSchema>;

export const packBundleSchema = z.object({
  schemaVersion: z.literal(1),
  pack: z.unknown(),
  stations: z.unknown(),
  sources: z.unknown().optional(),
});
export type PackBundle = z.infer<typeof packBundleSchema>;

/** Parses an index's text, with a plain-English error when it isn't one. */
export function parseLibraryIndex(text: string): LibraryIndex {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RadioError('PACK_INVALID', 'The pack library sent something that is not a pack list.');
  }
  const r = libraryIndexSchema.safeParse(raw);
  if (!r.success) {
    const where = r.error.issues[0]?.path.join('.') || 'the list';
    throw new RadioError('PACK_INVALID', `The pack library's list is not valid (at ${where}).`);
  }
  return r.data;
}

/** Downloads and checks a library's index. */
export async function fetchLibraryIndex(
  http: SafeHttpClient,
  url: string = OFFICIAL_LIBRARY_URL,
  signal?: AbortSignal,
): Promise<LibraryIndex> {
  const { text } = await http.fetchText(url, {
    maxBytes: MAX_INDEX_BYTES,
    totalTimeoutMs: TIMEOUT_MS,
    headers: { accept: 'application/json' },
    signal,
  });
  return parseLibraryIndex(text);
}

/** Why this bot can't use a library entry (it needs a newer Radio Bot), or null if it can. */
export function tooNewFor(entry: LibraryPack, version: string): string | null {
  if (!entry.minBotVersion || compareVersions(version, entry.minBotVersion) >= 0) return null;
  return `"${entry.id}" needs Radio Bot ${entry.minBotVersion} or later (this is ${version}). Update the bot first.`;
}

/** The bundle address of an index entry, resolved against the index's own address. */
export function bundleUrl(entry: LibraryPack, indexUrl: string): string {
  if (!entry.file) throw new RadioError('NOT_FOUND', `The pack "${entry.id}" has no download.`);
  return new URL(entry.file, indexUrl).toString();
}

/** Downloads one pack's bundle as bytes (not yet checked: see `checkBundle`). */
export async function fetchBundleBytes(
  http: SafeHttpClient,
  entry: LibraryPack,
  indexUrl: string,
  signal?: AbortSignal,
): Promise<Buffer> {
  const { bytes } = await http.fetchBytes(bundleUrl(entry, indexUrl), {
    maxBytes: entry.bytes ?? MAX_BUNDLE_BYTES,
    totalTimeoutMs: TIMEOUT_MS,
    signal,
  });
  return bytes;
}

export interface CheckedBundle {
  pack: Omit<StationPack, 'origin' | 'contentHash' | 'dir'>;
  /** The three files to write, as JSON text (sources.json null when the pack has none). */
  files: { 'pack.json': string; 'stations.json': string; 'sources.json': string | null };
  sha256: string;
}

/**
 * What installing a checked bundle needs: the files to write, and the pack's details and source
 * IDs for the clash check. The worker that checks a bundle sends back just this, because copying
 * every station and source of a big pack to the main thread holds it up for over 10 ms.
 */
export interface InstallableBundle {
  pack: { meta: CheckedBundle['pack']['meta']; sources: ReadonlyArray<{ id: string }> };
  files: CheckedBundle['files'];
  sha256: string;
}

export function installable(checked: CheckedBundle): InstallableBundle {
  return {
    pack: { meta: checked.pack.meta, sources: checked.pack.sources.map((s) => ({ id: s.id })) },
    files: checked.files,
    sha256: checked.sha256,
  };
}

/**
 * Checks a downloaded bundle: its fingerprint against the index (when one is given), its shape,
 * that it is the pack that was asked for, and the pack itself with the same rules as a folder.
 * CPU-bound for a large pack: the bot runs it on a worker thread (pack-worker.ts).
 */
export function checkBundle(bytes: Uint8Array, expect: { id: string; sha256: string | null }): CheckedBundle {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expect.sha256 && sha256 !== expect.sha256) {
    throw new RadioError(
      'PACK_INVALID',
      `The download of "${expect.id}" doesn't match the library's fingerprint, so it was not used. Try again later.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    throw new RadioError('PACK_INVALID', `The download of "${expect.id}" is not a pack.`);
  }
  const bundle = packBundleSchema.safeParse(raw);
  if (!bundle.success) throw new RadioError('PACK_INVALID', `The download of "${expect.id}" is not a pack.`);
  const files: PackFiles = {
    pack: bundle.data.pack,
    stations: bundle.data.stations,
    sources: bundle.data.sources,
  };
  const { dir: _dir, ...pack } = parsePack(files, expect.id);
  if (pack.meta.id !== expect.id) {
    throw new RadioError(
      'PACK_INVALID',
      `The download of "${expect.id}" holds a different pack ("${pack.meta.id}").`,
    );
  }
  const text = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  return {
    pack,
    files: {
      'pack.json': text(files.pack),
      'stations.json': text(files.stations),
      'sources.json': files.sources === undefined ? null : text(files.sources),
    },
    sha256,
  };
}

/** Index entries matching a search: words against name, owner, id and regions; filters by country and language. */
export function searchLibrary(
  index: LibraryIndex,
  q: { words?: string | null; country?: string | null; language?: string | null } = {},
): LibraryPack[] {
  const words = (q.words ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const country = q.country?.toUpperCase() ?? null;
  const language = q.language?.toLowerCase() ?? null;
  return index.packs
    .filter((p) => p.status === 'available')
    .filter((p) => !country || p.countries.includes(country))
    .filter((p) => !language || p.languages.some((l) => l.toLowerCase().split('-')[0] === language))
    .filter((p) => {
      const hay = [p.id, p.name, p.description, p.owner?.name, p.owner?.brand, ...p.regions]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return words.every((w) => hay.includes(w));
    })
    .sort((a, b) => compareText(a.name, b.name));
}

/** One of each, made on first use: ICU loads its display-name data then (about 9 ms here). */
const displayNames: Partial<Record<'region' | 'language', Intl.DisplayNames>> = {};

function displayName(type: 'region' | 'language', code: string): string {
  try {
    displayNames[type] ??= new Intl.DisplayNames(['en-GB'], { type });
    return displayNames[type].of(code) ?? code;
  } catch {
    return code;
  }
}

/** A country's English name from its code ("GB" → "United Kingdom"), or the code itself. */
export function countryName(code: string): string {
  return displayName('region', code);
}

/** A language's English name from its code ("fr" → "French"), or the code itself. */
export function languageName(code: string): string {
  return displayName('language', code);
}

/**
 * Sets up ICU's collation and display names (about 30 ms between them the first time), so that
 * happens at start-up, before anything plays, rather than in the first search or pack card.
 */
export function warmLocaleData(): void {
  compareText('a', 'b');
  countryName('GB');
  languageName('en');
}
