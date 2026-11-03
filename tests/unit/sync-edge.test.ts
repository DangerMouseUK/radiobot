import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadPack, PackRegistry, seedPacks } from '../../src/catalogue/packs.ts';
import {
  CatalogueSync,
  type CatalogueSyncOptions,
  MAX_OFFICIAL_ENTRIES,
  parseOfficialListInWorker,
} from '../../src/catalogue/sync.ts';
import { parseOfficialList } from '../../src/catalogue/sync-adapters.ts';
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

function setup(
  names: string[] | (() => string),
  packs = [makePack('mypack')],
  opts: CatalogueSyncOptions = {},
) {
  const t = memoryDb();
  const registry = new PackRegistry(packs);
  seedPacks(t.stations, registry);
  const fetchBytes = vi.fn(async () => ({
    bytes: Buffer.from(
      typeof names === 'function' ? names() : JSON.stringify(names.map((name) => ({ name }))),
    ),
    finalUrl: new URL('https://lists.example.org/stations.json'),
    headers: {},
  }));
  const sync = new CatalogueSync(
    t.stations,
    t.meta,
    { fetchBytes } as unknown as SafeHttpClient,
    registry,
    silentLogger(),
    opts,
  );
  return { ...t, registry, sync, fetchBytes };
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
    const { sync, fetchBytes } = setup(ALL);
    const r = await sync.sync('nopack', 'admin');
    expect(r).toMatchObject({
      ok: false,
      packName: 'nopack',
      error: expect.stringMatching(/no official list/),
    });
    expect(fetchBytes).not.toHaveBeenCalled();
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
    const { sync, fetchBytes } = setup(ALL, [pack]);
    const r = await sync.sync('mypack', 'admin');
    expect(r.error).toMatch(/Unknown sync adapter "no-such-adapter"/);
    expect(fetchBytes).not.toHaveBeenCalled();
  });

  it('refuses a list that shrank to too few names', async () => {
    const { sync, stations } = setup(['Example One']);
    const r = await sync.sync('mypack', 'admin');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/it had 1 names/);
    expect(stations.listProviderStations('mypack').every((s) => s.catalogueStatus === 'active')).toBe(true);
  });

  it('reports a fetch error as the error message', async () => {
    const { sync, fetchBytes } = setup(ALL);
    fetchBytes.mockRejectedValueOnce(new Error('socket hang up'));
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

describe('CatalogueSync: staying off the voice thread', () => {
  it('reads the list on a worker thread, returning only names and IDs', async () => {
    const apidata = {
      webradios: [
        { id: 'abc', label: 'Example &amp; One', hd: 'https://streams.example.org/play/signed?format=hd' },
        { id: 'def', label: 'Example Two' },
      ],
    };
    const html = `<html><script>var apidata = ${JSON.stringify(apidata)};</script></html>`;
    expect(await parseOfficialListInWorker('webradio-apidata', Buffer.from(html))).toEqual([
      { externalId: 'abc', name: 'Example & One' },
      { externalId: 'def', name: 'Example Two' },
    ]);
  });

  it('passes on what went wrong in the worker, and can be cancelled', async () => {
    await expect(parseOfficialListInWorker('json-name-list', Buffer.from('{ nope'))).rejects.toThrow(/JSON/);
    await expect(parseOfficialListInWorker('no-such-adapter', Buffer.from('[]'))).rejects.toThrow(
      /Unknown sync adapter/,
    );
    const abort = new AbortController();
    abort.abort();
    await expect(
      parseOfficialListInWorker('json-name-list', Buffer.from('[]'), abort.signal),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('sends back at most one entry more than the limit, and only names and IDs', () => {
    const list = Array.from({ length: 10 }, (_, i) => ({
      id: i,
      name: `Example ${i}`,
      url: 'https://x.example',
    }));
    const r = parseOfficialList({
      adapter: 'json-name-list',
      bytes: Buffer.from(JSON.stringify(list)),
      maxEntries: 3,
    });
    expect(r).toEqual({
      ok: true,
      entries: [0, 1, 2, 3].map((i) => ({ externalId: String(i), name: `Example ${i}` })),
    });
    // Reads a view into a larger buffer correctly.
    const padded = Buffer.from(`xx${JSON.stringify(list.slice(0, 1))}yy`);
    expect(
      parseOfficialList({
        adapter: 'json-name-list',
        bytes: padded.subarray(2, padded.length - 2),
        maxEntries: 5,
      }),
    ).toEqual({ ok: true, entries: [{ externalId: '0', name: 'Example 0' }] });
    expect(parseOfficialList({ adapter: 'nope', bytes: Buffer.from('[]'), maxEntries: 5 })).toEqual({
      ok: false,
      error: 'Unknown sync adapter "nope".',
    });
  });

  it('refuses a list with more names than any station group has', async () => {
    const { sync, stations } = setup(() =>
      JSON.stringify(Array.from({ length: MAX_OFFICIAL_ENTRIES + 1 }, (_, i) => ({ name: `Example ${i}` }))),
    );
    const r = await sync.sync('mypack', 'admin');
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/too many names/) });
    expect(stations.listProviderStations('mypack')).toHaveLength(4);
  });

  it('gives the event loop turns, and splits a very large change into several transactions', async () => {
    const extra = Array.from({ length: 20 }, (_, i) => `New Example ${i}`);
    // Every look at this clock takes 1 ms, so a 2 ms slice ends almost at once; 5 changes per transaction.
    let clock = 0;
    const sliced = setup([...ALL, ...extra], undefined, { now: () => ++clock, sliceMs: 2, batchSize: 5 });
    const transactions = vi.spyOn(sliced.stations, 'transaction');
    let turns = 0;
    let done = false;
    const spin = () => {
      if (done) return;
      turns++;
      setImmediate(spin);
    };
    setImmediate(spin);
    const r = await sliced.sync.sync('mypack', 'admin');
    done = true;
    expect(r.ok).toBe(true);
    // The stations still listed (one statement), then 20 new ones, 5 to a transaction.
    expect(transactions).toHaveBeenCalledTimes(5);
    expect(turns).toBeGreaterThan(10);

    // The same outcome as a sync done in one go.
    const whole = setup([...ALL, ...extra], undefined, { sliceMs: 60_000, batchSize: 1000 });
    const one = vi.spyOn(whole.stations, 'transaction');
    const w = await whole.sync.sync('mypack', 'admin');
    expect(one).toHaveBeenCalledOnce();
    const view = (rep: typeof r) => ({ ...rep, checkedAt: null });
    expect(view(r)).toEqual(view(w));
    const names = (s: typeof sliced.stations) =>
      s.listProviderStations('mypack').map((st) => [st.id, st.displayName, st.catalogueStatus]);
    expect(names(sliced.stations)).toEqual(names(whole.stations));
    expect(r.added).toEqual(extra);
  });

  it('marks the stations still listed as seen a batch at a time, not in one long statement', async () => {
    const { sync, stations } = setup(ALL, undefined, { batchSize: 3 });
    const transactions = vi.spyOn(stations, 'transaction');
    const markSeen = vi.spyOn(stations, 'markSeen');
    const r = await sync.sync('mypack', 'admin');
    expect(r).toMatchObject({ ok: true, unchanged: 4, added: [] });
    expect(markSeen.mock.calls.map(([ids]) => ids.length)).toEqual([3, 1]);
    expect(transactions).toHaveBeenCalledTimes(2);
    const today = new Date().toISOString().slice(0, 10);
    expect(stations.listProviderStations('mypack').map((s) => s.officialLastSeenAt?.slice(0, 10))).toEqual([
      today,
      today,
      today,
      today,
    ]);
    // Seen already today: nothing to mark, and the report still counts them.
    markSeen.mockClear();
    expect(await sync.sync('mypack', 'admin')).toMatchObject({ ok: true, unchanged: 4 });
    expect(markSeen).not.toHaveBeenCalled();
  });

  it('keeps what an earlier transaction wrote when a later one fails, and reports just that', async () => {
    // One change per transaction.
    const { sync, stations } = setup([...ALL, 'New One', 'New Two'], undefined, { batchSize: 1 });
    const insert = stations.upsertProviderStation.bind(stations);
    let inserts = 0;
    stations.upsertProviderStation = (seed) => {
      if (++inserts === 2) throw new Error('disk full');
      return insert(seed);
    };
    const r = await sync.sync('mypack', 'admin');
    expect(r).toMatchObject({ ok: false, error: 'disk full', added: ['New One'], unchanged: 4 });
    expect(stations.getStation('mypack:new-one')?.displayName).toBe('New One');
    expect(stations.getStation('mypack:new-two')).toBeNull();
  });

  it('runs one sync at a time, so two never interleave their changes', async () => {
    const { sync, fetchBytes } = setup(ALL);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = fetchBytes.getMockImplementation()!;
    fetchBytes.mockImplementationOnce(async () => {
      await gate;
      return original();
    });
    const first = sync.sync('mypack', 'scheduled');
    const second = sync.sync('mypack', 'admin');
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchBytes).toHaveBeenCalledOnce();
    release();
    const reports = await Promise.all([first, second]);
    expect(reports.map((x) => x.ok)).toEqual([true, true]);
    expect(fetchBytes).toHaveBeenCalledTimes(2);
  });

  it('stops before writing once cancelled', async () => {
    const abort = new AbortController();
    const { sync, stations } = setup(ALL, undefined, {
      parse: async () => {
        abort.abort();
        return ALL.map((name) => ({ externalId: null, name }));
      },
    });
    const r = await sync.sync('mypack', 'scheduled', abort.signal);
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/cancelled/) });
    expect(stations.getStation('mypack:one')?.officialLastSeenAt).toBeNull();
  });
});
