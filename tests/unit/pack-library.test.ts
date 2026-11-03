import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPacksCli } from '../../scripts/packs.ts';
import {
  bundleUrl,
  checkBundle,
  countryName,
  type LibraryIndex,
  languageName,
  parseLibraryIndex,
  searchLibrary,
} from '../../src/catalogue/pack-library.ts';
import { PackManager } from '../../src/catalogue/pack-manager.ts';
import { installedPacksDir, PackStore } from '../../src/catalogue/pack-store.ts';
import { PackRegistry, seedPackInSlices } from '../../src/catalogue/packs.ts';
import { compareVersions } from '../../src/shared/version.ts';
import { SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import { UrlPolicy } from '../../src/streams/url-policy.ts';
import { memoryDb, silentLogger } from '../helpers.ts';

const roots: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'radiobot-library-'));
  roots.push(d);
  return d;
};

/** A small pack's three files, as a library bundle holds them. */
function packFiles(id: string, version: string, stations = 3, opts: { sourcePrefix?: string } = {}) {
  const prefix = opts.sourcePrefix ?? id;
  return {
    pack: {
      schemaVersion: 1,
      id,
      name: `Pack ${id}`,
      version,
      owner: { name: 'Example Media', kind: 'group', brand: null },
      countries: ['GB'],
      languages: ['en'],
    },
    stations: {
      schemaVersion: 1,
      stations: Array.from({ length: stations }, (_, i) => ({
        slug: `${id}-${i + 1}`,
        displayName: `${id} station ${i + 1}`,
        order: i + 1,
      })),
    },
    sources: {
      schemaVersion: 1,
      sources: Array.from({ length: stations }, (_, i) => ({
        id: `${prefix}-${i + 1}-mp3`,
        station: `${id}-${i + 1}`,
        url: `https://stream.example.org/${id}/${i + 1}.mp3`,
        provenance: 'official-player',
        provenanceDetail: 'Linked from the example player on 2026-11-01.',
      })),
    },
  };
}

const bundleBytes = (files: ReturnType<typeof packFiles>) =>
  Buffer.from(JSON.stringify({ schemaVersion: 1, ...files }));
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** A library: the index and bundles it serves, by path. */
class Library {
  readonly files = new Map<string, Buffer>();
  index: LibraryIndex = { schemaVersion: 1, generatedAt: '2026-11-03T00:00:00Z', packs: [], collections: [] };

  add(files: ReturnType<typeof packFiles>, extra: Partial<LibraryIndex['packs'][number]> = {}): void {
    const bytes = bundleBytes(files);
    this.files.set(`/${files.pack.id}.json`, bytes);
    this.index.packs = this.index.packs.filter((p) => p.id !== files.pack.id);
    this.index.packs.push({
      id: files.pack.id,
      name: files.pack.name,
      description: '',
      version: files.pack.version,
      owner: { name: 'Example Media', kind: 'group', brand: null },
      countries: ['GB'],
      regions: [],
      languages: ['en'],
      stations: files.stations.stations.length,
      sources: files.sources.sources.length,
      lastChecked: '2026-11-01',
      minBotVersion: null,
      status: 'available',
      withdrawnReason: null,
      file: `${files.pack.id}.json`,
      sha256: sha(bytes),
      bytes: bytes.length,
      ...extra,
    });
  }

  withdraw(id: string, reason: string): void {
    const p = this.index.packs.find((x) => x.id === id)!;
    Object.assign(p, { status: 'withdrawn', withdrawnReason: reason, file: null, sha256: null, bytes: null });
  }

  /** Writes the library to a folder, as `--from <index.json>` reads it. */
  writeTo(dir: string): string {
    for (const [path, bytes] of this.files) writeFileSync(join(dir, path.slice(1)), bytes);
    writeFileSync(join(dir, 'index.json'), JSON.stringify(this.index));
    return join(dir, 'index.json');
  }
}

let server: Server | null = null;
let lib: Library;
let baseUrl: string;
const http = new SafeHttpClient(
  new UrlPolicy({ allowInsecureHttp: true, testAllowedAddresses: ['127.0.0.1'] }),
);

