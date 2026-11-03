/**
 * Manages installed station packs from the command line. The `radio-bot packs` command runs this
 * inside the bot's container; on a bare-metal install run it directly with the bot's environment:
 *
 *   node dist/scripts/packs.js list                       installed packs, and updates available
 *   node dist/scripts/packs.js browse [words] [--country GB] [--language fr]
 *   node dist/scripts/packs.js info <pack>
 *   node dist/scripts/packs.js add <pack>… | --collection <id>
 *   node dist/scripts/packs.js update [pack…]             every installed pack if none is named
 *   node dist/scripts/packs.js remove <pack>…
 *
 *   --from <url or index.json>   use another pack library instead of the official one
 *
 * Packs are written to the installed-packs folder next to the database (DATABASE_PATH). A running
 * bot loads the change when it receives SIGHUP (`radio-bot packs` sends it), or at its next start.
 * Exits 0 on success and 1 on any failure; with --unchanged-status (radio-bot.sh), add and update
 * exit 3 when every pack was already up to date, so there is nothing to load.
 */
import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  bundleUrl,
  checkBundle,
  countryName,
  fetchBundleBytes,
  fetchLibraryIndex,
  type LibraryIndex,
  type LibraryPack,
  languageName,
  MAX_BUNDLE_BYTES,
  OFFICIAL_LIBRARY_URL,
  parseLibraryIndex,
  searchLibrary,
  tooNewFor,
} from '../src/catalogue/pack-library.ts';
import { installedPacksDir, PackStore } from '../src/catalogue/pack-store.ts';
import { PackRegistry, packConflict } from '../src/catalogue/packs.ts';
import { matchOwner } from '../src/persistence/db.ts';
import { errorMessage, isRadioError } from '../src/shared/errors.ts';
import { plural } from '../src/shared/text.ts';
import { botVersion, compareVersions } from '../src/shared/version.ts';
import { SafeHttpClient } from '../src/streams/safe-fetch.ts';
import { UrlPolicy } from '../src/streams/url-policy.ts';

export interface PacksCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  /** Tests pass a client that may reach loopback addresses. */
  http?: SafeHttpClient;
}

const HELP = `Manage Radio Bot's station packs.

  list                       Show the installed packs, and any updates
  browse [words]             Show the packs in the library (--country GB, --language fr)
  info <pack>                Show one pack from the library
  add <pack> [<pack> …]      Install packs (or --collection <name> for a whole collection)
  update [<pack> …]          Update installed packs (all of them if none is named)
  remove <pack> [<pack> …]   Remove installed packs

  --from <address>           Use another pack library (its index.json address or file)`;

interface Args {
  command: string;
  rest: string[];
  from: string | null;
  country: string | null;
  language: string | null;
  collection: string | null;
  /** For radio-bot.sh: exit with UNCHANGED_STATUS when add or update had nothing to do. */
  unchangedStatus: boolean;
}

/** add or update changed nothing (every pack was already up to date), so there's nothing to reload. */
export const UNCHANGED_STATUS = 3;

function unchanged(args: Args): number {
  return args.unchangedStatus ? UNCHANGED_STATUS : 0;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    command: argv[0] ?? 'help',
    rest: [],
    from: null,
    country: null,
    language: null,
    collection: null,
    unchangedStatus: false,
  };
  for (let i = 1; i < argv.length; i++) {
    const v = argv[i]!;
    const next = () => {
      const n = argv[++i];
      if (n === undefined) throw new Error(`${v} needs a value.`);
      return n;
    };
    if (v === '--from') a.from = next();
    else if (v === '--country') a.country = next();
    else if (v === '--language') a.language = next();
    else if (v === '--collection') a.collection = next();
    else if (v === '--unchanged-status') a.unchangedStatus = true;
    else if (v.startsWith('--')) throw new Error(`Unknown option ${v}.`);
    else a.rest.push(v.toLowerCase());
  }
  return a;
}

/** A library: where its index came from, and how to read its bundles. */
interface Library {
  label: string;
  /** What installed.json records as the source. */
  source: string;
  index: LibraryIndex;
  bundle(entry: LibraryPack): Promise<Uint8Array>;
}

async function openLibrary(from: string | null, http: SafeHttpClient): Promise<Library> {
  if (!from || /^https?:\/\//i.test(from)) {
    const url = from ?? OFFICIAL_LIBRARY_URL;
    const index = await fetchLibraryIndex(http, url);
    return {
      label: from ? url : 'the official pack library',
      source: from ? url : 'official',
      index,
      bundle: (entry) => fetchBundleBytes(http, entry, url),
    };
  }
  const path = resolve(from);
  const index = parseLibraryIndex(await readFile(path, 'utf8'));
  return {
    label: path,
    source: path,
    index,
    bundle: async (entry) => {
      // A local library's bundles sit next to its index (or wherever `file` points, relative to it).
      const url = new URL(bundleUrl(entry, pathToFileURL(path).href));
      if (url.protocol !== 'file:') throw new Error(`"${entry.id}" isn't in that folder.`);
      const bytes = await readFile(url);
      if (bytes.length > MAX_BUNDLE_BYTES) throw new Error(`"${entry.id}" is too large.`);
      return bytes;
    },
  };
}

