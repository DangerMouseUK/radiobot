import { describe, expect, it } from 'vitest';
import { resolveStation, scoreStation, searchStations } from '../../src/catalogue/search.ts';
import type { Station } from '../../src/catalogue/types.ts';

let order = 0;
function station(overrides: Partial<Station> & { id: string; displayName: string }): Station {
  const now = new Date().toISOString();
  return {
    provider: 'mypack',
    guildId: null,
    slug: overrides.id.split(':')[1] ?? overrides.id,
    externalId: null,
    aliases: [],
    description: null,
    tags: [],
    category: null,
    sortOrder: order++,
    websiteUrl: null,
    language: null,
    officialPageUrl: null,
    officialLastSeenAt: null,
    catalogueStatus: 'active',
    createdById: null,
    createdAt: now,
    updatedAt: now,
    retiredAt: null,
    ...overrides,
  };
}

describe('scoreStation', () => {
  const s = station({
    id: 'mypack:my-station',
    displayName: 'My Station',
    aliases: ['Old Name'],
    tags: ['deep house', 'chill'],
    category: 'Dance Music',
  });

  it('scores identity matches as exact, from the ID, slug, name or an alias', () => {
    expect(scoreStation(s, 'mypack:my-station')).toMatchObject({ score: 1000, exact: true });
    expect(scoreStation(s, '  MY-STATION ')).toMatchObject({ score: 1000, exact: true });
    expect(scoreStation(s, 'my station')).toMatchObject({ score: 1000, exact: true });
    expect(scoreStation(s, 'My Station!')).toMatchObject({ score: 1000, exact: true });
    expect(scoreStation(s, 'old name')).toMatchObject({ score: 900, exact: true });
  });

  it('scores a display name that differs from the slug at 950', () => {
    const renamed = station({ id: 'mypack:first-slug', displayName: 'Second Name' });
    expect(scoreStation(renamed, 'second name')).toMatchObject({ score: 950, exact: true });
  });

  it('ranks prefixes, words, tags, substrings and categories in that order', () => {
    expect(scoreStation(s, 'my sta')!.score).toBe(700 - ('my station'.length - 'my sta'.length));
    expect(scoreStation(s, 'sta my')!.score).toBe(600 - 'my station'.length);
    expect(scoreStation(s, 'chill')!.score).toBe(500);
    expect(scoreStation(s, 'hou')!.score).toBe(420);
    expect(scoreStation(s, 'tation')!.score).toBe(400);
    expect(scoreStation(s, 'music')!.score).toBe(350);
  });

  it('scores a close misspelling of the name or an alias, and nothing for unrelated text', () => {
    const typo = scoreStation(s, 'my statoin');
    expect(typo!.exact).toBe(false);
    expect(typo!.score).toBeGreaterThanOrEqual(180);
    expect(typo!.score).toBeLessThan(300);
    expect(scoreStation(s, 'old nmae')!.score).toBeGreaterThan(0);
    expect(scoreStation(s, 'zzzzzzzzzzzzzzzzzzzz')).toBeNull();
  });

  it('matches everything with a low score for an empty query', () => {
    expect(scoreStation(s, '   ')).toEqual({ station: s, score: 1, exact: false });
  });

  it('copes with a station that has no category', () => {
    const plain = station({ id: 'mypack:plain', displayName: 'Plain' });
    expect(scoreStation(plain, 'music')).toBeNull();
  });
});

describe('searchStations', () => {
  it('puts pack stations before custom ones on ties, then catalogue order, then name', () => {
    const custom = station({
      id: 'custom:aa',
      provider: 'custom',
      guildId: '123456789012345678',
      displayName: 'Alpha Beat',
      sortOrder: 0,
    });
    const late = station({ id: 'mypack:late', displayName: 'Alpha Beat', sortOrder: 50 });
    const earlyB = station({ id: 'mypack:early-b', displayName: 'Alpha Beat', sortOrder: 10 });
    const earlyA = station({ id: 'mypack:early-a', displayName: 'Alpha Beat', sortOrder: 10 });
    const hits = searchStations([custom, late, earlyB, earlyA], 'alpha');
    expect(hits.map((h) => h.station.id)).toEqual([
      'mypack:early-b',
      'mypack:early-a',
      'mypack:late',
      'custom:aa',
    ]);
    expect(new Set(hits.map((h) => h.score)).size).toBe(1);
  });

  it('orders equal scores by name when catalogue order is equal', () => {
    const b = station({ id: 'mypack:b', displayName: 'Zed Bravo', sortOrder: 5, tags: ['jazz'] });
    const a = station({ id: 'mypack:a', displayName: 'Zed Alpha', sortOrder: 5, tags: ['jazz'] });
    expect(searchStations([b, a], 'jazz').map((h) => h.station.id)).toEqual(['mypack:a', 'mypack:b']);
  });

  it('honours the limit', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      station({ id: `mypack:s${i}`, displayName: `Hits ${i}` }),
    );
    expect(searchStations(many, 'hits', 5)).toHaveLength(5);
    expect(searchStations(many, 'hits')).toHaveLength(25);
  });
});

describe('resolveStation', () => {
  it('returns none when nothing matches', () => {
    const s = station({ id: 'mypack:one', displayName: 'One' });
    expect(resolveStation([s], 'qqqqqqqqqqqq')).toEqual({ kind: 'none' });
  });

  it('prefers the strongest of several exact matches', () => {
    const bySlug = station({ id: 'mypack:night', displayName: 'Evening Radio' });
    const byAlias = station({ id: 'mypack:other', displayName: 'Other', aliases: ['Night'] });
    expect(resolveStation([byAlias, bySlug], 'night')).toEqual({ kind: 'match', station: bySlug });
  });

  it('refuses to choose between equally exact matches, pack stations first', () => {
    const custom = station({
      id: 'custom:x1',
      provider: 'custom',
      guildId: '123456789012345678',
      displayName: 'Twin',
    });
    const a = station({ id: 'mypack:twin-a', displayName: 'Twin' });
    const b = station({ id: 'otherpack:twin-b', displayName: 'Twin' });
    const r = resolveStation([custom, b, a], 'Twin');
    expect(r.kind).toBe('ambiguous');
    if (r.kind !== 'ambiguous') return;
    // Ties: pack stations first, then catalogue order (a was created before b).
    expect(r.candidates.map((s) => s.id)).toEqual(['mypack:twin-a', 'otherpack:twin-b', 'custom:x1']);
  });

  it('accepts one clearly dominant fuzzy hit and refuses close ones', () => {
    const one = station({ id: 'mypack:alpha-one', displayName: 'Alpha One' });
    const unrelated = station({ id: 'mypack:zulu', displayName: 'Zulu' });
    expect(resolveStation([one, unrelated], 'alpha')).toEqual({ kind: 'match', station: one });
    const two = station({ id: 'mypack:alpha-two', displayName: 'Alpha Two' });
    const r = resolveStation([one, two], 'alpha');
    expect(r.kind).toBe('ambiguous');
  });

  it('treats an empty query as ambiguous across every station', () => {
    const one = station({ id: 'mypack:one', displayName: 'One' });
    const two = station({ id: 'mypack:two', displayName: 'Two' });
    const r = resolveStation([one, two], '');
    expect(r).toEqual({ kind: 'ambiguous', candidates: [one, two] });
  });

  it('refuses a weak fuzzy hit even when it is the only one', () => {
    const s = station({ id: 'mypack:one', displayName: 'Something', category: 'Talk' });
    expect(resolveStation([s], 'talk')).toEqual({ kind: 'ambiguous', candidates: [s] });
  });
});
