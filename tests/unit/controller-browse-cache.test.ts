/**
 * Browse keeps a search's results with its open list, so Next page and Previous page don't search
 * the whole catalogue again. A spy on the search counts how often it runs.
 */
import { describe, expect, it, vi } from 'vitest';
import * as search from '../../src/catalogue/search.ts';
import { decode, GUILD, type Harness, setup } from './controller-harness.ts';

vi.mock('../../src/catalogue/search.ts', async (original) => {
  const real = await original<typeof import('../../src/catalogue/search.ts')>();
  return { ...real, searchStations: vi.fn(real.searchStations) };
});

const searches = vi.mocked(search.searchStations);

/** The custom ID of the browse list's button with this action (the last one, for Next page). */
const button = (t: Harness, ids: string[], action: string) =>
  ids.filter((id) => decode(t.ids, id)?.action === action).at(-1)!;

const description = (i: {
  calls: Array<{ payload: { embeds?: Array<{ toJSON(): { description?: string } }> } }>;
}) => i.calls[0]!.payload.embeds![0]!.toJSON().description ?? '';

describe('browse search results', () => {
  it('are worked out once and reused by the page buttons while nothing has changed', async () => {
    const t = setup();
    searches.mockClear();
    const first = await t.command(t.people.member, { sub: 'browse', strings: { search: 'demo' } });
    expect(searches).toHaveBeenCalledTimes(1);
    expect(first.text).toMatch(/Page 1\/2/);
    const next = button(t, first.componentIds, 'browse');
    const page2 = await t.click(t.people.member, next);
    expect(page2.text).toMatch(/Page 2\/2/);
    const again = await t.click(t.people.member, next);
    expect(description(again)).toBe(description(page2));
    expect(searches).toHaveBeenCalledTimes(1);

    // A change to the catalogue: searched again, and the change shows.
    const st = t.stations.listStations(GUILD).find((s) => s.provider === 'demo')!;
    t.stations.renameStation(st.id, 'Demo Renamed', true);
    const token = decode(t.ids, next)!.arg.split(':')[0]!;
    const renamed = await t.click(t.people.member, t.ids.make(GUILD, 'browse', `${token}:p0`));
    expect(searches).toHaveBeenCalledTimes(2);
    expect(description(renamed)).toMatch(/Demo Renamed/);
  });

  it('are worked out again when the search or the favourites filter changes', async () => {
    const t = setup();
    const first = await t.command(t.people.member, { sub: 'browse', strings: { search: 'demo' } });
    const token = decode(t.ids, button(t, first.componentIds, 'bsearch'))!.arg;
    searches.mockClear();
    // A new search from the search box.
    await t.submit(t.people.member, t.ids.make(GUILD, 'bsearch', token), { search: 'techno' });
    expect(searches).toHaveBeenCalledTimes(1);
    await t.click(t.people.member, t.ids.make(GUILD, 'browse', `${token}:p0`));
    expect(searches).toHaveBeenCalledTimes(1);

    // Favourites only: the search runs over the favourites, and again when they change.
    const fav = t.stations.listStations(GUILD).find((s) => /techno/i.test(s.displayName))!;
    t.guilds.toggleFavourite(GUILD, fav.id);
    const favs = await t.click(t.people.member, t.ids.make(GUILD, 'bfav', token));
    expect(searches).toHaveBeenCalledTimes(2);
    expect(description(favs)).toContain(fav.displayName);
    await t.click(t.people.member, t.ids.make(GUILD, 'browse', `${token}:p0`));
    expect(searches).toHaveBeenCalledTimes(2);
    t.guilds.toggleFavourite(GUILD, fav.id);
    const none = await t.click(t.people.member, t.ids.make(GUILD, 'browse', `${token}:p0`));
    expect(searches).toHaveBeenCalledTimes(3);
    expect(description(none)).not.toContain(fav.displayName);
  });

  it('are not kept for a list without a search', async () => {
    const t = setup();
    searches.mockClear();
    const first = await t.command(t.people.member, { sub: 'browse' });
    await t.click(t.people.member, button(t, first.componentIds, 'browse'));
    expect(searches).not.toHaveBeenCalled();
  });
});