beforeEach(async () => {
  lib = new Library();
  server = createServer((req, res) => {
    if (req.url === '/index.json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(lib.index));
      return;
    }
    const body = lib.files.get(req.url ?? '');
    if (body) res.writeHead(200, { 'content-type': 'application/json' }).end(body);
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('versions', () => {
  it('compares dotted versions part by part', () => {
    expect(compareVersions('1.10.0', '1.9.2')).toBe(1);
    expect(compareVersions('2026.11.03.2', '2026.11.03')).toBe(1);
    expect(compareVersions('2026.11.03', '2026.11.03.0')).toBe(0);
    expect(compareVersions('2026.01.01', '2026.11.03')).toBe(-1);
  });
});

describe('library index and bundles', () => {
  it('parses an index and refuses something else with a plain message', () => {
    lib.add(packFiles('alpha', '2026.11.01'));
    expect(parseLibraryIndex(JSON.stringify(lib.index)).packs[0]!.id).toBe('alpha');
    expect(() => parseLibraryIndex('<html>')).toThrow(/not a pack list/);
    expect(() => parseLibraryIndex('{"schemaVersion":2}')).toThrow(/not valid/);
  });

  it('checks a bundle: fingerprint, shape, id and the pack itself', () => {
    const files = packFiles('alpha', '2026.11.01');
    const bytes = bundleBytes(files);
    const ok = checkBundle(bytes, { id: 'alpha', sha256: sha(bytes) });
    expect(ok.pack.stations).toHaveLength(3);
    expect(JSON.parse(ok.files['pack.json']).id).toBe('alpha');
    expect(() => checkBundle(bytes, { id: 'alpha', sha256: 'f'.repeat(64) })).toThrow(/fingerprint/);
    expect(() => checkBundle(bytes, { id: 'beta', sha256: null })).toThrow(/different pack/);
    expect(() => checkBundle(Buffer.from('nope'), { id: 'alpha', sha256: null })).toThrow(/not a pack/);
    const broken = packFiles('alpha', '2026.11.01');
    broken.sources.sources[0]!.station = 'missing';
    expect(() => checkBundle(bundleBytes(broken), { id: 'alpha', sha256: null })).toThrow(/unknown station/);
  });

  it('refuses a pack that needs a newer bot', () => {
    const files = packFiles('alpha', '2026.11.01');
    Object.assign(files.pack, { minBotVersion: '99.0.0' });
    expect(() => checkBundle(bundleBytes(files), { id: 'alpha', sha256: null })).toThrow(
      /needs Radio Bot 99\.0\.0/,
    );
  });

  it('searches by words, country and language, leaving out withdrawn packs', () => {
    lib.add(packFiles('alpha', '2026.11.01'), { name: 'Northern Hits', regions: ['Manchester'] });
    lib.add(packFiles('beta', '2026.11.01'), { name: 'Paris Dance', countries: ['FR'], languages: ['fr'] });
    lib.add(packFiles('gamma', '2026.11.01'));
    lib.withdraw('gamma', 'at the owner’s request');
    expect(searchLibrary(lib.index).map((p) => p.id)).toEqual(['alpha', 'beta']);
    expect(searchLibrary(lib.index, { words: 'manchester' }).map((p) => p.id)).toEqual(['alpha']);
    expect(searchLibrary(lib.index, { country: 'fr' }).map((p) => p.id)).toEqual(['beta']);
    expect(searchLibrary(lib.index, { language: 'FR' }).map((p) => p.id)).toEqual(['beta']);
    expect(countryName('GB')).toBe('United Kingdom');
    expect(languageName('fr')).toBe('French');
  });
});

describe('PackStore', () => {
  it('lives next to the database, and nowhere for an in-memory one', () => {
    expect(installedPacksDir(':memory:')).toBeNull();
    expect(installedPacksDir(join('data', 'radio-bot.sqlite'))).toMatch(/data[\\/]installed-packs$/);
  });

  it('installs, replaces and removes a pack, keeping a record', async () => {
    const store = new PackStore(join(temp(), 'installed-packs'));
    const v1 = bundleBytes(packFiles('alpha', '2026.11.01'));
    await store.install(checkBundle(v1, { id: 'alpha', sha256: null }), 'official');
    expect(store.has('alpha')).toBe(true);
    const v2 = bundleBytes(packFiles('alpha', '2026.11.02', 4));
    await store.install(checkBundle(v2, { id: 'alpha', sha256: null }), 'official');
    const registry = PackRegistry.load(null, undefined, store.dir);
    expect(registry.get('alpha')?.stations).toHaveLength(4);
    expect(registry.get('alpha')?.origin).toBe('installed');
    expect((await store.readRecord()).packs.alpha?.version).toBe('2026.11.02');
    expect(await store.remove('alpha')).toBe(true);
    expect(store.has('alpha')).toBe(false);
    const record = await store.readRecord();
    expect(record.packs.alpha).toBeUndefined();
    expect(record.removed).toEqual(['alpha']);
  });

  it('reads a damaged record as empty, and refuses a path as a pack id', async () => {
    const dir = join(temp(), 'installed-packs');
    mkdirSync(dir);
    writeFileSync(join(dir, 'installed.json'), '{oops');
    expect((await new PackStore(dir).readRecord()).packs).toEqual({});
    expect(() => new PackStore(dir).packDir('../etc')).toThrow(/not a pack id/);
  });
});

describe('PackRegistry with installed packs', () => {
  it('skips an installed pack that is broken or clashes, instead of stopping', () => {
    const root = temp();
    const installed = join(root, 'installed-packs');
    const write = (name: string, files: ReturnType<typeof packFiles>) => {
      mkdirSync(join(installed, name), { recursive: true });
      for (const [f, v] of Object.entries({
        'pack.json': files.pack,
        'stations.json': files.stations,
        'sources.json': files.sources,
      }))
        writeFileSync(join(installed, name, f), JSON.stringify(v));
    };
    write('alpha', packFiles('alpha', '2026.11.01'));
    write('beta', packFiles('beta', '2026.11.01', 3, { sourcePrefix: 'alpha' })); // same source ids
    mkdirSync(join(installed, 'broken'));
    writeFileSync(join(installed, 'broken', 'pack.json'), '{');
    const registry = PackRegistry.load(null, undefined, installed);
    expect(registry.packs.map((p) => p.meta.id)).toEqual(['alpha']);
    expect(registry.skipped).toHaveLength(2);
    expect(registry.skipped.map((s) => s.reason).join('\n')).toMatch(
      /Source id "alpha-1-mp3" is used by packs/,
    );
    // Dropping and putting back works while running.
    expect(registry.drop('alpha')).toBe(true);
    expect(registry.isEnabled('alpha')).toBe(false);
  });

  it('seeds a pack in slices with the same result as at start-up', async () => {
    const { db, stations } = memoryDb();
    const root = temp();
    const store = new PackStore(root);
    const big = bundleBytes(packFiles('big', '2026.11.01', 120));
    await store.install(checkBundle(big, { id: 'big', sha256: null }), 'official');
    const pack = PackRegistry.load(null, undefined, root).get('big')!;
    const summary = await seedPackInSlices(stations, (fn) => db.transaction(fn), pack);
    expect(summary.stationsInserted).toBe(120);
    expect(summary.sourcesInserted).toBe(120);
    expect(stations.providerIds()).toEqual(['big']);
  });
});

function manager(opts: { store?: PackStore | null; registry?: PackRegistry; now?: () => number } = {}) {
  const { db, stations } = memoryDb();
  const registry = opts.registry ?? new PackRegistry([]);
  const events = { changes: 0, gone: [] as string[] };
  const pm = new PackManager({
    registry,
    store: opts.store === undefined ? new PackStore(join(temp(), 'installed-packs')) : opts.store,
    stations,
    transaction: (fn) => db.transaction(fn),
    http,
    logger: silentLogger(),
    background: (fn) => fn(),
    onChange: () => events.changes++,
    onGone: (id) => events.gone.push(id),
    libraryUrl: `${baseUrl}/index.json`,
    now: opts.now,
  });
  return { pm, registry, stations, db, events };
}

describe('PackManager', () => {
  it('installs a pack from the library and makes its stations visible', async () => {
    lib.add(packFiles('alpha', '2026.11.01'));
    const { pm, registry, stations, events } = manager();
    const r = await pm.install('alpha');
    expect(r).toMatchObject({ id: 'alpha', version: '2026.11.01', previousVersion: null, stations: 3 });
    expect(registry.isEnabled('alpha')).toBe(true);
    expect(stations.getStation('alpha:alpha-1')?.displayName).toBe('alpha station 1');
    expect(events.changes).toBe(1);
  });

  it('notes updates, installs them, and refuses packs it does not know', async () => {
    lib.add(packFiles('alpha', '2026.11.01'));
    const { pm, registry } = manager();
    await pm.install('alpha');
    lib.add(packFiles('alpha', '2026.11.05', 5));
    await pm.index(true);
    expect(pm.updates.get('alpha')).toBe('2026.11.05');
    const r = await pm.install('alpha');
    expect(r.previousVersion).toBe('2026.11.01');
    expect(registry.get('alpha')?.stations).toHaveLength(5);
    expect(pm.updates.has('alpha')).toBe(false);
    await expect(pm.install('nope')).rejects.toThrow(/no pack called "nope"/);
  });

  it('refuses a download that does not match its fingerprint, changing nothing', async () => {
    lib.add(packFiles('alpha', '2026.11.01'), { sha256: 'a'.repeat(64) });
    const { pm, registry } = manager();
    await expect(pm.install('alpha')).rejects.toThrow(/fingerprint/);
    expect(registry.get('alpha')).toBeNull();
  });

  it('removes an installed pack and stops what plays from it', async () => {
    lib.add(packFiles('alpha', '2026.11.01'));
    const { pm, registry, events } = manager();
    await pm.install('alpha');
    expect(await pm.remove('alpha')).toBe(true);
    expect(registry.get('alpha')).toBeNull();
    expect(events.gone).toEqual(['alpha']);
  });

  it('restores packs the database uses but that are missing, unless removed on purpose', async () => {
    lib.add(packFiles('alpha', '2026.11.01'));
    lib.add(packFiles('beta', '2026.11.01'));
    const store = new PackStore(join(temp(), 'installed-packs'));
    const { pm, stations, registry } = manager({ store });
    // An older install had both packs (for example bundled with the bot), then lost them.
    for (const id of ['alpha', 'beta']) {
      stations.upsertProviderStation({
        id: `${id}:${id}-1`,
        provider: id,
        slug: `${id}-1`,
        externalId: null,
        displayName: `${id} station 1`,
        aliases: [],
        tags: [],
        category: null,
        sortOrder: 1,
        officialPageUrl: null,
        officialLastSeenAt: null,
        catalogueStatus: 'active',
        description: null,
      });
    }
    await store.remove('beta', true);
    expect(await pm.restoreMissing()).toEqual(['alpha']);
    expect(registry.isEnabled('alpha')).toBe(true);
    expect(registry.get('beta')).toBeNull();
  });

  it('carries on when the library cannot be reached during a restore', async () => {
    const { pm, stations } = manager();
    stations.upsertProviderStation({
      id: 'alpha:alpha-1',
      provider: 'alpha',
      slug: 'alpha-1',
      externalId: null,
      displayName: 'a',
      aliases: [],
      tags: [],
      category: null,
      sortOrder: 1,
      officialPageUrl: null,
      officialLastSeenAt: null,
      catalogueStatus: 'active',
      description: null,
    });
    await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    expect(await pm.restoreMissing()).toEqual([]);
  });

  it('removes an official pack the library has withdrawn, with a notice', async () => {
    lib.add(packFiles('alpha', '2026.11.01'));
    const { pm, registry, events } = manager();
    await pm.install('alpha');
    lib.withdraw('alpha', 'at the owner’s request');
    await pm.check();
    expect(registry.get('alpha')).toBeNull();
    expect(events.gone).toEqual(['alpha']);
    expect(pm.notices[0]).toMatch(/withdrawn from the pack library \(at the owner’s request\)/);
  });

  it('reloads the folder after the command line changed it', async () => {
    const store = new PackStore(join(temp(), 'installed-packs'));
    const { pm, registry } = manager({ store });
    await store.install(
      checkBundle(bundleBytes(packFiles('alpha', '2026.11.01')), { id: 'alpha', sha256: null }),
      'official',
    );
    expect((await pm.reload()).loaded).toEqual(['alpha']);
    expect(registry.isEnabled('alpha')).toBe(true);
    expect((await pm.reload()).loaded).toEqual([]); // unchanged: nothing to do
    await store.remove('alpha');
    expect((await pm.reload()).removed).toEqual(['alpha']);
    expect(registry.get('alpha')).toBeNull();
  });

  it('cannot install without a data folder', async () => {
    lib.add(packFiles('alpha', '2026.11.01'));
    const { pm } = manager({ store: null });
    expect(pm.canInstall).toBe(false);
    await expect(pm.install('alpha')).rejects.toThrow(/no data folder/);
  });
});

describe('radio-bot packs (scripts/packs.ts)', () => {
  function cli(args: string[], dbDir: string) {
    const out: string[] = [];
    const err: string[] = [];
    return runPacksCli(args, {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: { DATABASE_PATH: join(dbDir, 'radio-bot.sqlite') },
      http,
    }).then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
  }

  it('browses, installs, lists, updates and removes packs from a library address', async () => {
    lib.add(packFiles('alpha', '2026.11.01'), { regions: ['Manchester'] });
    lib.add(packFiles('beta', '2026.11.01'));
    lib.index.collections = [
      { id: 'everything', name: 'Everything', description: '', packs: ['alpha', 'beta'] },
      { id: 'just-alpha', name: 'Just alpha', description: '', packs: ['alpha'] },
    ];
    const data = temp();
    const from = ['--from', `${baseUrl}/index.json`];
    const browsed = (await cli(['browse', 'manchester', ...from], data)).out;
    expect(browsed).toMatch(/alpha .*Pack alpha · 3 stations/);
    expect(browsed).toMatch(/Everything · 2 packs/);
    expect(browsed).toMatch(/Just alpha · 1 pack$/m);
    const added = await cli(['add', '--collection', 'everything', ...from], data);
    expect(added.code).toBe(0);
    expect(added.out).toMatch(/Installed Pack alpha \(alpha\): 3 stations/);
    expect(existsSync(join(data, 'installed-packs', 'beta', 'stations.json'))).toBe(true);
    expect((await cli(['count'], data)).out).toBe('2');
    lib.add(packFiles('alpha', '2026.11.09', 4));
    expect((await cli(['list', ...from], data)).out).toMatch(/update available \(2026\.11\.09\)/);
    const updated = await cli(['update', '--unchanged-status', ...from], data);
    expect(updated.code).toBe(0);
    expect(updated.out).toMatch(/Updated Pack alpha \(alpha\) from version 2026\.11\.01 to 2026\.11\.09/);
    expect(updated.out).toMatch(/beta.*already up to date/);
    // Nothing left to update: radio-bot.sh asks for status 3 so it doesn't reload the bot for nothing.
    const again = await cli(['update', '--unchanged-status', ...from], data);
    expect(again.code).toBe(3);
    expect(again.out).toMatch(/alpha.*already up to date/);
    expect((await cli(['update', ...from], data)).code).toBe(0);
    expect((await cli(['add', 'beta', '--unchanged-status', ...from], data)).code).toBe(3);
    expect((await cli(['remove', 'beta'], data)).out).toMatch(/Removed beta/);
    expect((await cli(['remove', 'beta'], data)).code).toBe(1);
    const record = JSON.parse(readFileSync(join(data, 'installed-packs', 'installed.json'), 'utf8'));
    expect(record.packs.alpha.source).toBe(`${baseUrl}/index.json`);
  });

  it('installs from a library folder on disk, and explains problems', async () => {
    lib.add(packFiles('alpha', '2026.11.01'));
    const index = lib.writeTo(temp());
    const data = temp();
    expect((await cli(['info', 'alpha', '--from', index], data)).out).toMatch(/Company: Example Media/);
    expect((await cli(['add', 'alpha', '--from', index], data)).code).toBe(0);
    const missing = await cli(['add', 'nope', '--from', index], data);
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/no pack called "nope"/);
    expect((await cli(['add', '--from'], data)).err).toMatch(/needs a value/);
    expect((await cli(['frobnicate'], data)).err).toMatch(/Unknown command/);
    expect((await cli(['help'], data)).out).toMatch(/Manage Radio Bot's station packs/);
  });

  it('explains every refusal in plain words', async () => {
    lib.add(packFiles('alpha', '2026.11.01'), {
      description: 'Hits from the north.',
      owner: { name: 'Example Media', kind: 'group', brand: 'Northern Hits' },
      regions: ['Manchester'],
    });
    lib.add(packFiles('gone', '2026.11.01'));
    lib.withdraw('gone', 'at the owner’s request');
    const data = temp();
    const from = ['--from', `${baseUrl}/index.json`];
    const run = (args: string[]) => cli([...args, ...from], data);
    expect((await run(['browse', 'nothing-matches'])).out).toMatch(/No packs in .* match that/);
    expect((await run(['browse', '--country', 'GB', '--language', 'en'])).out).toMatch(/alpha/);
    expect((await run(['info'])).err).toMatch(/Name a pack/);
    expect((await run(['info', 'nope'])).err).toMatch(/no pack called "nope"/);
    const info = (await run(['info', 'alpha'])).out;
    expect(info).toMatch(/Hits from the north\./);
    expect(info).toMatch(/Company: Example Media, brand Northern Hits \(group\)/);
    expect(info).toMatch(/Regions: Manchester/);
    expect(info).toMatch(/Languages: English/);
    expect(info).toMatch(/Install it with: radio-bot packs add alpha/);
    expect((await run(['info', 'gone'])).out).toMatch(/Withdrawn from the library: at the owner’s request\./);
    expect((await run(['add', '--collection', 'nope'])).err).toMatch(/no collection called "nope"/);
    expect((await run(['add'])).err).toMatch(/Name at least one pack/);
    expect((await run(['update'])).out).toMatch(/No packs from .* are installed/);
    expect((await run(['update', 'alpha'])).err).toMatch(/isn't installed\. Add it with/);
    expect((await run(['add', 'gone'])).err).toMatch(/"gone" was withdrawn/);
    expect((await cli(['remove'], data)).err).toMatch(/Name at least one pack/);
    expect((await cli(['browse', '--bogus'], data)).err).toMatch(/Unknown option --bogus/);
    expect((await run(['add', 'alpha'])).code).toBe(0);
    expect((await run(['info', 'alpha'])).out).toMatch(/^Installed\.$/m);
    expect((await run(['browse'])).out).toMatch(/alpha .* \(installed\)/);
  });

  it('refuses without a data folder, and a pack that clashes with the operator’s own', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runPacksCli(['list'], {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      env: { DATABASE_PATH: ':memory:' },
      http,
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/no folder to install packs into/);
    // The operator's own pack in EXTRA_PACKS_DIR uses the id the library offers.
    lib.add(packFiles('alpha', '2026.11.01'));
    const extra = temp();
    const files = packFiles('alpha', '2026.11.01');
    mkdirSync(join(extra, 'alpha'));
    writeFileSync(join(extra, 'alpha', 'pack.json'), JSON.stringify(files.pack));
    writeFileSync(join(extra, 'alpha', 'stations.json'), JSON.stringify(files.stations));
    const data = temp();
    const res: string[] = [];
    const clash = await runPacksCli(['add', 'alpha', '--from', `${baseUrl}/index.json`], {
      out: (l) => res.push(l),
      err: (l) => res.push(l),
      env: { DATABASE_PATH: join(data, 'radio-bot.sqlite'), EXTRA_PACKS_DIR: extra },
      http,
    });
    expect(clash).toBe(1);
    expect(res.join('\n')).toMatch(/already loaded from EXTRA_PACKS_DIR/);
    res.length = 0;
    await runPacksCli(['list', '--from', `${baseUrl}/index.json`], {
      out: (l) => res.push(l),
      err: (l) => res.push(l),
      env: { DATABASE_PATH: join(data, 'radio-bot.sqlite'), EXTRA_PACKS_DIR: extra },
      http,
    });
    expect(res.join('\n')).toMatch(/alpha .* your own pack \(EXTRA_PACKS_DIR\)/);
  });

  it('lists offline, shows withdrawn and skipped packs, and refuses a clash of stream ids', async () => {
    lib.add(packFiles('alpha', '2026.11.01'));
    lib.add(packFiles('beta', '2026.11.01', 3, { sourcePrefix: 'alpha' }));
    const data = temp();
    const from = ['--from', `${baseUrl}/index.json`];
    expect((await cli(['list', ...from], data)).out).toMatch(/No station packs are installed yet/);
    expect((await cli(['add', 'alpha', ...from], data)).code).toBe(0);
    expect((await cli(['add', 'beta', ...from], data)).err).toMatch(
      /Source id "alpha-1-mp3" is used by packs/,
    );
    lib.withdraw('alpha', 'gone');
    expect((await cli(['list', ...from], data)).out).toMatch(/withdrawn from the library/);
    mkdirSync(join(data, 'installed-packs', 'broken'));
    writeFileSync(join(data, 'installed-packs', 'broken', 'pack.json'), '{');
    // The library is gone: the list still shows what is installed.
    const offline = await cli(['list', '--from', 'http://127.0.0.1:1/index.json'], data);
    expect(offline.out).toMatch(/alpha .*version 2026\.11\.01/);
    expect(offline.err).toMatch(/Not loaded: .*broken/);
  });

  it('refuses a local library whose bundle points somewhere else', async () => {
    lib.add(packFiles('alpha', '2026.11.01'), { file: 'https://elsewhere.example.org/alpha.json' });
    const index = lib.writeTo(temp());
    const r = await cli(['add', 'alpha', '--from', index], temp());
    expect(r.err).toMatch(/isn't in that folder/);
  });
});

describe('library and manager edges', () => {
  it('has no download for a withdrawn entry, and refuses JSON that is not a bundle', () => {
    lib.add(packFiles('alpha', '2026.11.01'));
    lib.withdraw('alpha', 'gone');
    expect(() => bundleUrl(lib.index.packs[0]!, 'https://x.example.org/index.json')).toThrow(/no download/);
    expect(() => checkBundle(Buffer.from('{"hello":1}'), { id: 'alpha', sha256: null })).toThrow(
      /not a pack/,
    );
  });

  it('keeps the index for ten minutes, and notes an update for a pack with no version', async () => {
    lib.add(packFiles('alpha', '2026.11.01'));
    const store = new PackStore(join(temp(), 'installed-packs'));
    const unversioned = packFiles('alpha', '2026.11.01');
    Object.assign(unversioned.pack, { version: null });
    await store.install(checkBundle(bundleBytes(unversioned), { id: 'alpha', sha256: null }), 'official');
    const registry = PackRegistry.load(null, undefined, store.dir);
    let now = 0;
    const { pm } = manager({ store, registry, now: () => now });
    expect(pm.cachedIndex()).toBeNull();
    const first = await pm.index();
    expect(pm.cachedIndex()).toBe(first);
    expect(pm.updates.get('alpha')).toBe('2026.11.01');
    now = 5 * 60_000;
    expect(await pm.index()).toBe(first);
    now = 11 * 60_000;
    expect(await pm.index()).not.toBe(first);
  });

  it('refuses to install or remove over an operator’s own pack, or a clash of stream ids', async () => {
    lib.add(packFiles('alpha', '2026.11.01'));
    lib.add(packFiles('beta', '2026.11.01', 3, { sourcePrefix: 'alpha' }));
    const extra = temp();
    const files = packFiles('alpha', '2026.11.01');
    mkdirSync(join(extra, 'alpha'));
    for (const [f, v] of Object.entries({
      'pack.json': files.pack,
      'stations.json': files.stations,
      'sources.json': files.sources,
    }))
      writeFileSync(join(extra, 'alpha', f), JSON.stringify(v));
    const registry = PackRegistry.load(extra);
    const { pm } = manager({ registry });
    await expect(pm.install('alpha')).rejects.toThrow(/already loaded from EXTRA_PACKS_DIR/);
    await expect(pm.remove('alpha')).rejects.toThrow(/wasn’t installed from a library/);
    await expect(pm.install('beta')).rejects.toThrow(/Source id "alpha-1-mp3" is used by packs/);
    expect(await pm.remove('beta')).toBe(false);
  });

  it('skips folders that are broken or clash when reloading', async () => {
    const root = temp();
    const store = new PackStore(join(root, 'installed-packs'));
    const extra = join(root, 'extra');
    const own = packFiles('alpha', '2026.11.01');
    mkdirSync(join(extra, 'alpha'), { recursive: true });
    writeFileSync(join(extra, 'alpha', 'pack.json'), JSON.stringify(own.pack));
    writeFileSync(join(extra, 'alpha', 'stations.json'), JSON.stringify(own.stations));
    const registry = PackRegistry.load(extra);
    const { pm } = manager({ store, registry });
    await store.install(
      checkBundle(bundleBytes(packFiles('alpha', '2026.11.01')), { id: 'alpha', sha256: null }),
      'x',
    );
    await store.install(
      checkBundle(bundleBytes(packFiles('beta', '2026.11.01', 3, { sourcePrefix: 'zeta' })), {
        id: 'beta',
        sha256: null,
      }),
      'x',
    );
    await store.install(
      checkBundle(bundleBytes(packFiles('gamma', '2026.11.01', 3, { sourcePrefix: 'zeta' })), {
        id: 'gamma',
        sha256: null,
      }),
      'x',
    );
    mkdirSync(join(store.dir, 'broken'));
    writeFileSync(join(store.dir, 'broken', 'pack.json'), '{');
    const r = await pm.reload();
    expect(r.loaded).toEqual(['beta']);
    expect(r.skipped).toHaveLength(3);
    expect(registry.skipped.map((s) => s.reason).join('\n')).toMatch(/already loaded from EXTRA_PACKS_DIR/);
  });

  it('logs and carries on when a missing pack cannot be downloaded, and checks nothing without a store', async () => {
    lib.add(packFiles('alpha', '2026.11.01'));
    lib.files.delete('/alpha.json');
    const { pm, stations } = manager();
    stations.upsertProviderStation({
      id: 'alpha:alpha-1',
      provider: 'alpha',
      slug: 'alpha-1',
      externalId: null,
      displayName: 'a',
      aliases: [],
      tags: [],
      category: null,
      sortOrder: 1,
      officialPageUrl: null,
      officialLastSeenAt: null,
      catalogueStatus: 'active',
      description: null,
    });
    expect(await pm.restoreMissing()).toEqual([]);
    const none = manager({ store: null });
    await none.pm.check();
    expect(await none.pm.restoreMissing()).toEqual([]);
  });

  it('refuses a pack that needs a newer bot before downloading it', async () => {
    lib.add(packFiles('alpha', '2026.11.01'), { minBotVersion: '99.0.0' });
    lib.files.delete('/alpha.json'); // never asked for
    const { pm } = manager();
    await expect(pm.install('alpha')).rejects.toThrow(
      /needs Radio Bot 99\.0\.0 or later .* Update the bot first/,
    );
    const index = lib.writeTo(temp());
    const out: string[] = [];
    await runPacksCli(['add', 'alpha', '--from', index], {
      out: (l) => out.push(l),
      err: (l) => out.push(l),
      env: { DATABASE_PATH: join(temp(), 'radio-bot.sqlite') },
      http,
    });
    expect(out.join('\n')).toMatch(/needs Radio Bot 99\.0\.0 or later/);
  });

  it('leaves a withdrawn pack alone when it came from another library', async () => {
    lib.add(packFiles('alpha', '2026.11.01'));
    const store = new PackStore(join(temp(), 'installed-packs'));
    await store.install(
      checkBundle(bundleBytes(packFiles('alpha', '2026.11.01')), { id: 'alpha', sha256: null }),
      'https://other.example.org/index.json',
    );
    const registry = PackRegistry.load(null, undefined, store.dir);
    const { pm } = manager({ store, registry });
    lib.withdraw('alpha', '');
    await pm.check();
    expect(registry.get('alpha')).not.toBeNull();
    expect(pm.notices).toEqual([]);
  });
});
