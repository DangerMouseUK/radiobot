import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { discoverPackDirs, loadPack, PackRegistry, seedPacks } from '../../src/catalogue/packs.ts';
import { resolveStation, searchStations } from '../../src/catalogue/search.ts';
import { CatalogueSync } from '../../src/catalogue/sync.ts';
import { decodeEntities, extractJsonValue, parseWebradioApidata } from '../../src/catalogue/sync-adapters.ts';
import type { Logger } from '../../src/observability/logger.ts';
import { metadataSignal } from '../../src/streams/identity.ts';
import type { SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import {
  DEMO_PACK_DIR,
  demoPack,
  demoRegistry,
  FIXTURE_PACKS_DIR,
  memoryDb,
  silentLogger,
} from '../helpers.ts';

/** Stations in the made-up fixture pack (tests/fixtures/packs/demo). */
const DEMO_STATIONS = 26;

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

describe('a station pack folder (FR-001, §17.5)', () => {
  const pack = demoPack();

  it('is discovered as a pack folder like any other', () => {
    expect(discoverPackDirs(FIXTURE_PACKS_DIR)).toEqual([DEMO_PACK_DIR]);
    expect(pack.origin).toBe('extra');
    expect(pack.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives every station a stable ID made of the pack id and its slug', () => {
    expect(pack.stations).toHaveLength(DEMO_STATIONS);
    for (const s of pack.stations) expect(s.id).toBe(`demo:${s.slug}`);
  });

  it('reads the optional pack metadata', () => {
    expect(pack.meta).toMatchObject({
      version: '2026.11.03',
      owner: { name: 'Demo Media', kind: 'group', brand: null },
      countries: ['GB'],
      languages: ['en'],
      sync: { adapter: 'json-name-list', url: 'https://lists.example.org/demo.json' },
    });
  });

  it('identifies the flagship as demo:demo-radio, first in order', () => {
    expect(pack.stations[0]!.id).toBe('demo:demo-radio');
  });

  it('includes the flagship candidates and gives every source provenance', () => {
    const urls = pack.sources.filter((s) => s.stationId === 'demo:demo-radio').map((s) => s.url);
    expect(urls).toEqual(
      expect.arrayContaining([
        'https://stream.example.org/demo-radio.mp3',
        'https://stream.example.org/demo-radio/hls.m3u8',
        'https://stream.example.org/demo-radio.aac',
      ]),
    );
    for (const s of pack.sources) expect(s.provenanceDetail.length).toBeGreaterThan(0);
  });
});

describe('modular station packs', () => {
  it('loads EXTRA_PACKS_DIR next to the built-in packs, whatever catalog/packs holds', () => {
    const root = tempRoot();
    writePack(root, 'example');
    const registry = PackRegistry.load(root);
    expect(registry.get('example')?.origin).toBe('extra');
    expect(registry.packs.filter((p) => p.origin !== 'builtin').map((p) => p.meta.id)).toEqual(['example']);
  });

  it('loads an extra pack next to another, in pack order, with no code changes', () => {
    const root = tempRoot();
    writePack(root, 'example', { meta: { order: 1 } });
    const registry = demoRegistry(root);
    expect(registry.packs.map((p) => p.meta.id)).toEqual(['example', 'demo']);
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
    expect(demoRegistry(root).isEnabled('demo')).toBe(true);
    expect(demoRegistry(root, { enabled: new Set(), disabled: new Set(['demo']) }).isEnabled('demo')).toBe(
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
    writePack(root, 'demo');
    expect(() => demoRegistry(root)).toThrow(/Two packs use the id "demo"/);
    const other = tempRoot();
    writePack(other, 'copycat', {
      sources: [
        {
          id: 'demo-radio-mp3',
          station: 'one',
          url: 'https://radio.example.org/copy.mp3',
          provenance: 'curated',
          provenanceDetail: 'x',
        },
      ],
    });
    expect(() => demoRegistry(other)).toThrow(/Source id "demo-radio-mp3" is used by packs/);
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
  seedPacks(stations, demoRegistry());
  const all = stations.listStations(null);

  it.each([
    ['demo', 'demo:demo-radio'],
    ['Radio Demo', 'demo:demo-radio'],
    ['demo-radio', 'demo:demo-radio'],
    ['Demo Chic', 'demo:demo-chic'],
    ['maximum', 'demo:maximum'],
    ['cafe ibiza', 'demo:demo-cafe-ibiza'],
    ['Demo Chic and Chill', 'demo:demo-chic-and-chill'],
    ["maximum 90's", 'demo:maximum-90s'],
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
    expect(searchStations(all, 'maximun')[0]?.station.id).toBe('demo:maximum');
    expect(searchStations(all, 'demo tehcno')[0]?.station.id).toBe('demo:demo-techno');
  });
});

describe('seeding preserves runtime evidence', () => {
  it('keeps probe results on re-seed', () => {
    const { stations } = memoryDb();
    const registry = demoRegistry();
    expect(seedPacks(stations, registry).stationsInserted).toBe(DEMO_STATIONS);
    stations.applyProbePatch('demo-radio-mp3', { codec: 'mp3', measuredBitrateKbps: 128 });
    expect(seedPacks(stations, registry).stationsInserted).toBe(0);
    expect(stations.getSource('demo-radio-mp3')?.measuredBitrateKbps).toBe(128);
  });

  it('applies manifest-disabled sources and disables sources removed from a pack', () => {
    const { stations } = memoryDb();
    const root = tempRoot();
    writePack(root, 'example');
    seedPacks(stations, demoRegistry(root));
    const disabled = stations.listAllSources().filter((s) => !s.enabled);
    expect(disabled.length).toBeGreaterThan(0);
    for (const s of disabled) expect(s.disabledReason).toBeTruthy();
    writePack(root, 'example', { sources: [] });
    expect(seedPacks(stations, demoRegistry(root)).sourcesDisabled).toBe(1);
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
  /** The demo pack's official list (json-name-list). */
  const nameList = (entries: Array<{ id: string; label: string }>) =>
    JSON.stringify(entries.map((e) => ({ id: e.id, name: e.label })));

  it('extracts JSON values with braces inside strings', () => {
    const text = 'var x = {"a":"}{","b":[1,{"c":2}]}; trailing';
    expect(JSON.parse(extractJsonValue(text, text.indexOf('{'))!)).toEqual({ a: '}{', b: [1, { c: 2 }] });
  });

  it('parses names and stable ids but never the signed play URLs', () => {
    expect(parseWebradioApidata(page([{ id: 'abc', label: 'Demo Chic &amp; Chill' }]))).toEqual([
      { externalId: 'abc', name: 'Demo Chic & Chill' },
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
    const html = '<nav class="HeaderSources"><button class="dropdown-item">Demo &#99999999;</button></nav>';
    expect(parseWebradioApidata(html).map((e) => e.name)).toEqual(['Demo &#99999999;']);
  });

  it('falls back to the header dropdown markup', () => {
    const html =
      '<nav class="HeaderSources"><button class="dropdown-item">Demo Dance</button><button class="dropdown-item">Demo Chic</button></nav>';
    expect(parseWebradioApidata(html).map((e) => e.name)).toEqual(['Demo Dance', 'Demo Chic']);
  });

  it('renames by stable id, keeps favourites, reports added/missing, and fails safe', async () => {
    const { stations, guilds, meta } = memoryDb();
    const registry = demoRegistry();
    seedPacks(stations, registry);
    guilds.toggleFavourite('111111111111111111', 'demo:demo-dance');
    const entries = demoPack().stations.map((s) => ({ id: s.externalId!, label: s.displayName }));
    entries.find((e) => e.label === 'Demo Dance')!.label = 'Demo Dance Nation';
    entries.splice(
      entries.findIndex((e) => e.label === 'Demo Yoga'),
      1,
    );
    entries.push({ id: 'NEWID00001', label: 'Demo Brand New' });
    let body = nameList(entries);
    const http = {
      fetchBytes: async () => ({ bytes: Buffer.from(body), finalUrl: new URL('https://x'), headers: {} }),
    };
    const sync = new CatalogueSync(
      stations,
      meta,
      http as unknown as SafeHttpClient,
      registry,
      silentLogger(),
    );
    expect(sync.syncablePacks().map((p) => p.meta.id)).toEqual(['demo']);

    const r = await sync.sync('demo', 'admin');
    expect(r.ok).toBe(true);
    expect(r.renamed).toEqual([{ from: 'Demo Dance', to: 'Demo Dance Nation' }]);
    expect(r.missing).toEqual(['Demo Yoga']);
    expect(r.added).toEqual(['Demo Brand New']);
    expect(stations.getStation('demo:demo-brand-new')?.provider).toBe('demo');
    const dance = stations.getStation('demo:demo-dance')!;
    expect(dance.displayName).toBe('Demo Dance Nation');
    expect(dance.aliases).toContain('Demo Dance');
    seedPacks(stations, registry);
    expect(stations.getStation('demo:demo-dance')?.displayName).toBe('Demo Dance Nation');
    expect(guilds.listFavourites('111111111111111111')).toEqual(['demo:demo-dance']);
    expect(stations.getStation('demo:demo-yoga')?.catalogueStatus).toBe('missing_from_official');

    body = '<html>maintenance</html>';
    const failed = await sync.sync('demo', 'admin');
    expect(failed.ok).toBe(false);
    expect(stations.getStation('demo:demo-dance')?.displayName).toBe('Demo Dance Nation');
    expect(stations.listProviderStations('demo').length).toBe(DEMO_STATIONS + 1);
  });

  it('applies a sync all-or-nothing and keeps reports per pack', async () => {
    const { stations, meta } = memoryDb();
    const registry = demoRegistry();
    seedPacks(stations, registry);
    const entries = demoPack().stations.map((s) => ({ id: s.externalId!, label: s.displayName }));
    entries.find((e) => e.label === 'Demo Dance')!.label = 'Demo Dance Nation';
    entries.push({ id: 'NEWID00001', label: 'Demo Brand New' });
    const http = {
      fetchBytes: async () => ({
        bytes: Buffer.from(nameList(entries)),
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
    const failed = await sync.sync('demo', 'admin');
    expect(failed).toMatchObject({ ok: false, error: 'disk full', renamed: [], added: [] });
    expect(stations.getStation('demo:demo-dance')?.displayName).toBe('Demo Dance');
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
    expect(stations.lastSyncReport('demo')?.success).toBe(false);
  });

  it('syncs any pack with a declared adapter (json-name-list)', async () => {
    const { stations, meta } = memoryDb();
    const root = tempRoot();
    writePack(root, 'example', {
      meta: { sync: { adapter: 'json-name-list', url: 'https://example.org/list.json' } },
    });
    const registry = demoRegistry(root, { enabled: new Set(), disabled: new Set(['demo']) });
    seedPacks(stations, registry);
    const http = {
      fetchBytes: async () => ({
        bytes: Buffer.from(
          JSON.stringify([
            { id: 1, name: 'Example One' },
            { id: 3, name: 'Example Three' },
          ]),
        ),
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

  it('redacts URLs with tokens from a failed sync’s error before storing and logging it', async () => {
    const { stations, meta } = memoryDb();
    const root = tempRoot();
    writePack(root, 'example', {
      meta: { sync: { adapter: 'json-name-list', url: 'https://example.org/list.json' } },
    });
    const registry = demoRegistry(root, { enabled: new Set(), disabled: new Set(['demo']) });
    seedPacks(stations, registry);
    const http = {
      fetchBytes: async () => {
        throw new Error('connect failed for https://example.org/list.json?token=SECRET123');
      },
    };
    const warn = vi.fn();
    const logger = { child: () => ({ warn }) } as unknown as Logger;
    const sync = new CatalogueSync(stations, meta, http as unknown as SafeHttpClient, registry, logger);
    const r = await sync.sync('example', 'admin');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('connect failed for https://example.org/list.json?***');
    expect(JSON.stringify(stations.lastSyncReport('example')?.summary)).not.toContain('SECRET123');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('SECRET123');
  });

  it('accepts a renamed station only when one missing name is clearly the most similar', async () => {
    const run = async (stationNames: string[], listed: string[]) => {
      const { stations, meta } = memoryDb();
      const root = tempRoot();
      writePack(root, 'example', {
        meta: { sync: { adapter: 'json-name-list', url: 'https://example.org/list.json' } },
        stations: stationNames.map((displayName, i) => ({ slug: `s${i}`, displayName, order: i })),
        sources: [],
      });
      const registry = demoRegistry(root, { enabled: new Set(), disabled: new Set(['demo']) });
      seedPacks(stations, registry);
      const http = {
        fetchBytes: async () => ({
          bytes: Buffer.from(JSON.stringify(listed.map((name, id) => ({ id, name })))),
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
      return sync.sync('example', 'admin');
    };
    const renamed = await run(['Example One', 'Example Two'], ['Example One', 'Example Twoo']);
    expect(renamed.renamed).toEqual([{ from: 'Example Two', to: 'Example Twoo' }]);
    expect(renamed.added).toEqual([]);
    // Two missing names are about as close as each other: no guess, the new name is added.
    const unsure = await run(['Example One', 'Example Two', 'Example Twp'], ['Example One', 'Example Twq']);
    expect(unsure.renamed).toEqual([]);
    expect(unsure.added).toEqual(['Example Twq']);
  });
});
