import { describe, expect, it, vi } from 'vitest';
import { Db } from '../../src/persistence/db.ts';
import { memoryDb } from '../helpers.ts';

const station = (id: string, displayName = id) => ({
  id,
  provider: 'mypack',
  slug: id.split(':')[1]!,
  externalId: null,
  displayName,
  aliases: [],
  tags: [],
  category: null,
  sortOrder: 1,
  officialPageUrl: null,
  officialLastSeenAt: null,
  catalogueStatus: 'active' as const,
  description: null,
});
const source = (id: string, stationId: string) => ({
  id,
  stationId,
  url: `https://${id}.example.com/`,
  label: null,
  priority: 1,
  transportHint: null,
  codecHint: null,
  provenance: 'curated' as const,
  provenanceDetail: 'x',
  rightsStatus: 'unreviewed' as const,
});

/** A catalogue of one station and one source, both cached. */
function cached() {
  const t = memoryDb();
  t.stations.upsertProviderStation(station('mypack:a', 'Before'));
  t.stations.upsertSeedSource(source('s1', 'mypack:a'));
  t.stations.listStations(null);
  t.stations.listAllSources();
  return t;
}

const fail = (fn: () => void) => () => {
  fn();
  throw new Error('roll back');
};

describe('changeCount', () => {
  it('goes up on every station or source write, in place or not, and only then', () => {
    const { stations, guilds } = cached();
    let last = stations.changeCount;
    const changed = () => {
      const now = stations.changeCount;
      const moved = now > last;
      last = now;
      return moved;
    };
    stations.recordSuccess('s1');
    expect(changed()).toBe(true);
    stations.applyProbePatch('s1', { codec: 'mp3' });
    expect(changed()).toBe(true);
    stations.setCatalogueStatus('mypack:a', 'missing_from_official');
    expect(changed()).toBe(true);
    stations.markSeen(['mypack:a'], '2026-11-04');
    expect(changed()).toBe(true);
    stations.renameStation('mypack:a', 'Renamed', true);
    expect(changed()).toBe(true);
    stations.upsertProviderStation(station('mypack:b'));
    expect(changed()).toBe(true);
    // Reads, other tables, probe history and sync reports leave it alone.
    stations.listStations(null);
    stations.getSource('s1');
    guilds.updateSettings('111111111111111111', { idleMode: '24x7' });
    stations.pruneSourceHistory('s1', 5);
    stations.insertSyncReport({
      provider: 'mypack',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      success: true,
      trigger: 'manual',
      summary: {},
    });
    expect(changed()).toBe(false);
  });

  it('goes up again when a write is rolled back', () => {
    const { stations } = cached();
    const before = stations.changeCount;
    expect(() => stations.transaction(fail(() => stations.recordFailure('s1', 'TIMEOUT')))).toThrow();
    // The write counted once, and its rollback once more.
    expect(stations.changeCount).toBe(before + 2);
    expect(stations.getSource('s1')?.consecutiveFailures).toBe(0);
  });
});

describe('rollbacks and the station caches', () => {
  it('keeps both caches when a transaction that wrote neither rolls back', () => {
    const { db, stations, guilds } = cached();
    const before = stations.changeCount;
    const all = vi.spyOn(db, 'all');
    expect(() =>
      db.transaction(fail(() => guilds.updateSettings('111111111111111111', { idleMode: '24x7' }))),
    ).toThrow();
    // A read inside a transaction that then rolls back: nothing was cached from it.
    expect(() => stations.transaction(fail(() => stations.listStations(null)))).toThrow();
    expect(stations.listStations(null).map((s) => s.displayName)).toEqual(['Before']);
    stations.listAllSources();
    expect(all).not.toHaveBeenCalled();
    expect(stations.changeCount).toBe(before);
  });

  it('reads stations again after a rollback of a station write patched in place, and nothing else', () => {
    const { db, stations } = cached();
    const all = vi.spyOn(db, 'all');
    expect(() =>
      stations.transaction(
        fail(() => {
          stations.renameStation('mypack:a', 'During', false);
          expect(stations.getStation('mypack:a')?.displayName).toBe('During');
        }),
      ),
    ).toThrow();
    expect(stations.getStation('mypack:a')?.displayName).toBe('Before');
    expect(stations.listStations(null).map((s) => s.displayName)).toEqual(['Before']);
    stations.listAllSources();
    // One read: the stations. The sources were never written, so their cache stands.
    expect(all.mock.calls.map((c) => c[0])).toEqual([expect.stringMatching(/FROM stations/)]);
  });

  it('reads sources again after a rollback of a source write patched in place', () => {
    const { db, stations } = cached();
    const all = vi.spyOn(db, 'all');
    expect(() =>
      stations.transaction(fail(() => stations.setSourceEnabled('s1', false, 'testing'))),
    ).toThrow();
    expect(stations.getSource('s1')?.enabled).toBe(true);
    expect(stations.listAllSources()[0]?.enabled).toBe(true);
    stations.listStations(null);
    expect(all.mock.calls.map((c) => c[0])).toEqual([expect.stringMatching(/FROM station_sources/)]);
  });

  it('forgets a cache filled inside a savepoint when the transaction around it rolls back', () => {
    const { stations } = memoryDb();
    stations.upsertProviderStation(station('mypack:a', 'Before'));
    expect(() =>
      stations.transaction(() => {
        stations.renameStation('mypack:a', 'During', false); // not cached yet: nothing to patch
        stations.transaction(() => {
          expect(stations.listStations(null)[0]?.displayName).toBe('During');
        });
        throw new Error('roll back');
      }),
    ).toThrow('roll back');
    expect(stations.listStations(null)[0]?.displayName).toBe('Before');
  });

  it('keeps an outer patch when only a savepoint that wrote nothing cached rolls back', () => {
    const { db, stations } = cached();
    const all = vi.spyOn(db, 'all');
    stations.transaction(() => {
      stations.renameStation('mypack:a', 'Outer', false);
      try {
        db.transaction(
          fail(() =>
            db.run('INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)', ['k', 'v', 'x']),
          ),
        );
      } catch {
        /* the outer transaction carries on */
      }
    });
    expect(stations.listStations(null)[0]?.displayName).toBe('Outer');
    expect(all).not.toHaveBeenCalled();
  });
});