function describe(p: LibraryPack): string {
  const where = p.countries.map(countryName).join(', ');
  const owner = p.owner ? ` · ${p.owner.brand ? `${p.owner.brand} (${p.owner.name})` : p.owner.name}` : '';
  return `${p.id.padEnd(20)} ${p.name} · ${plural(p.stations, 'station')}${where ? ` · ${where}` : ''}${owner}`;
}

export async function runPacksCli(argv: string[], io: PacksCliIo): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(errorMessage(err));
    return 1;
  }
  if (['help', '--help', '-h'].includes(args.command)) {
    io.out(HELP);
    return 0;
  }
  const dir = installedPacksDir(io.env.DATABASE_PATH ?? './data/radio-bot.sqlite');
  if (!dir) {
    io.err('DATABASE_PATH is ":memory:", so there is no folder to install packs into.');
    return 1;
  }
  const store = new PackStore(dir);
  const http = io.http ?? new SafeHttpClient(new UrlPolicy({ allowInsecureHttp: true }));
  const extraDir = io.env.EXTRA_PACKS_DIR?.trim() || null;

  try {
    switch (args.command) {
      case 'list':
        return await list(store, extraDir, args, http, io);
      // For radio-bot.sh: how many packs are installed (it offers some on a first install).
      case 'count':
        io.out(String(Object.keys((await store.readRecord()).packs).length));
        return 0;
      case 'browse': {
        const lib = await openLibrary(args.from, http);
        const found = searchLibrary(lib.index, {
          words: args.rest.join(' '),
          country: args.country,
          language: args.language,
        });
        if (found.length === 0) {
          io.out(`No packs in ${lib.label} match that.`);
          return 0;
        }
        io.out(`Packs in ${lib.label}:`);
        for (const p of found) io.out(`  ${describe(p)}${store.has(p.id) ? ' (installed)' : ''}`);
        const collections = lib.index.collections.filter((c) => c.packs.length > 0);
        if (collections.length) {
          io.out('');
          io.out('Collections (install with --collection <name>):');
          for (const c of collections)
            io.out(`  ${c.id.padEnd(20)} ${c.name} · ${plural(c.packs.length, 'pack')}`);
        }
        io.out('');
        io.out('Install one with: radio-bot packs add <pack>');
        return 0;
      }
      case 'info': {
        const id = args.rest[0];
        if (!id) throw new Error('Name a pack, for example: radio-bot packs info mypack');
        const lib = await openLibrary(args.from, http);
        const p = lib.index.packs.find((x) => x.id === id);
        if (!p) throw new Error(`${lib.label} has no pack called "${id}".`);
        io.out(`${p.name} (${p.id}), version ${p.version}`);
        if (p.description) io.out(p.description);
        if (p.owner)
          io.out(
            `Company: ${p.owner.name}${p.owner.brand ? `, brand ${p.owner.brand}` : ''} (${p.owner.kind})`,
          );
        io.out(`Stations: ${p.stations} · stream addresses: ${p.sources}`);
        if (p.countries.length) io.out(`Countries: ${p.countries.map(countryName).join(', ')}`);
        if (p.regions.length) io.out(`Regions: ${p.regions.join(', ')}`);
        if (p.languages.length) io.out(`Languages: ${p.languages.map(languageName).join(', ')}`);
        io.out(`Streams last checked: ${p.lastChecked ?? 'not recorded'}`);
        if (p.status === 'withdrawn')
          io.out(`Withdrawn from the library${p.withdrawnReason ? `: ${p.withdrawnReason}` : ''}.`);
        else io.out(store.has(p.id) ? 'Installed.' : `Install it with: radio-bot packs add ${p.id}`);
        return 0;
      }
      case 'add':
      case 'update': {
        const lib = await openLibrary(args.from, http);
        let ids = args.rest;
        if (args.collection) {
          const c = lib.index.collections.find((x) => x.id === args.collection);
          if (!c) throw new Error(`${lib.label} has no collection called "${args.collection}".`);
          ids = [...ids, ...c.packs];
        }
        if (args.command === 'update' && ids.length === 0) {
          const record = await store.readRecord();
          ids = Object.keys(record.packs).filter((id) => record.packs[id]!.source === lib.source);
          if (ids.length === 0) {
            io.out(`No packs from ${lib.label} are installed.`);
            return 0;
          }
        }
        if (ids.length === 0)
          throw new Error('Name at least one pack, for example: radio-bot packs add mypack');
        let failed = 0;
        let changed = false;
        for (const id of [...new Set(ids)]) {
          try {
            const r = await install(store, extraDir, lib, id, args.command === 'update');
            changed ||= r.changed;
            io.out(r.message);
          } catch (err) {
            failed++;
            io.err(`${id}: ${isRadioError(err) ? err.userMessage : errorMessage(err)}`);
          }
        }
        return failed ? 1 : changed ? 0 : unchanged(args);
      }
      case 'remove': {
        if (args.rest.length === 0)
          throw new Error('Name at least one pack, for example: radio-bot packs remove mypack');
        let failed = 0;
        for (const id of args.rest) {
          const removed = await store.remove(id, true);
          ownLikeData(store, null);
          if (removed)
            io.out(`Removed ${id}. Its stations are hidden; favourites come back if you add it again.`);
          else {
            failed++;
            io.err(`${id} isn't installed.`);
          }
        }
        return failed ? 1 : 0;
      }
      default:
        io.err(`Unknown command "${args.command}".\n\n${HELP}`);
        return 1;
    }
  } catch (err) {
    io.err(isRadioError(err) ? err.userMessage : errorMessage(err));
    return 1;
  }
}

