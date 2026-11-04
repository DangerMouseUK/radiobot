import { describe, expect, it, vi } from 'vitest';
import { memoryDb } from '../helpers.ts';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-04T12:00:00.000Z');

/** A database with one station and the given sources, and a way to add probe results to them. */
function setup(sourceIds: string[] = ['s1']) {
  const t = memoryDb();
  t.stations.upsertProviderStation({
    id: 'mypack:a',
    provider: 'mypack',
    slug: 'a',
    externalId: null,
    displayName: 'A',
    aliases: [],
    tags: [],
    category: null,
    sortOrder: 1,
    officialPageUrl: null,
    officialLastSeenAt: null,
    catalogueStatus: 'active',
    description: null,
  });
  for (const id of sourceIds)
    t.stations.upsertSeedSource({
      id,
      stationId: 'mypack:a',
      url: `https://${id}.example.com/`,
      label: null,
      priority: 1,
      transportHint: null,
      codecHint: null,
      provenance: 'curated',
      provenanceDetail: 'x',
      rightsStatus: 'unreviewed',
    });
  /** Adds `n` results to `sourceId`, the newest `ageDays` old and each one a minute older. */
  const add = (sourceId: string, n: number, ageDays: number) =>
    t.db.transaction(() => {
      for (let i = 0; i < n; i++) {
        t.db.run(
          `INSERT INTO source_probe_results (source_id, started_at, duration_ms, kind, success, probe_version)
           VALUES (?, ?, 10, 'basic', 1, 1)`,
          [sourceId, new Date(NOW - ageDays * DAY - i * 60_000).toISOString()],
        );
      }
    });
  const count = (sourceId?: string) =>
    Number(
      t.db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM source_probe_results ${sourceId ? 'WHERE source_id = ?' : ''}`,
        sourceId ? [sourceId] : [],
      )?.n,
    );
  return { ...t, add, count };
}

describe('pruneProbeHistory', () => {
  it('deletes aged results in batches, pausing between them, and keeps fresh ones', async () => {
    const { stations, add, count, db } = setup(['s1', 's2']);
    add('s1', 600, 40);
    add('s2', 400, 31);
    add('s1', 30, 1);
    add('s2', 20, 0);
    const run = vi.spyOn(db, 'run');
    const pause = vi.fn(async () => {});
    const r = await stations.pruneProbeHistory({
      keep: 30,
      days: 30,
      now: NOW,
      pause,
      trimEverySource: false,
      batch: 100,
    });
    expect(r.deleted).toBe(1000);
    expect(count('s1')).toBe(30);
    expect(count('s2')).toBe(20);
    expect(pause.mock.calls.length).toBeGreaterThanOrEqual(10);
    // No statement deleted more than a batch.
    const deletes = run.mock.results.map((x) => (x.value as { changes: number }).changes);
    expect(Math.max(...deletes)).toBeLessThanOrEqual(100);
  });

  it('finds aged results through the started_at index', () => {
    const { db } = setup();
    const plan = db
      .all<{ detail: string }>(
        `EXPLAIN QUERY PLAN DELETE FROM source_probe_results WHERE id IN (
           SELECT id FROM source_probe_results WHERE started_at < '2026-01-01' ORDER BY started_at LIMIT 250)`,
      )
      .map((r) => r.detail)
      .join(' ');
    expect(plan).toMatch(/USING (COVERING )?INDEX ix_probe_results_started/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });

  it('trims every source once, and again only when the limit is lowered', async () => {
    const { stations, add, count, meta } = setup(['s1', 's2', 's3']);
    add('s1', 45, 1);
    add('s2', 10, 1);
    add('s3', 230, 1);
    const pause = vi.fn(async () => {});
    const opts = { days: 30, now: NOW, pause, trimEverySource: true, batch: 100 };
    // Never applied before: the count pass runs, newest kept.
    const newest = stations.listProbeResults('s3', 1)[0]!.startedAt;
    expect((await stations.pruneProbeHistory({ ...opts, keep: 30 })).deleted).toBe(15 + 200);
    expect([count('s1'), count('s2'), count('s3')]).toEqual([30, 10, 30]);
    expect(stations.listProbeResults('s3', 1)[0]!.startedAt).toBe(newest);
    expect(meta.get('probe_history.trimmed_to')).toBe('30');
    // The same limit again: the count pass is skipped, even with sources over it.
    add('s2', 40, 2);
    expect((await stations.pruneProbeHistory({ ...opts, keep: 30 })).deleted).toBe(0);
    expect(count('s2')).toBe(50);
    // A higher limit is recorded without a pass, so lowering it later is still noticed.
    expect((await stations.pruneProbeHistory({ ...opts, keep: 60 })).deleted).toBe(0);
    expect(meta.get('probe_history.trimmed_to')).toBe('60');
    expect((await stations.pruneProbeHistory({ ...opts, keep: 40 })).deleted).toBe(10);
    expect(count('s2')).toBe(40);
    expect(meta.get('probe_history.trimmed_to')).toBe('40');
    // Not asked to: never runs.
    expect((await stations.pruneProbeHistory({ ...opts, keep: 5, trimEverySource: false })).deleted).toBe(0);
    expect(count('s2')).toBe(40);
  });

  it('pages through sources, pausing between pages', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `s${String(i).padStart(3, '0')}`);
    const { stations, add, count } = setup(ids);
    for (const id of ids) add(id, 3, 1);
    const pause = vi.fn(async () => {});
    const r = await stations.pruneProbeHistory({ keep: 1, days: 30, now: NOW, pause, trimEverySource: true });
    expect(r.deleted).toBe(240);
    expect(count()).toBe(120);
    // 50 sources to a page: three pages.
    expect(pause).toHaveBeenCalledTimes(3);
  });

  it('stops early when aborted, and records the limit only after a full pass', async () => {
    const { stations, add, count, meta } = setup(['s1']);
    add('s1', 500, 40);
    const ac = new AbortController();
    let pauses = 0;
    const pause = async () => {
      if (++pauses === 2) ac.abort();
    };
    const r = await stations.pruneProbeHistory({
      keep: 30,
      days: 30,
      now: NOW,
      pause,
      signal: ac.signal,
      trimEverySource: true,
      batch: 100,
    });
    expect(r.deleted).toBe(200);
    expect(count()).toBe(300);
    expect(meta.get('probe_history.trimmed_to')).toBeNull();
    // Aborted during the count pass (after the three batches of aged results): it stops there too,
    // and runs again next time.
    add('s1', 250, 1);
    const ac2 = new AbortController();
    let n = 0;
    const r2 = await stations.pruneProbeHistory({
      keep: 30,
      days: 30,
      now: NOW,
      pause: async () => {
        if (++n === 4) ac2.abort();
      },
      signal: ac2.signal,
      trimEverySource: true,
      batch: 100,
    });
    expect(r2.deleted).toBe(300 + 100);
    expect(count()).toBe(150);
    expect(meta.get('probe_history.trimmed_to')).toBeNull();
    const done = await stations.pruneProbeHistory({
      keep: 30,
      days: 30,
      now: NOW,
      pause: async () => {},
      trimEverySource: true,
    });
    expect(done.deleted).toBe(120);
    expect(meta.get('probe_history.trimmed_to')).toBe('30');
    const already = new AbortController();
    already.abort();
    add('s1', 10, 40);
    expect(
      (
        await stations.pruneProbeHistory({
          keep: 30,
          days: 30,
          pause: async () => {},
          signal: already.signal,
          trimEverySource: true,
        })
      ).deleted,
    ).toBe(0);
  });

  it('never touches the station and source caches', async () => {
    const { stations, add } = setup();
    add('s1', 300, 40);
    stations.listStations(null);
    stations.listAllSources();
    const before = stations.changeCount;
    await stations.pruneProbeHistory({ keep: 1, days: 30, pause: async () => {}, trimEverySource: true });
    expect(stations.changeCount).toBe(before);
  });
});
