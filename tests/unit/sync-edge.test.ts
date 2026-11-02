import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPack, PackRegistry, seedPacks } from '../../src/catalogue/packs.ts';
import { CatalogueSync } from '../../src/catalogue/sync.ts';
import type { SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import { memoryDb, silentLogger } from '../helpers.ts';

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const STATIONS = [
  { slug: 'one', displayName: 'Example One', order: 1 },
  { slug: 'two', displayName: 'Example Two', order: 2 },
  { slug: 'three', displayName: 'Example Three', order: 3 },
  { slug: 'four', displayName: 'Example Four', order: 4 },
];

/** Writes a pack to a temp folder and loads it. */
function makePack(id: string, opts: { sync?: boolean; sources?: unknown[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'radiobot-sync-'));
  dirs.push(root);
  const dir = join(root, id);
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'pack.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: `Pack ${id}`,
      ...(opts.sync === false
        ? {}
        : { sync: { adapter: 'json-name-list', url: 'https://lists.example.org/stations.json' } }),
    }),
  );
  writeFileSync(join(dir, 'stations.json'), JSON.stringify({ schemaVersion: 1, stations: STATIONS }));
  writeFileSync(join(dir, 'sources.json'), JSON.stringify({ schemaVersion: 1, sources: opts.sources ?? [] }));
  return loadPack(dir);
}

const source = (id: string, station: string) => ({
  id,
  station,
  url: `https://radio.example.org/${id}.mp3`,
  provenance: 'curated',
  provenanceDetail: 'Listed on the station website.',
});

function setup(names: string[] | (() => string), packs = [makePack('mypack')]) {
  const t = memoryDb();
  const registry = new PackRegistry(packs);
  seedPacks(t.stations, registry);
  const fetchText = vi.fn(async () => ({
    text: typeof names === 'function' ? names() : JSON.stringify(names.map((name) => ({ name }))),
    finalUrl: new URL('https://lists.example.org/stations.json'),
    status: 200,
    headers: {},
  }));
  const sync = new CatalogueSync(
    t.stations,
    t.meta,
    { fetchText } as unknown as SafeHttpClient,
    registry,
    silentLogger(),
  );
  return { ...t, registry, sync, fetchText };
}

const ALL = STATIONS.map((s) => s.displayName);

describe('CatalogueSync: last sync and staleness', () => {
  it('is stale before any sync and fresh after one, until three intervals pass', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { sync, meta } = setup(ALL);
    expect(sync.lastSync('mypack')).toEqual({ at: null, ok: false });
    expect(sync.isStale('mypack', 1)).toBe(true);

    const r = await sync.sync('mypack', 'scheduled');
    expect(r.ok).toBe(true);
    expect(r.unchanged).toBe(4);
    expect(sync.lastSync('mypack')).toEqual({ at: '2026-01-01T00:00:00.000Z', ok: true });
    expect(meta.get('catalogue.mypack.lastSyncAttempt')).toBe('2026-01-01T00:00:00.000Z');
    expect(sync.isStale('mypack', 1)).toBe(false);

    vi.setSystemTime(new Date('2026-01-01T02:59:00Z'));
    expect(sync.isStale('mypack', 1)).toBe(false);
    vi.setSystemTime(new Date('2026-01-01T03:01:00Z'));
    expect(sync.isStale('mypack', 1)).toBe(true);
  });

  it('reports the last attempt as failed while keeping the last success time', async () => {
    let body = JSON.stringify(ALL.map((name) => ({ name })));
    const { sync } = setup(() => body);
    await sync.sync('mypack', 'admin');
    const at = sync.lastSync('mypack').at;
    body = '[]';
    const failed = await sync.sync('mypack', 'admin');
    expect(failed.ok).toBe(false);
    expect(sync.lastSync('mypack')).toEqual({ at, ok: false });
  });
});