async function list(
  store: PackStore,
  extraDir: string | null,
  args: Args,
  http: SafeHttpClient,
  io: PacksCliIo,
): Promise<number> {
  const registry = PackRegistry.load(extraDir, undefined, store.dir);
  const record = await store.readRecord();
  const installed = registry.packs.filter((p) => p.origin === 'installed');
  if (installed.length === 0 && registry.skipped.length === 0)
    io.out('No station packs are installed yet. See what there is with: radio-bot packs browse');
  let index: LibraryIndex | null = null;
  try {
    index = (await openLibrary(args.from, http)).index;
  } catch {
    // Offline: list without update information.
  }
  for (const p of installed) {
    const entry = index?.packs.find((x) => x.id === p.meta.id);
    const from = record.packs[p.meta.id]?.source;
    const update =
      entry?.status === 'withdrawn'
        ? ' · withdrawn from the library'
        : entry && p.meta.version && compareVersions(entry.version, p.meta.version) > 0
          ? ` · update available (${entry.version})`
          : '';
    io.out(
      `  ${p.meta.id.padEnd(20)} ${p.meta.name} · version ${p.meta.version ?? 'unknown'} · ${plural(p.stations.length, 'station')}${from && from !== 'official' ? ` · from ${from}` : ''}${update}`,
    );
  }
  for (const p of registry.packs.filter((x) => x.origin === 'extra'))
    io.out(`  ${p.meta.id.padEnd(20)} ${p.meta.name} · your own pack (EXTRA_PACKS_DIR)`);
  for (const s of registry.skipped) io.err(`  Not loaded: ${s.dir}: ${s.reason}`);
  return 0;
}

/**
 * Run with sudo on a bare-metal install, the files would belong to root, and the bot's own service
 * user couldn't install or remove packs from Discord later: give them the data folder's owner.
 */
function ownLikeData(store: PackStore, id: string | null): void {
  const data = dirname(store.dir);
  if (!existsSync(data)) return;
  const paths = [store.dir, join(store.dir, 'installed.json')];
  if (id && store.has(id)) {
    const dir = store.packDir(id);
    paths.push(dir, ...readdirSync(dir).map((f) => join(dir, f)));
  }
  matchOwner(
    data,
    paths.filter((p) => existsSync(p)),
  );
}

async function install(
  store: PackStore,
  extraDir: string | null,
  lib: Library,
  id: string,
  updateOnly: boolean,
): Promise<{ changed: boolean; message: string }> {
  const entry = lib.index.packs.find((p) => p.id === id);
  if (!entry) throw new Error(`${lib.label} has no pack called "${id}".`);
  if (entry.status !== 'available') throw new Error(`"${id}" was withdrawn from ${lib.label}.`);
  const tooNew = tooNewFor(entry, botVersion());
  if (tooNew) throw new Error(tooNew);
  const registry = PackRegistry.load(extraDir, undefined, store.dir);
  const current = registry.get(id);
  if (current && current.origin !== 'installed')
    throw new Error(
      `A pack called "${id}" is already loaded from ${current.origin === 'extra' ? 'EXTRA_PACKS_DIR' : 'the bot itself'}.`,
    );
  if (updateOnly && !current)
    throw new Error(`"${id}" isn't installed. Add it with: radio-bot packs add ${id}`);
  if (current?.meta.version && compareVersions(entry.version, current.meta.version) <= 0)
    return {
      changed: false,
      message: `${current.meta.name} (${id}) is already up to date (version ${current.meta.version}).`,
    };
  const checked = checkBundle(await lib.bundle(entry), { id, sha256: entry.sha256 });
  const conflict = packConflict(
    registry.packs,
    { ...checked.pack, dir: store.packDir(id) },
    { replacing: true },
  );
  if (conflict) throw new Error(conflict);
  await store.install(checked, lib.source);
  ownLikeData(store, id);
  return {
    changed: true,
    message: current
      ? `Updated ${checked.pack.meta.name} (${id}) from version ${current.meta.version ?? 'unknown'} to ${checked.pack.meta.version}.`
      : `Installed ${checked.pack.meta.name} (${id}): ${plural(checked.pack.stations.length, 'station')}.`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const code = await runPacksCli(process.argv.slice(2), {
    out: (l) => process.stdout.write(`${l}\n`),
    err: (l) => process.stderr.write(`${l}\n`),
    env: process.env,
  });
  process.exit(code);
}
