import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_PACKS_DIR,
  discoverPackDirs,
  loadPack,
  PackRegistry,
  seedPacks,
} from '../../src/catalogue/packs.ts';
import { resolveStation, searchStations } from '../../src/catalogue/search.ts';
import { CatalogueSync } from '../../src/catalogue/sync.ts';
import { decodeEntities, extractJsonValue, parseWebradioApidata } from '../../src/catalogue/sync-adapters.ts';
import { metadataSignal } from '../../src/streams/identity.ts';
import type { SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import { memoryDb, PRD_STATION_NAMES, silentLogger } from '../helpers.ts';

const fgPack = () => loadPack(join(BUILTIN_PACKS_DIR(), 'fg'));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Writes a minimal pack folder; proves new station groups need no code. */
function writePack(
  root: string,
  id: string,
  extra: { stations?: unknown[]; sources?: unknown[]; meta?: object } = {},
) {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'pack.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: `Example ${id}`,
      categories: [{ id: 'news', name: 'News' }],
      brandLabels: ['Example Network'],
      ...extra.meta,
    }),
  );
  writeFileSync(
    join(dir, 'stations.json'),
    JSON.stringify({
      schemaVersion: 1,
      stations: extra.stations ?? [
        { slug: 'one', displayName: 'Example One', category: 'news', order: 1, aliases: ['E1'] },
        { slug: 'two', displayName: 'Example Two', order: 2 },
      ],
    }),
  );
  writeFileSync(
    join(dir, 'sources.json'),
    JSON.stringify({
      schemaVersion: 1,
      sources: extra.sources ?? [
        {
          id: `${id}-one-mp3`,
          station: 'one',
          url: 'https://radio.example.org/one.mp3',
          provenance: 'curated',
          provenanceDetail: 'Listed on the broadcaster website.',
        },
      ],
    }),
  );
  return dir;
}

const tempRoot = () => {
  const d = mkdtempSync(join(tmpdir(), 'radiobot-packs-'));
  dirs.push(d);
  return d;
};

describe('the FG starter pack (FR-001, §17.5)', () => {
  const pack = fgPack();

  it('is discovered as a pack folder like any other', () => {
    expect(discoverPackDirs(BUILTIN_PACKS_DIR()).map((d) => d.split(/[\\/]/).pop())).toContain('fg');
  });

  it('contains every one of the 63 snapshot names with a stable ID', () => {
    expect(pack.stations.map((s) => s.displayName)).toEqual(PRD_STATION_NAMES);
    for (const s of pack.stations) expect(s.id).toBe(`fg:${s.slug}`);
  });

  it('identifies the flagship as fg:fg-dj-radio, first in order', () => {
    expect(pack.stations[0]!.id).toBe('fg:fg-dj-radio');
  });

  it('includes the flagship candidates and gives every source provenance', () => {
    const urls = pack.sources.filter((s) => s.stationId === 'fg:fg-dj-radio').map((s) => s.url);
    expect(urls).toEqual(
      expect.arrayContaining([
        'https://stream.rcs.revma.com/gk9y379uquhvv',
        'https://stream.rcs.revma.com/gk9y379uquhvv/hls.m3u8',
        'https://stream.rcs.revma.com/wknqhm4yuchvv',
      ]),
    );
    for (const s of pack.sources) expect(s.provenanceDetail.length).toBeGreaterThan(0);
  });
});