describe('CatalogueSync: failures change nothing', () => {
  it('refuses a pack it does not know, naming it by its ID', async () => {
    const { sync, fetchText } = setup(ALL);
    const r = await sync.sync('nopack', 'admin');
    expect(r).toMatchObject({
      ok: false,
      packName: 'nopack',
      error: expect.stringMatching(/no official list/),
    });
    expect(fetchText).not.toHaveBeenCalled();
  });

  it('refuses a pack without an official list', async () => {
    const { sync, stations } = setup(ALL, [makePack('mypack', { sync: false })]);
    expect(sync.syncablePacks()).toEqual([]);
    const r = await sync.sync('mypack', 'admin');
    expect(r).toMatchObject({ ok: false, packName: 'Pack mypack' });
    expect(stations.lastSyncReport('mypack')?.success).toBe(false);
  });

  it('refuses an adapter that does not exist', async () => {
    const pack = makePack('mypack');
    (pack.meta.sync as { adapter: string }).adapter = 'no-such-adapter';
    const { sync, fetchText } = setup(ALL, [pack]);
    const r = await sync.sync('mypack', 'admin');
    expect(r.error).toMatch(/Unknown sync adapter "no-such-adapter"/);
    expect(fetchText).not.toHaveBeenCalled();
  });

  it('refuses a list that shrank to too few names', async () => {
    const { sync, stations } = setup(['Example One']);
    const r = await sync.sync('mypack', 'admin');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/it had 1 names/);
    expect(stations.listProviderStations('mypack').every((s) => s.catalogueStatus === 'active')).toBe(true);
  });

  it('reports a fetch error as the error message', async () => {
    const { sync, fetchText } = setup(ALL);
    fetchText.mockRejectedValueOnce(new Error('socket hang up'));
    const r = await sync.sync('mypack', 'startup');
    expect(r).toMatchObject({ ok: false, error: 'socket hang up' });
  });
});

describe('CatalogueSync: applying a list', () => {
  it('syncs every syncable pack in turn', async () => {
    const { sync } = setup(ALL, [makePack('mypack'), makePack('otherpack', { sync: false })]);
    const reports = await sync.syncAll('scheduled');
    expect(reports.map((r) => [r.packId, r.ok])).toEqual([['mypack', true]]);
  });

  it('marks returning stations, leaves retired ones retired and refreshes last-seen dates', async () => {
    const { sync, stations } = setup(ALL);
    stations.setCatalogueStatus('mypack:two', 'missing_from_official');
    stations.setCatalogueStatus('mypack:three', 'retired');
    stations.setCatalogueStatus('mypack:four', 'active', '2020-01-01');
    const r = await sync.sync('mypack', 'admin');
    expect(r.returned).toEqual(['Example Two']);
    expect(stations.getStation('mypack:two')?.catalogueStatus).toBe('active');
    expect(stations.getStation('mypack:three')?.catalogueStatus).toBe('retired');
    const today = new Date().toISOString().slice(0, 10);
    expect(stations.getStation('mypack:four')?.officialLastSeenAt).toBe(today);
    expect(r.missing).toEqual([]);
  });

  it('gives a new station a free slug, falling back to "station" for a name with no letters', async () => {
    const { sync, stations } = setup([...ALL, 'One', '!!!']);
    const r = await sync.sync('mypack', 'admin');
    expect(r.added).toEqual(['One', '!!!']);
    expect(r.needsSourceMapping).toEqual(['One', '!!!']);
    expect(stations.getStation('mypack:one-2')?.displayName).toBe('One');
    expect(stations.getStation('mypack:station')?.displayName).toBe('!!!');
    expect(stations.getStation('mypack:one')?.displayName).toBe('Example One');
  });

  it('lists stations whose every probed source is offline as unreachable', async () => {
    const pack = makePack('mypack', {
      sources: [
        source('one-a', 'one'),
        source('one-b', 'one'),
        source('two-a', 'two'),
        source('two-b', 'two'),
        source('three-a', 'three'),
      ],
    });
    const { sync, stations } = setup(ALL, [pack]);
    const at = new Date().toISOString();
    // One: every probed source is offline; an unprobed source doesn't count.
    stations.applyProbePatch('one-a', { verificationState: 'offline', lastProbeAt: at });
    // Two: one source still works.
    stations.applyProbePatch('two-a', { verificationState: 'offline', lastProbeAt: at });
    stations.applyProbePatch('two-b', { verificationState: 'eligible', lastProbeAt: at });
    // Three: offline but switched off, so nothing probed and enabled remains.
    stations.applyProbePatch('three-a', { verificationState: 'offline', lastProbeAt: at });
    stations.setSourceEnabled('three-a', false, 'gone');
    const r = await sync.sync('mypack', 'admin');
    expect(r.unreachable).toEqual(['Example One']);
  });
});
