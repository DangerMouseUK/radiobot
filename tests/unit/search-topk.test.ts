import { describe, expect, it } from 'vitest';
import { type SearchHit, scoreStation, searchStations } from '../../src/catalogue/search.ts';
import type { Station } from '../../src/catalogue/types.ts';
import { compareText } from '../../src/shared/text.ts';
import { demoPack } from '../helpers.ts';

/** About 2000 stations made from the made-up demo pack, with repeated names and orders for ties. */
function catalogue(): Station[] {
  const pack = demoPack();
  const now = '2026-11-04T00:00:00.000Z';
  const out: Station[] = [];
  for (let copy = 0; out.length < 2000; copy++) {
    for (const s of pack.stations) {
      const custom = copy % 9 === 8;
      out.push({
        id: custom ? `custom:${s.slug}-${copy}` : `${pack.meta.id}:${s.slug}-${copy}`,
        provider: custom ? 'custom' : pack.meta.id,
        guildId: custom ? '123456789012345678' : null,
        slug: `${s.slug}-${copy}`,
        externalId: null,
        // Every third copy keeps the name as it is, so names (and scores) repeat.
        displayName: copy % 3 === 0 ? s.displayName : `${s.displayName} ${copy}`,
        aliases: copy % 4 === 0 ? s.aliases : [...s.aliases, `Alias ${copy}`],
        description: null,
        tags: s.tags,
        category: s.category,
        sortOrder: s.order % 7,
        websiteUrl: null,
        language: null,
        officialPageUrl: null,
        officialLastSeenAt: null,
        catalogueStatus: 'active',
        createdById: null,
        createdAt: now,
        updatedAt: now,
        retiredAt: null,
      });
    }
  }
  return out;
}

/** The search as it was: score every station, sort every hit (stably), then cut. */
function fullSort(stations: Station[], query: string, limit: number): SearchHit[] {
  return stations
    .map((s) => scoreStation(s, query))
    .filter((h): h is SearchHit => h !== null)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(a.station.provider === 'custom') - Number(b.station.provider === 'custom') ||
        a.station.sortOrder - b.station.sortOrder ||
        compareText(a.station.displayName, b.station.displayName),
    )
    .slice(0, limit);
}

/** A small seeded generator, so a failure can be reproduced. */
function random(seed: number): () => number {
  let x = seed >>> 0;
  return () => {
    x = (x * 1_664_525 + 1_013_904_223) >>> 0;
    return x / 2 ** 32;
  };
}

describe('searchStations keeps only the best hits, in the same order as sorting them all', () => {
  const stations = catalogue();
  const rand = random(20261104);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const words = [...new Set(stations.flatMap((s) => [...s.displayName.split(' '), ...s.tags]))];
  const queries = ['', ' ', 'radio', 'zzzz', stations[0]!.id, stations[5]!.displayName];
  for (let i = 0; i < 60; i++) {
    const w = pick(words);
    switch (i % 5) {
      case 0:
        queries.push(w.slice(0, 1 + Math.floor(rand() * w.length)));
        break;
      case 1:
        queries.push(`${pick(words)} ${pick(words).slice(0, 2)}`);
        break;
      case 2: {
        // A typo: one letter changed.
        const at = Math.floor(rand() * w.length);
        queries.push(
          `${w.slice(0, at)}${String.fromCharCode(97 + Math.floor(rand() * 26))}${w.slice(at + 1)}`,
        );
        break;
      }
      case 3:
        queries.push(pick(stations).displayName.toUpperCase());
        break;
      default:
        queries.push(String.fromCharCode(97 + Math.floor(rand() * 26)));
    }
  }

  it.each([1, 10, 25, 100])('limit %i', (limit) => {
    for (const q of queries) {
      const expected = fullSort(stations, q, limit);
      expect(searchStations(stations, q, limit), q).toEqual(expected);
    }
  });

  it('sorts everything when asked for a long list, and returns nothing for a limit of 0', () => {
    expect(searchStations(stations, 'a', 5000)).toEqual(fullSort(stations, 'a', 5000));
    expect(searchStations(stations, '', 0)).toEqual([]);
  });
});