describe('modular station packs', () => {
  it('loads an extra pack next to the built-in ones, in pack order, with no code changes', () => {
    const root = tempRoot();
    writePack(root, 'example', { meta: { order: 1 } });
    const registry = PackRegistry.load(root);
    expect(registry.packs.map((p) => p.meta.id)).toEqual(['example', 'fg']);
    const { stations } = memoryDb();
    const summary = seedPacks(stations, registry);
    expect(summary.packs).toBe(2);
    expect(stations.getStation('example:one')?.provider).toBe('example');
    expect(stations.listSources('example:one')[0]?.id).toBe('example-one-mp3');
    expect(registry.categories().some((c) => c.id === 'news' && c.packId === 'example')).toBe(true);
  });

  it('can switch packs on and off per installation', () => {
    const root = tempRoot();
    writePack(root, 'optin', { meta: { enabledByDefault: false } });
    expect(PackRegistry.load(root).isEnabled('optin')).toBe(false);
    expect(
      PackRegistry.load(root, { enabled: new Set(['optin']), disabled: new Set() }).isEnabled('optin'),
    ).toBe(true);
    expect(PackRegistry.load(root, { enabled: new Set(), disabled: new Set(['fg']) }).isEnabled('fg')).toBe(
      false,
    );
  });

  it('rejects broken packs with a precise message', () => {
    const root = tempRoot();
    expect(() => loadPack(writePack(root, 'custom'))).toThrow(/reserved/);
    expect(() =>
      loadPack(
        writePack(root, 'badref', {
          sources: [
            {
              id: 'x',
              station: 'nope',
              url: 'https://a.example.org/',
              provenance: 'curated',
              provenanceDetail: 'x',
            },
          ],
        }),
      ),
    ).toThrow(/unknown station "nope"/);
    expect(() =>
      loadPack(
        writePack(root, 'dupe', {
          stations: [
            { slug: 'a', displayName: 'Same', order: 1 },
            { slug: 'b', displayName: 'Other', aliases: ['same'], order: 2 },
          ],
          sources: [],
        }),
      ),
    ).toThrow(/used by both/);
    expect(() =>
      loadPack(
        writePack(root, 'badcat', {
          stations: [{ slug: 'a', displayName: 'A', category: 'zzz', order: 1 }],
          sources: [],
        }),
      ),
    ).toThrow(/undeclared category/);
  });

  it('rejects two packs with the same id or source id', () => {
    const root = tempRoot();
    writePack(root, 'fg');
    expect(() => PackRegistry.load(root)).toThrow(/Two packs use the id "fg"/);
    const other = tempRoot();
    writePack(other, 'copycat', {
      sources: [
        {
          id: 'fg-dj-radio-mp3-wknqhm4yuchvv',
          station: 'one',
          url: 'https://radio.example.org/copy.mp3',
          provenance: 'curated',
          provenanceDetail: 'x',
        },
      ],
    });
    expect(() => PackRegistry.load(other)).toThrow(
      /Source id "fg-dj-radio-mp3-wknqhm4yuchvv" is used by packs/,
    );
  });

  it('uses each pack’s own brand labels in identity checks', () => {
    const { stations } = memoryDb();
    const root = tempRoot();
    writePack(root, 'example');
    const registry = PackRegistry.load(root);
    seedPacks(stations, registry);
    const one = stations.getStation('example:one')!;
    const all = stations.listBuiltinStations();
    expect(metadataSignal(one, all, 'Example Network', registry.brandLabels('example')).verdict).toBe(
      'inconclusive',
    );
    expect(metadataSignal(one, all, 'Example Two', registry.brandLabels('example')).verdict).toBe(
      'contradicts',
    );
    expect(metadataSignal(one, all, 'Example One', registry.brandLabels('example')).verdict).toBe('supports');
  });
});

describe('search and resolution', () => {
  const { stations } = memoryDb();
  seedPacks(stations, PackRegistry.load(null));
  const all = stations.listStations(null);

  it.each([
    ['fg', 'fg:fg-dj-radio'],
    ['Radio FG', 'fg:fg-dj-radio'],
    ['fg-dj-radio', 'fg:fg-dj-radio'],
    ['FG CHIC', 'fg:fg-chic'],
    ['maxximum', 'fg:maxximum'],
    ['ushuaia ibiza', 'fg:fg-ushuaia-ibiza'],
    ['FG Chic and Chill', 'fg:fg-chic-and-chill'],
    ["maxximum 90's", 'fg:maxximum-90s'],
  ])('resolves %s exactly', (q, id) => {
    const r = resolveStation(all, q);
    expect(r.kind).toBe('match');
    if (r.kind === 'match') expect(r.station.id).toBe(id);
  });

  it('refuses to guess between similarly named stations', () => {
    const r = resolveStation(all, 'chic');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates.length).toBeGreaterThan(3);
  });

  it.each(['techno', 'ibiza', 'deep', 'chic'])('finds stations for "%s"', (q) => {
    expect(searchStations(all, q).length).toBeGreaterThan(0);
  });

  it('tolerates typos', () => {
    expect(searchStations(all, 'maximum')[0]?.station.id).toBe('fg:maxximum');
    expect(searchStations(all, 'fg tehcno')[0]?.station.id).toBe('fg:fg-techno');
  });
});