describe('Db.onRollback', () => {
  it('calls back for the level that rolled back and any around it, never after a commit', () => {
    const db = new Db(':memory:');
    const calls: string[] = [];
    const note = (name: string) => () => calls.push(name);
    db.onRollback(note('outside')); // nothing to undo outside a transaction
    db.transaction(() => db.onRollback(note('committed')));
    expect(calls).toEqual([]);
    // A released savepoint's work is undone with the transaction around it.
    expect(() =>
      db.transaction(() => {
        db.transaction(() => db.onRollback(note('inner')));
        throw new Error('outer fails');
      }),
    ).toThrow();
    expect(calls).toEqual(['inner']);
    // A savepoint that rolls back alone leaves the outer level's work in place.
    calls.length = 0;
    db.transaction(() => {
      db.onRollback(note('outer'));
      expect(() => db.transaction(fail(() => db.onRollback(note('savepoint'))))).toThrow();
    });
    expect(calls).toEqual(['savepoint']);
  });

  it('calls back for every level when SQLite gave up the whole transaction', () => {
    const db = new Db(':memory:');
    const calls: string[] = [];
    expect(() =>
      db.transaction(() => {
        db.onRollback(() => calls.push('outer'));
        try {
          db.transaction(() => {
            db.onRollback(() => calls.push('inner'));
            // As SQLite does by itself after some errors (a full disk, say).
            db.raw.exec('ROLLBACK');
            throw new Error('gone');
          });
        } catch {
          /* carries on, but its transaction is gone */
        }
        expect(calls.sort()).toEqual(['inner', 'outer']);
      }),
    ).toThrow(); // the commit finds no transaction
    expect(db.raw.isTransaction).toBe(false);
    db.transaction(() => db.run('CREATE TABLE t (x)'));
  });
});

describe('database settings', () => {
  it('keeps an 8 MB page cache and temporary tables in memory', () => {
    const { db } = memoryDb();
    expect(db.get<{ cache_size: number }>('PRAGMA cache_size')?.cache_size).toBe(-8192);
    // 2 = MEMORY
    expect(db.get<{ temp_store: number }>('PRAGMA temp_store')?.temp_store).toBe(2);
  });
});

describe('lastSyncOutcome', () => {
  it('reads how the last sync ended without its summary, through the pack index', () => {
    const { db, stations } = memoryDb();
    expect(stations.lastSyncOutcome('mypack')).toBeNull();
    const report = (finishedAt: string, success: boolean) =>
      stations.insertSyncReport({
        provider: 'mypack',
        startedAt: finishedAt,
        finishedAt,
        success,
        trigger: 'admin',
        summary: { long: 'x'.repeat(1000) },
      });
    report('2026-01-01T00:00:00.000Z', true);
    report('2026-01-02T00:00:00.000Z', false);
    expect(stations.lastSyncOutcome('mypack')).toEqual({
      finishedAt: '2026-01-02T00:00:00.000Z',
      success: false,
    });
    const plan = db
      .all<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT finished_at, success FROM catalogue_sync_reports WHERE provider = 'mypack' ORDER BY id DESC LIMIT 1",
      )
      .map((r) => r.detail)
      .join(' ');
    expect(plan).toMatch(/USING INDEX ix_sync_reports_provider/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
  });
});
