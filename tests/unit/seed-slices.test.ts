import { describe, expect, it, vi } from 'vitest';
import { PackRegistry, type StationPack, seedPackInSlices, seedPacks } from '../../src/catalogue/packs.ts';
import { demoPack, memoryDb } from '../helpers.ts';

/** The demo pack grown to `stations` stations and `sources` sources (made-up names and hosts). */
function bigPack(stations: number, sources: number): StationPack {
  const base = demoPack();
  const st = base.stations[0]!;
  const src = base.sources[0]!;
  return {
    ...base,
    stations: Array.from({ length: stations }, (_, i) => ({
      ...st,
      slug: `s${i}`,
      id: `${base.meta.id}:s${i}`,
      displayName: `Made-up station ${i}`,
      aliases: [],
      order: i,
    })),
    sources: Array.from({ length: sources }, (_, i) => ({
      ...src,
      id: `big-${i}`,
      station: `s${i % stations}`,
      stationId: `${base.meta.id}:s${i % stations}`,
      url: `https://stream.example.org/${i}.mp3`,
      enabled: true,
      disabledReason: null,
    })),
  };
}

/** A transaction function that records how many of `method`'s calls each transaction made. */
function counted(db: ReturnType<typeof memoryDb>['db'], spy: { mock: { calls: unknown[] } }) {
  const perTransaction: number[] = [];
  const transaction = <T>(fn: () => T): T => {
    const before = spy.mock.calls.length;
    const r = db.transaction(fn);
    perTransaction.push(spy.mock.calls.length - before);
    return r;
  };
  return { transaction, perTransaction };
}

describe('seedPackInSlices', () => {
  it('disables 1500 removed sources a slice at a time, never all in one transaction', async () => {
    const { db, stations } = memoryDb();
    const pack = bigPack(300, 1500);
    await seedPackInSlices(stations, (fn) => db.transaction(fn), pack);
    expect(stations.listAllSources().filter((s) => s.enabled)).toHaveLength(1500);
    const disable = vi.spyOn(stations, 'setSourceEnabled');
    const { transaction, perTransaction } = counted(db, disable);
    // A clock that stands still: only the row cap ends a slice.
    const summary = await seedPackInSlices(
      stations,
      transaction,
      { ...pack, sources: [] },
      {
        now: () => 0,
        maxRows: 100,
      },
    );
    expect(summary.sourcesDisabled).toBe(1500);
    expect(disable).toHaveBeenCalledTimes(1500);
    expect(Math.max(...perTransaction)).toBeLessThanOrEqual(100);
    expect(perTransaction.filter((n) => n > 0).length).toBeGreaterThanOrEqual(15);
    const all = stations.listAllSources();
    expect(all.every((s) => !s.enabled && s.disabledReason === 'removed from the pack manifest')).toBe(true);
  });

  it('ends a slice once its time is up', async () => {
    const { db, stations } = memoryDb();
    let t = 0;
    const upsert = vi.spyOn(stations, 'upsertProviderStation');
    const { transaction, perTransaction } = counted(db, upsert);
    // Each look at the clock is a millisecond later: a 4 ms slice holds four rows.
    await seedPackInSlices(stations, transaction, bigPack(40, 40), { now: () => t++, sliceMs: 4 });
    const stationSlices = perTransaction.filter((n) => n > 0);
    expect(stationSlices.reduce((a, b) => a + b, 0)).toBe(40);
    expect(Math.max(...stationSlices)).toBe(4);
  });

  it('writes the same as seeding at start-up, and skips sources disabled meanwhile', async () => {
    const pack = bigPack(30, 60);
    const a = memoryDb();
    const b = memoryDb();
    const sliced = await seedPackInSlices(a.stations, (fn) => a.db.transaction(fn), pack);
    const whole = b.db.transaction(() => seedPacks(b.stations, new PackRegistry([pack])));
    expect(sliced).toEqual(whole);
    const rows = (t: typeof a) => t.stations.listAllSources().map((s) => [s.id, s.stationId, s.enabled]);
    expect(rows(a)).toEqual(rows(b));
    expect(a.stations.listStations(null).map((s) => s.id)).toEqual(
      b.stations.listStations(null).map((s) => s.id),
    );
    // All removed from the manifest; one was disabled by hand before, and one meanwhile, after the
    // list was drawn up but before its slice came (the fourth transaction is the first of them:
    // three slices of ten stations come first). Neither is written again.
    a.stations.setSourceEnabled('big-0', false, 'by hand');
    let calls = 0;
    const r = await seedPackInSlices(
      a.stations,
      (fn) => {
        if (++calls === 4) a.stations.setSourceEnabled('big-59', false, 'meanwhile');
        return a.db.transaction(fn);
      },
      { ...pack, sources: [] },
      { now: () => 0, maxRows: 10 },
    );
    expect(r.sourcesDisabled).toBe(58);
    expect(a.stations.getSource('big-0')?.disabledReason).toBe('by hand');
    expect(a.stations.getSource('big-59')?.disabledReason).toBe('meanwhile');
    expect(a.stations.getSource('big-1')?.disabledReason).toBe('removed from the pack manifest');
  });
});