describe('seeding preserves runtime evidence', () => {
  it('keeps probe results on re-seed', () => {
    const { stations } = memoryDb();
    const registry = PackRegistry.load(null);
    expect(seedPacks(stations, registry).stationsInserted).toBe(63);
    stations.applyProbePatch('fg-dj-radio-mp3-wknqhm4yuchvv', { codec: 'mp3', measuredBitrateKbps: 128 });
    expect(seedPacks(stations, registry).stationsInserted).toBe(0);
    expect(stations.getSource('fg-dj-radio-mp3-wknqhm4yuchvv')?.measuredBitrateKbps).toBe(128);
  });

  it('applies manifest-disabled sources and disables sources removed from a pack', () => {
    const { stations } = memoryDb();
    const root = tempRoot();
    writePack(root, 'example');
    seedPacks(stations, PackRegistry.load(root));
    const disabled = stations.listAllSources().filter((s) => !s.enabled);
    expect(disabled.length).toBeGreaterThan(0);
    for (const s of disabled) expect(s.disabledReason).toBeTruthy();
    writePack(root, 'example', { sources: [] });
    expect(seedPacks(stations, PackRegistry.load(root)).sourcesDisabled).toBe(1);
    expect(stations.getSource('example-one-mp3')?.enabled).toBe(false);
  });
});

describe('official list sync (FR-002)', () => {
  const page = (entries: Array<{ id: string; label: string }>) =>
    `<html><script>var apidata = ${JSON.stringify({
      webradios: entries.map((e) => ({
        ...e,
        type: 'WEBRADIO',
        displayOnWebsite: true,
        hd: 'https://signed/token',
      })),
    })};</script></html>`;

  it('extracts JSON values with braces inside strings', () => {
    const text = 'var x = {"a":"}{","b":[1,{"c":2}]}; trailing';
    expect(JSON.parse(extractJsonValue(text, text.indexOf('{'))!)).toEqual({ a: '}{', b: [1, { c: 2 }] });
  });

  it('parses names and stable ids but never the signed play URLs', () => {
    expect(parseWebradioApidata(page([{ id: 'abc', label: 'FG CHIC &amp; CHILL' }]))).toEqual([
      { externalId: 'abc', name: 'FG CHIC & CHILL' },
    ]);
  });

  it('decodes each HTML entity exactly once', () => {
    expect(decodeEntities('&amp;quot;')).toBe('&quot;');
    expect(decodeEntities('&amp;lt;b&amp;gt; &amp;#39;')).toBe('&lt;b&gt; &#39;');
    expect(decodeEntities('&quot;R&amp;B&quot; &lt;3 &#39;80s&#x27; &apos;&#x26;&#38;')).toBe(
      "\"R&B\" <3 '80s' '&&",
    );
  });

  it('leaves invalid numeric entities as they are instead of throwing', () => {
    expect(decodeEntities('A &#99999999; B &#x110000;')).toBe('A &#99999999; B &#x110000;');
    const html = '<nav class="HeaderSources"><button class="dropdown-item">FG &#99999999;</button></nav>';
    expect(parseWebradioApidata(html).map((e) => e.name)).toEqual(['FG &#99999999;']);
  });

  it('falls back to the header dropdown markup', () => {
    const html =
      '<nav class="HeaderSources"><button class="dropdown-item">FG DANCE</button><button class="dropdown-item">FG CHIC</button></nav>';
    expect(parseWebradioApidata(html).map((e) => e.name)).toEqual(['FG DANCE', 'FG CHIC']);
  });

  it('renames by stable id, keeps favourites, reports added/missing, and fails safe', async () => {
    const { stations, guilds, meta } = memoryDb();
    const registry = PackRegistry.load(null);
    seedPacks(stations, registry);
    guilds.toggleFavourite('111111111111111111', 'fg:fg-dance');
    const entries = fgPack().stations.map((s) => ({ id: s.externalId!, label: s.displayName }));
    entries.find((e) => e.label === 'FG DANCE')!.label = 'FG DANCE NATION';
    entries.splice(
      entries.findIndex((e) => e.label === 'FG YOGA'),
      1,
    );
    entries.push({ id: 'NEWID00001', label: 'FG BRAND NEW' });
    let html = page(entries);
    const http = {
      fetchText: async () => ({ text: html, finalUrl: new URL('https://x'), status: 200, headers: {} }),
    };
    const sync = new CatalogueSync(
      stations,
      meta,
      http as unknown as SafeHttpClient,
      registry,
      silentLogger(),
    );
    expect(sync.syncablePacks().map((p) => p.meta.id)).toEqual(['fg']);

    const r = await sync.sync('fg', 'admin');
    expect(r.ok).toBe(true);
    expect(r.renamed).toEqual([{ from: 'FG DANCE', to: 'FG DANCE NATION' }]);
    expect(r.missing).toEqual(['FG YOGA']);
    expect(r.added).toEqual(['FG BRAND NEW']);
    expect(stations.getStation('fg:fg-brand-new')?.provider).toBe('fg');
    const dance = stations.getStation('fg:fg-dance')!;
    expect(dance.displayName).toBe('FG DANCE NATION');
    expect(dance.aliases).toContain('FG DANCE');
    seedPacks(stations, registry);
    expect(stations.getStation('fg:fg-dance')?.displayName).toBe('FG DANCE NATION');
    expect(guilds.listFavourites('111111111111111111')).toEqual(['fg:fg-dance']);
    expect(stations.getStation('fg:fg-yoga')?.catalogueStatus).toBe('missing_from_official');

    html = '<html>maintenance</html>';
    const failed = await sync.sync('fg', 'admin');
    expect(failed.ok).toBe(false);
    expect(stations.getStation('fg:fg-dance')?.displayName).toBe('FG DANCE NATION');
    expect(stations.listProviderStations('fg').length).toBe(64);
  });

  it('applies a sync all-or-nothing and keeps reports per pack', async () => {
    const { stations, meta } = memoryDb();
    const registry = PackRegistry.load(null);
    seedPacks(stations, registry);
    const entries = fgPack().stations.map((s) => ({ id: s.externalId!, label: s.displayName }));
    entries.find((e) => e.label === 'FG DANCE')!.label = 'FG DANCE NATION';
    entries.push({ id: 'NEWID00001', label: 'FG BRAND NEW' });
    const http = {
      fetchText: async () => ({
        text: page(entries),
        finalUrl: new URL('https://x'),
        status: 200,
        headers: {},
      }),
    };
    const sync = new CatalogueSync(
      stations,
      meta,
      http as unknown as SafeHttpClient,
      registry,
      silentLogger(),
    );
    // The rename is written first; the new station's insert then fails.
    const insert = stations.upsertProviderStation.bind(stations);
    stations.upsertProviderStation = () => {
      throw new Error('disk full');
    };
    const failed = await sync.sync('fg', 'admin');
    expect(failed).toMatchObject({ ok: false, error: 'disk full', renamed: [], added: [] });
    expect(stations.getStation('fg:fg-dance')?.displayName).toBe('FG DANCE');
    stations.upsertProviderStation = insert;

    // Another pack's syncs never evict this pack's history.
    for (let i = 0; i < 60; i++) {
      stations.insertSyncReport({
        provider: 'other',
        startedAt: 'x',
        finishedAt: 'x',
        success: true,
        trigger: 'admin',
        summary: {},
      });
    }
    expect(stations.lastSyncReport('fg')?.success).toBe(false);
  });

  it('syncs any pack with a declared adapter (json-name-list)', async () => {
    const { stations, meta } = memoryDb();
    const root = tempRoot();
    writePack(root, 'example', {
      meta: { sync: { adapter: 'json-name-list', url: 'https://example.org/list.json' } },
    });
    const registry = PackRegistry.load(root, { enabled: new Set(), disabled: new Set(['fg']) });
    seedPacks(stations, registry);
    const http = {
      fetchText: async () => ({
        text: JSON.stringify([
          { id: 1, name: 'Example One' },
          { id: 3, name: 'Example Three' },
        ]),
        finalUrl: new URL('https://example.org'),
        status: 200,
        headers: {},
      }),
    };
    const sync = new CatalogueSync(
      stations,
      meta,
      http as unknown as SafeHttpClient,
      registry,
      silentLogger(),
    );
    expect(sync.syncablePacks().map((p) => p.meta.id)).toEqual(['example']);
    const r = await sync.sync('example', 'admin');
    expect(r.ok).toBe(true);
    expect(r.added).toEqual(['Example Three']);
    expect(r.missing).toEqual(['Example Two']);
  });
});
