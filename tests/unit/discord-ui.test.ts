import { type APIEmbed, ButtonStyle, type EmbedBuilder, MessageFlags } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { planEncoder } from '../../src/audio/encoder.ts';
import { ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import { seedPacks } from '../../src/catalogue/packs.ts';
import type { Station, StationSource } from '../../src/catalogue/types.ts';
import { loadConfig } from '../../src/config/env.ts';
import { ComponentIds } from '../../src/discord/components/custom-id.ts';
import type { AppContext } from '../../src/discord/context.ts';
import {
  availabilityBadge,
  COLOR,
  checkedLine,
  DISCLAIMER,
  errorEmbed,
  identityLine,
  infoEmbed,
  nowEmbed,
  outputLine,
  qualityEmbed,
  sourceFormat,
  sourcesEmbed,
  stateColor,
  stationLine,
  transportLabel,
} from '../../src/discord/ui/format.ts';
import {
  bitrateModal,
  isSettingsScreen,
  NO_DEFAULT_STATION,
  qualityText,
  SETTINGS_SCREENS,
  type SettingsCard,
  settingsCard,
  stationModal,
} from '../../src/discord/ui/settings-view.ts';
import {
  ambiguityView,
  browseSearchModal,
  browseView,
  controlRows,
  listArg,
  listView,
  parseListArg,
  type View,
} from '../../src/discord/ui/views.ts';
import { Metrics } from '../../src/observability/metrics.ts';
import type { ProbeOutcome } from '../../src/streams/probe.ts';
import { selectSource } from '../../src/streams/ranking.ts';
import { SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import { SourceService } from '../../src/streams/source-service.ts';
import { UrlPolicy } from '../../src/streams/url-policy.ts';
import type { SessionStatus } from '../../src/voice/session.ts';
import { demoRegistry, makeSource, memoryDb, silentLogger } from '../helpers.ts';

const GUILD = '123456789012345678';

/** Discord's own embed limits. */
function embedSize(e: EmbedBuilder): number {
  const j: APIEmbed = e.toJSON();
  expect((j.title ?? '').length).toBeLessThanOrEqual(256);
  expect((j.description ?? '').length).toBeLessThanOrEqual(4096);
  expect((j.footer?.text ?? '').length).toBeLessThanOrEqual(2048);
  expect((j.fields ?? []).length).toBeLessThanOrEqual(25);
  for (const f of j.fields ?? []) {
    expect(f.name.length).toBeLessThanOrEqual(256);
    expect(f.value.length).toBeLessThanOrEqual(1024);
  }
  return (
    (j.title ?? '').length +
    (j.description ?? '').length +
    (j.footer?.text ?? '').length +
    (j.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0)
  );
}

/** Message component limits: ≤5 rows, ≤5 buttons or 1 select per row, ids ≤100 chars. */
function checkComponents(view: Pick<View, 'components'>): Array<Record<string, unknown>> {
  expect(view.components.length).toBeLessThanOrEqual(5);
  const all: Array<Record<string, unknown>> = [];
  for (const row of view.components) {
    const comps = row.toJSON().components as unknown as Array<Record<string, unknown>>;
    expect(comps.length).toBeGreaterThan(0);
    expect(comps.length).toBeLessThanOrEqual(5);
    if (comps.some((c) => c.type !== 2)) expect(comps).toHaveLength(1);
    for (const c of comps) {
      expect(String(c.custom_id).length).toBeLessThanOrEqual(100);
      if (Array.isArray(c.options)) expect(c.options.length).toBeLessThanOrEqual(25);
    }
    all.push(...comps);
  }
  return all;
}

function context(opts: { stale?: boolean; now?: () => number } = {}) {
  const repos = memoryDb();
  const packs = demoRegistry();
  seedPacks(repos.stations, packs);
  const sources = new SourceService({
    stations: repos.stations,
    guilds: repos.guilds,
    client: new SafeHttpClient(new UrlPolicy({ allowInsecureHttp: true })),
    registry: new ProcessRegistry(),
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    maxConcurrentProbes: 1,
    logger: silentLogger(),
    metrics: new Metrics(),
  });
  const ids = new ComponentIds('test-secret', opts.now);
  const ctx = {
    config: loadConfig({ DISCORD_TOKEN: 'x'.repeat(30), DISCORD_APPLICATION_ID: GUILD }),
    stations: repos.stations,
    guilds: repos.guilds,
    packs,
    sources,
    ids,
    sessions: { get: () => null },
    catalogueSync: {
      lastSync: () => ({ at: '2026-10-30T00:00:00.000Z', ok: true }),
      isStale: () => opts.stale ?? false,
    },
  } as unknown as AppContext;
  return { ctx, ids, ...repos };
}

const parseAll = (ids: ComponentIds, comps: Array<Record<string, unknown>>) =>
  comps.map((c) => ids.parse(GUILD, String(c.custom_id)));

describe('list arguments for paging buttons', () => {
  it.each([
    ['all', null, 0],
    ['packs', 'demo', 0],
    ['packs', null, 3],
    ['custom', null, 1],
    ['favourites', null, 0],
    ['packs', 'my-pack', -1],
  ] as const)('round-trips %s / %s / page %i', (scope, pack, page) => {
    expect(parseListArg(listArg(scope, pack, page))).toEqual({ scope, pack, page });
  });

  it('falls back to the first page of every station for unknown input', () => {
    expect(parseListArg('')).toEqual({ scope: 'all', pack: null, page: 0 });
    expect(parseListArg('bogus_x:pz')).toEqual({ scope: 'all', pack: 'x', page: 0 });
  });

  it('fits through a signed component id', () => {
    const ids = new ComponentIds('s');
    const arg = listArg('packs', 'a'.repeat(32), 49);
    const parsed = ids.parse(GUILD, ids.make(GUILD, 'list', arg));
    expect(parsed).toMatchObject({ action: 'list', arg });
  });
});

describe('control buttons', () => {
  it('offers playback buttons, with skip only when something is queued', () => {
    const { ctx, ids } = context();
    const rows = controlRows(ctx, GUILD, null);
    const comps = checkComponents({ components: rows });
    expect(parseAll(ids, comps).map((p) => p && 'action' in p && p.action)).toEqual([
      'prev',
      'next',
      'obrowse',
      'now',
      'stop',
      'leave',
    ]);
  });

  it('lays the buttons out in rows of two or three, one blurple button at most per row and Leave the only red', () => {
    const { ctx, ids, guilds } = context();
    guilds.enqueue(GUILD, 'demo:demo-chic', null);
    const rows = controlRows(ctx, GUILD, 'demo:demo-radio', true).map((r) => r.toJSON().components);
    const actions = rows.map((r) =>
      r.map(
        (c) =>
          (ids.parse(GUILD, String((c as { custom_id: string }).custom_id)) as { action: string }).action,
      ),
    );
    // Change station; pick or keep a station; its sources; then the card itself, with ending
    // playback last. At most three to a row, so a 375-wide phone shows each row on one line.
    expect(actions).toEqual([
      ['prev', 'next', 'skip'],
      ['obrowse', 'fav'],
      ['srcs', 'insp'],
      ['now', 'stop', 'leave'],
    ]);
    const labels = rows.map((r) => r.map((c) => (c as { label: string }).label));
    expect(labels[0]).toEqual(['Previous', 'Next', 'Skip']);
    const styles = rows.map((r) => r.map((c) => (c as { style: ButtonStyle }).style));
    for (const r of styles) expect(r.filter((s) => s === ButtonStyle.Primary).length).toBeLessThanOrEqual(1);
    // Exactly one red: Leave, the last button of the last row. Stop stays grey (the bot stays).
    expect(styles.flat().filter((s) => s === ButtonStyle.Danger)).toHaveLength(1);
    expect(rows.at(-1)!.at(-1)).toMatchObject({ label: 'Leave', style: ButtonStyle.Danger });
    expect(rows.at(-1)!.find((c) => (c as { label: string }).label === 'Stop')).toMatchObject({
      style: ButtonStyle.Secondary,
    });
    // Skip is blurple while something is queued ("Up next" lists it); an empty queue is grey.
    expect(styles[0]!.at(-1)).toBe(ButtonStyle.Primary);
    guilds.clearQueue(GUILD);
    const empty = controlRows(ctx, GUILD, null, true);
    expect(empty[0]!.toJSON().components.at(-1)).toMatchObject({
      label: 'Skip',
      style: ButtonStyle.Secondary,
    });
    // With no station there is nothing to favourite or inspect, so Browse has its row alone.
    expect(empty.map((r) => r.toJSON().components.length)).toEqual([3, 1, 3]);
  });

  it('adds station buttons carrying the station id, and a queue-aware skip', () => {
    const { ctx, ids, guilds } = context();
    guilds.enqueue(GUILD, 'demo:demo-chic', null);
    guilds.enqueue(GUILD, 'demo:demo-dance', null);
    guilds.toggleFavourite(GUILD, 'demo:demo-radio');
    const rows = controlRows(ctx, GUILD, 'demo:demo-radio');
    const comps = checkComponents({ components: rows });
    expect(comps.find((c) => c.label === 'Skip')).toMatchObject({ style: ButtonStyle.Primary });
    expect(comps.map((c) => c.label)).toContain('Unfavourite');
    const parsed = parseAll(ids, comps).filter((p) => p && 'action' in p && p.arg);
    expect(parsed.map((p) => p && 'action' in p && [p.action, p.arg])).toEqual([
      ['unfav', 'demo:demo-radio'],
      ['srcs', 'demo:demo-radio'],
      ['insp', 'demo:demo-radio'],
    ]);
  });

  it('builds persistent panel buttons that never expire, and card buttons that last an hour', () => {
    let now = 1_800_000_000_000;
    const { ctx, ids } = context({ now: () => now });
    const panel = checkComponents({ components: controlRows(ctx, GUILD, 'demo:demo-chic', true) });
    const temporary = checkComponents({ components: controlRows(ctx, GUILD, 'demo:demo-chic') });
    expect(panel).toHaveLength(10);
    expect(panel.map((c) => c.label)).toEqual(expect.arrayContaining(['Skip', 'Browse']));
    // Still working after the 15 minutes they used to last, and up to the hour.
    now += 59 * 60_000;
    expect(parseAll(ids, temporary).every((p) => p && !p.expired)).toBe(true);
    now += 2 * 60_000;
    expect(parseAll(ids, panel).every((p) => p && !p.expired)).toBe(true);
    expect(parseAll(ids, temporary).every((p) => p?.expired)).toBe(true);
  });
});

describe('browse and list views', () => {
  it('pages the catalogue 20 stations at a time with a matching picker', () => {
    const { ctx, ids } = context();
    const pageButtons = (v: View) =>
      checkComponents(v).filter(
        (c) =>
          c.type === 2 && (ids.parse(GUILD, String(c.custom_id)) as { action?: string })?.action === 'browse',
      );
    const first = browseView(ctx, GUILD, { pack: null, category: null, search: null }, 'tok123', 0);
    const comps = checkComponents(first);
    const select = comps.find((c) => c.type === 3)!;
    expect((select.options as unknown[]).length).toBe(20);
    const [prev, next] = pageButtons(first);
    expect(prev!.disabled).toBe(true);
    expect(next!.disabled).toBe(false);
    expect(ids.parse(GUILD, String(next!.custom_id))).toMatchObject({ action: 'browse', arg: 'tok123:p1' });
    // Browse and list number their pages the same way.
    expect(first.embeds[0]!.toJSON().footer?.text).toMatch(/^Page 1\/2 · 26 stations\. /);
    // The page buttons come last, as a pair, under the favourites switch.
    expect(first.components.at(-1)!.toJSON().components).toHaveLength(2);
    embedSize(first.embeds[0]!);

    const last = browseView(ctx, GUILD, { pack: null, category: null, search: null }, 'tok123', 99);
    expect(last.embeds[0]!.toJSON().footer?.text).toMatch(/^Page 2\/2/);
    expect(pageButtons(last)[1]!.disabled).toBe(true);
  });

  it('shows no page buttons when every station fits on one page', () => {
    const { ctx, ids } = context();
    const one = browseView(ctx, GUILD, { pack: null, category: null, search: 'techno' }, 'tok123', 0);
    const actions = parseAll(ids, checkComponents(one)).map((p) => p && 'action' in p && p.action);
    expect(actions).not.toContain('browse');
    expect(actions).toContain('bfav');
  });

  it('has a Favourites button that filters the list, and back', () => {
    const { ctx, ids, guilds } = context();
    const view = (category: string | null) =>
      checkComponents(browseView(ctx, GUILD, { pack: null, category, search: null }, 'tok123', 0)).find(
        (c) =>
          c.type === 2 &&
          ids.parse(GUILD, String(c.custom_id))?.expired === false &&
          (ids.parse(GUILD, String(c.custom_id)) as { action: string }).action === 'bfav',
      )!;
    expect(view(null)).toMatchObject({ label: 'No favourites yet', disabled: true });
    const [a, b] = ctx.stations.listStations(GUILD);
    guilds.toggleFavourite(GUILD, a!.id);
    guilds.toggleFavourite(GUILD, b!.id);
    expect(view(null)).toMatchObject({ label: 'Show favourites (2)', disabled: false });
    expect(ids.parse(GUILD, String(view(null).custom_id))).toMatchObject({ action: 'bfav', arg: 'tok123' });
    expect(view('favourites')).toMatchObject({ label: 'Show all stations', disabled: false });
    // A filter that is on is a state, not a next step: grey both ways.
    expect(view('favourites')).toMatchObject({ style: ButtonStyle.Secondary });
    expect(view(null)).toMatchObject({ style: ButtonStyle.Secondary });
  });

  it('never puts green and red in one row: green means "on", and only a settings switch is green', () => {
    const { ctx, guilds } = context();
    guilds.enqueue(GUILD, 'demo:demo-chic', null);
    guilds.toggleFavourite(GUILD, 'demo:demo-radio');
    const views = [
      { components: controlRows(ctx, GUILD, 'demo:demo-radio', true) },
      { components: controlRows(ctx, GUILD, null, false) },
      browseView(ctx, GUILD, { pack: null, category: null, search: null }, 'tok123', 0),
      browseView(ctx, GUILD, { pack: null, category: 'favourites', search: null }, 'tok123', 0),
    ];
    let green = 0;
    for (const v of views) {
      for (const r of v.components ?? []) {
        const styles = (r.toJSON().components as Array<{ style?: number }>).map((c) => c.style);
        expect(styles.includes(ButtonStyle.Success) && styles.includes(ButtonStyle.Danger)).toBe(false);
        expect(styles.filter((s) => s === ButtonStyle.Primary).length).toBeLessThanOrEqual(1);
        green += styles.filter((s) => s === ButtonStyle.Success).length;
      }
    }
    // Green is for settings switches that are on, and these views have none (see the settings card).
    expect(green).toBe(0);
  });

  it('says "No favourites yet" only when there are none, not when a search leaves none', () => {
    const { ctx, guilds } = context();
    const empty = () =>
      browseView(
        ctx,
        GUILD,
        { pack: null, category: 'favourites', search: 'zzzz' },
        't',
        0,
      ).embeds[0]!.toJSON();
    expect(empty().description).toMatch(/^No favourites yet\./);
    guilds.toggleFavourite(GUILD, ctx.stations.listStations(GUILD)[0]!.id);
    // There is a favourite now; the search is what found nothing, so say that.
    expect(empty().description).toMatch(/^No stations match\. Press \*\*Change search\*\*/);
    expect(empty().footer?.text).toMatch(/^Page 1\/1 · 0 stations · favourites only · search: "zzzz"\./);
  });

  it('filters by search, category and favourites and says when nothing matches', () => {
    const { ctx, guilds } = context();
    const search = browseView(ctx, GUILD, { pack: 'demo', category: null, search: 'techno' }, 't', 0);
    // The pack's heading is labelled, so it can't be mistaken for a station of the same name.
    expect(search.embeds[0]!.toJSON().description).toMatch(/^\*\*Pack: Radio Demo\*\*\n.*Demo Techno/);
    expect(search.embeds[0]!.toJSON().footer?.text).toMatch(/search: "techno"/);
    guilds.toggleFavourite(GUILD, 'demo:demo-yoga');
    const fav = browseView(ctx, GUILD, { pack: null, category: 'favourites', search: null }, 't', 0);
    expect(fav.embeds[0]!.toJSON().description).toMatch(/Demo Yoga/);
    expect(fav.embeds[0]!.toJSON().footer?.text).toMatch(/^Page 1\/1 · 1 station · favourites only\./);
    const none = browseView(ctx, GUILD, { pack: 'custom', category: null, search: null }, 't', 0);
    expect(none.embeds[0]!.toJSON().description).toMatch(/^No stations match\./);
    expect(none.components.every((r) => r.toJSON().components.every((c) => c.type === 2))).toBe(true);
    // One page: only the favourites switch, no page buttons.
    expect(none.components).toHaveLength(1);
    // A category filter is named as the suggestions name it, not by its ID.
    const cat = ctx.packs.categories()[0]!;
    const byCategory = browseView(ctx, GUILD, { pack: null, category: cat.id, search: null }, 't', 0);
    expect(byCategory.embeds[0]!.toJSON().footer?.text).toContain(`category: ${cat.name}`);
  });

  it('lists packs 20 per page with numbered ids, coverage and the generic disclaimer', () => {
    const { ctx, ids } = context({ stale: true });
    const v = listView(ctx, GUILD, 'packs', 'demo', 0);
    const e = v.embeds[0]!.toJSON();
    expect(e.title).toBe('Station pack: Radio Demo');
    expect(e.description).toMatch(/^\*\*Pack: Radio Demo\*\*\n1\. /);
    expect(e.description).toContain('`demo:demo-radio`');
    expect(e.footer?.text).toMatch(/Page 1\/2 · 26 stations · 26 with a known stream/);
    expect(e.footer?.text).toMatch(/list may be out of date/);
    // Only the generic notice: the bundled pack's footer never names its broadcaster.
    expect(e.footer?.text).toContain('not affiliated with or endorsed by any broadcaster');
    expect(e.footer?.text).not.toMatch(/Radio Demo|Demo Media/);
    embedSize(v.embeds[0]!);
    // The play menu, then the page buttons. A chosen pack has no custom stations to show or hide.
    const [menu, , next] = checkComponents(v);
    expect(ids.parse(GUILD, String(menu!.custom_id))).toMatchObject({ action: 'pick', arg: '' });
    expect(ids.parse(GUILD, String(next!.custom_id))).toMatchObject({ arg: 'packs_demo:p1' });
  });

  it('shows empty custom and favourite lists without paging buttons', () => {
    const { ctx } = context();
    const custom = listView(ctx, GUILD, 'custom', null, 0);
    expect(custom.embeds[0]!.toJSON().description).toMatch(/^This server has no custom stations yet\./);
    expect(custom.embeds[0]!.toJSON().footer?.text).toMatch(/^Page 1\/1 · 0 stations\. /);
    // No menu and no page buttons: only the way back to every station.
    expect(checkComponents(custom).map((c) => c.label)).toEqual(['Show all stations']);
    expect(listView(ctx, GUILD, 'favourites', null, 0).embeds[0]!.toJSON().description).toMatch(
      /No favourites yet/,
    );
  });

  it('lists custom stations by default, after the packs, with a toggle to hide them', () => {
    const { ctx, ids, stations } = context();
    stations.insertCustomStation({
      id: 'custom:my-station',
      guildId: GUILD,
      slug: 'my-station',
      displayName: 'My Station',
      description: null,
      category: null,
      websiteUrl: null,
      language: null,
      createdById: '900000000000000001',
    });
    const toggle = (v: View) =>
      checkComponents(v).find(
        (c) =>
          (ids.parse(GUILD, String(c.custom_id)) as { action?: string } | null)?.action === 'list' && c.label,
      )!;
    // 26 pack stations, then the custom one on page 2 under its own heading.
    const all = listView(ctx, GUILD, 'all', null, 1);
    const e = all.embeds[0]!.toJSON();
    expect(e.title).toBe('All stations');
    expect(e.description).toMatch(/\*\*Custom stations \(this server\)\*\*\n27\. \*\*My Station\*\*/);
    // The custom station here has no stream saved, so it is counted but has no known stream.
    expect(e.footer?.text).toMatch(/^Page 2\/2 · 27 stations · 26 with a known stream/);
    expect(toggle(all)).toMatchObject({ label: 'Hide custom stations (1)' });
    expect(ids.parse(GUILD, String(toggle(all).custom_id))).toMatchObject({ arg: 'packs_:p0' });
    // The menu plays from this page, and says which group each station is in when the page mixes them.
    const menu = checkComponents(all)[0]!;
    expect(ids.parse(GUILD, String(menu.custom_id))).toMatchObject({ action: 'pick' });
    const options = menu.options as Array<{ label: string; value: string; description: string }>;
    expect(options.at(-1)).toMatchObject({ label: 'My Station', value: 'custom:my-station' });
    expect(options.at(-1)!.description).toMatch(/· Custom \(this server\)$/);

    // Hidden: the packs only, and the toggle brings them back.
    const packs = listView(ctx, GUILD, 'packs', null, 3);
    expect(packs.embeds[0]!.toJSON().title).toBe('Station packs');
    expect(packs.embeds[0]!.toJSON().description).not.toMatch(/My Station/);
    expect(toggle(packs)).toMatchObject({ label: 'Show custom stations (1)' });
    expect(ids.parse(GUILD, String(toggle(packs).custom_id))).toMatchObject({ arg: 'all_:p0' });
  });

  it('has no custom toggle, and the plain title, when the server has no custom stations', () => {
    const { ctx, ids } = context();
    const v = listView(ctx, GUILD, 'all', null, 0);
    expect(v.embeds[0]!.toJSON().title).toBe('Station packs');
    const actions = checkComponents(v).map((c) => ids.parse(GUILD, String(c.custom_id)));
    // The menu and the two page buttons only.
    expect(actions.map((p) => p && 'action' in p && p.action)).toEqual(['pick', 'list', 'list']);
  });

  it('has a Search button that opens a search box holding the current search', () => {
    const { ctx, ids } = context();
    const button = (search: string | null) =>
      checkComponents(browseView(ctx, GUILD, { pack: null, category: null, search }, 'tok123', 0)).find(
        (c) => (ids.parse(GUILD, String(c.custom_id)) as { action?: string } | null)?.action === 'bsearch',
      )!;
    expect(button(null)).toMatchObject({ label: 'Search' });
    expect(button('techno')).toMatchObject({ label: 'Change search' });
    expect(ids.parse(GUILD, String(button(null).custom_id))).toMatchObject({ arg: 'tok123' });

    const modal = browseSearchModal(ctx, GUILD, 'tok123', 'techno').toJSON();
    expect(ids.parse(GUILD, modal.custom_id)).toMatchObject({ action: 'bsearch', arg: 'tok123' });
    expect(modal.custom_id.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(modal.components)).toContain('"value":"techno"');
    expect(JSON.stringify(browseSearchModal(ctx, GUILD, 'tok123', null).toJSON())).not.toContain('"value"');
  });

  it('offers at most 25 candidates when a name is ambiguous', () => {
    const { ctx, ids, stations } = context();
    const candidates = stations.listStations(null).slice(0, 40);
    const v = ambiguityView(ctx, GUILD, 'demo', candidates, { channelId: '323456789012345678' });
    const [select] = checkComponents(v);
    expect((select!.options as unknown[]).length).toBe(25);
    // The picker plays in the channel the original /radio play named.
    expect(parseAll(ids, [select!])[0]).toMatchObject({ action: 'pick', arg: '323456789012345678' });
    embedSize(v.embeds[0]!);
  });

  it('only offers a play picker for /radio play; other commands ask for the exact name', () => {
    const { ctx, stations } = context();
    const v = ambiguityView(ctx, GUILD, 'demo', stations.listStations(null).slice(0, 3), null);
    expect(v.components).toEqual([]);
    expect(v.embeds[0]!.toJSON().description).toMatch(/Run the command again/);
    expect(v.embeds[0]!.toJSON().footer?.text).toBe(DISCLAIMER);
  });

  it('names the pack of each match only when the matches come from more than one', () => {
    const { ctx, ids, stations } = context();
    stations.insertCustomStation({
      id: 'custom:my-station',
      guildId: GUILD,
      slug: 'my-station',
      displayName: 'My Station',
      description: null,
      category: null,
      websiteUrl: null,
      language: null,
      createdById: '900000000000000001',
    });
    const pack = stations.listStations(null)[0]!;
    const custom = stations.getStation('custom:my-station')!;
    const mixed = ambiguityView(ctx, GUILD, 'my', [pack, custom], { channelId: null });
    expect(mixed.embeds[0]!.toJSON().description).toContain('· Custom (this server)');
    const [select] = checkComponents(mixed);
    const options = select!.options as Array<{ description: string }>;
    expect(options[1]!.description).toMatch(/^.+ · Custom \(this server\)$/);
    expect(parseAll(ids, [select!])[0]).toMatchObject({ action: 'pick' });
    const samePack = ambiguityView(ctx, GUILD, 'x', stations.listStations(null).slice(0, 2), {
      channelId: null,
    });
    const [one] = checkComponents(samePack);
    // One pack: the availability alone, no pack name.
    for (const o of one!.options as Array<{ description: string }>)
      expect(o.description).not.toContain(' · ');
  });
});

describe('settings card', () => {
  type Node = Record<string, unknown> & { type: number; components?: Node[]; accessory?: Node };
  /** Every component of a card, nested ones included, as Discord receives them. */
  const nodes = (card: SettingsCard): Node[] => {
    const out: Node[] = [];
    const walk = (list: Node[]) => {
      for (const n of list) {
        out.push(n);
        if (n.components) walk(n.components);
        if (n.accessory) walk([n.accessory]);
      }
    };
    walk(card.components.map((c) => c.toJSON() as unknown as Node));
    return out;
  };
  const textOf = (card: SettingsCard) =>
    nodes(card)
      .filter((n) => n.type === 10)
      .map((n) => String(n.content))
      .join('\n');
  const controls = (card: SettingsCard) => nodes(card).filter((n) => [2, 3, 5, 6, 7, 8].includes(n.type));
  const byArg = (ids: ComponentIds, card: SettingsCard, arg: string) =>
    controls(card).find((c) => {
      const p = ids.parse(GUILD, String(c.custom_id));
      return p && !p.expired && p.arg === arg;
    });

  it.each(SETTINGS_SCREENS)(
    'builds a valid %s screen within Discord’s limits and fit for a phone',
    (screen) => {
      const { ctx, ids, guilds } = context();
      // Long lists and every optional part shown, for the largest card each screen can make.
      const many = (start: number) =>
        Array.from({ length: 50 }, (_, n) => `7${String(start + n).padStart(17, '0')}`);
      const s = guilds.updateSettings(GUILD, {
        allowedTextChannelIds: many(100),
        allowedVoiceChannelIds: many(200),
        djRoleIds: many(300),
        qualityMode: 'manual',
        manualBitrateKbps: 256,
        defaultStationId: 'demo:demo-chic',
        preferredVoiceChannelId: '700000000000000001',
        notificationChannelId: '700000000000000002',
        panelChannelId: '700000000000000003',
        autostart: true,
        voiceLock: true,
      });
      const card = settingsCard(ctx, GUILD, s, screen, '⚠️ A note about the last change.');
      expect(card.flags).toBe(MessageFlags.IsComponentsV2);
      expect(card.allowedMentions).toEqual({ parse: [] });
      // Discord: at most 40 components in all, counting the ones inside others.
      expect(nodes(card).length).toBeLessThanOrEqual(40);
      // Kept well under the 4000 characters a message's text displays may hold.
      expect(textOf(card).length).toBeLessThanOrEqual(2000);
      expect(textOf(card).startsWith('⚠️ A note about the last change.')).toBe(true);
      let red = 0;
      for (const c of controls(card)) {
        const id = String(c.custom_id);
        expect(id.length).toBeLessThanOrEqual(100);
        expect(['cfg', 'close']).toContain((ids.parse(GUILD, id) as { action?: string }).action);
        // Short enough to show in full on a phone.
        if (c.type === 2) expect(String(c.label).length).toBeLessThanOrEqual(20);
        if (c.style === ButtonStyle.Danger) red++;
        // Green means "on", so only the switches are green.
        if (c.style === ButtonStyle.Success) expect(c.label).toBe('On');
        for (const o of (c.options ?? []) as Array<{ label: string; description?: string }>) {
          expect(o.label.length).toBeLessThanOrEqual(30);
          expect((o.description ?? '').length).toBeLessThanOrEqual(40);
        }
        if (c.placeholder) expect(String(c.placeholder).length).toBeLessThanOrEqual(40);
      }
      expect(red).toBeLessThanOrEqual(1);
      // In each row: at most one blurple button, and never green beside red.
      for (const r of nodes(card).filter((n) => n.type === 1)) {
        const styles = (r.components ?? []).map((c) => c.style);
        expect(styles.filter((x) => x === ButtonStyle.Primary).length).toBeLessThanOrEqual(1);
        expect(styles.includes(ButtonStyle.Success) && styles.includes(ButtonStyle.Danger)).toBe(false);
      }
    },
  );

  it('the overview shows every setting, so a server’s set-up reads at a glance', () => {
    const { ctx, guilds } = context();
    const s = guilds.updateSettings(GUILD, {
      allowedTextChannelIds: ['700000000000000011'],
      djRoleIds: ['223456789012345678'],
      memberControlMode: 'any',
      defaultStationId: 'demo:demo-chic',
      preferredVoiceChannelId: '700000000000000001',
      voiceLock: true,
      qualityMode: 'balanced',
      idleMode: 'pause_when_empty',
      autostart: true,
      notificationChannelId: '700000000000000002',
      voiceChannelStatus: false,
      panelChannelId: '700000000000000003',
    });
    const text = textOf(settingsCard(ctx, GUILD, s, 'home'));
    for (const line of [
      'Commands work in: <#700000000000000011>',
      'Radio plays in: every voice channel',
      'DJ roles: <@&223456789012345678>',
      'Listeners can control it: from anywhere',
      'Default station: Demo Chic',
      'Preferred voice channel: <#700000000000000001> (locked)',
      'Autostart: on · Resume after a restart: off',
      'Quality: Balanced (up to 128 kbps)',
      'When everyone leaves: pause, and play again when someone joins',
      'Problem notices: <#700000000000000002>',
      'Voice channel status: off',
      'Posted in <#700000000000000003>',
    ])
      expect(text).toContain(line);
    // Set up: nothing is missing, so no checklist, and Set up is no longer the recommended step.
    expect(text).not.toMatch(/Getting started/);
  });

  it('points a new server at Set up, and says what is still missing', () => {
    const { ctx, ids, guilds } = context();
    const fresh = settingsCard(ctx, GUILD, guilds.getSettings(GUILD), 'home');
    expect(textOf(fresh)).toContain('**Getting started:** ⬜ Voice channel · ⬜ Default station');
    expect(byArg(ids, fresh, 'go:setup1')).toMatchObject({ label: 'Set up', style: ButtonStyle.Primary });
    const half = settingsCard(
      ctx,
      GUILD,
      guilds.updateSettings(GUILD, { preferredVoiceChannelId: '700000000000000001' }),
      'home',
    );
    expect(textOf(half)).toContain('✅ Voice channel · ⬜ Default station');
  });

  it('says when autostart or channel lock is on but can’t work yet, and greys them out until they can', () => {
    const { ctx, ids, guilds } = context();
    const s = guilds.updateSettings(GUILD, { autostart: true, voiceLock: true });
    expect(textOf(settingsCard(ctx, GUILD, s, 'home'))).toContain(
      '⚠️ Autostart does nothing yet: it needs a default station and a preferred voice channel.',
    );
    expect(textOf(settingsCard(ctx, GUILD, s, 'home'))).toContain(
      '⚠️ Channel lock does nothing yet: it needs a preferred voice channel.',
    );
    // On, so they can still be switched off.
    const on = settingsCard(ctx, GUILD, s, 'playing');
    expect(byArg(ids, on, 'autostart:playing')).toMatchObject({ label: 'On', disabled: false });
    const off = settingsCard(
      ctx,
      GUILD,
      guilds.updateSettings(GUILD, { autostart: false, voiceLock: false }),
      'playing',
    );
    expect(byArg(ids, off, 'autostart:playing')).toMatchObject({ label: 'Off', disabled: true });
    expect(byArg(ids, off, 'lock:playing')).toMatchObject({ label: 'Off', disabled: true });
    expect(textOf(off)).toContain('-# Needs a default station and a preferred voice channel first.');
    const ready = settingsCard(
      ctx,
      GUILD,
      guilds.updateSettings(GUILD, {
        defaultStationId: 'demo:demo-chic',
        preferredVoiceChannelId: '700000000000000001',
      }),
      'playing',
    );
    expect(byArg(ids, ready, 'autostart:playing')).toMatchObject({ disabled: false });
    expect(textOf(ready)).not.toMatch(/Needs/);
  });

  it('says when the default station is no longer available', () => {
    const { ctx, guilds } = context();
    const s = guilds.updateSettings(GUILD, { defaultStationId: 'gone:station' });
    expect(textOf(settingsCard(ctx, GUILD, s, 'home'))).toContain(
      'Default station: a station that is no longer available',
    );
  });

  it('marks the installation’s defaults and the current choices in the menus', () => {
    const { ctx, ids, guilds } = context();
    const s = guilds.updateSettings(GUILD, {
      idleMode: '24x7',
      memberControlMode: 'any',
      qualityMode: 'balanced',
    });
    const sound = settingsCard(ctx, GUILD, s, 'sound');
    const quality = byArg(ids, sound, 'quality:sound')!.options as Array<{
      value: string;
      description: string;
      default: boolean;
    }>;
    expect(quality.find((o) => o.value === 'maximum')!.description).toBe(
      'Follow the station’s bitrate (default)',
    );
    expect(quality.filter((o) => o.default).map((o) => o.value)).toEqual(['balanced']);
    const idle = byArg(ids, sound, 'idle:sound')!.options as Array<{ value: string; description: string }>;
    expect(idle.find((o) => o.value === 'leave_when_empty')!.description).toMatch(/\(default\)$/);
    const access = settingsCard(ctx, GUILD, s, 'access');
    const member = byArg(ids, access, 'member:access')!.options as Array<{ value: string; default: boolean }>;
    expect(member.filter((o) => o.default).map((o) => o.value)).toEqual(['any']);
  });

  it('shows the manual bitrate only with Manual quality, and the cap that applies', () => {
    const { ctx, ids, guilds } = context();
    const max = ctx.config.maxOpusBitrateKbps;
    expect(
      byArg(ids, settingsCard(ctx, GUILD, guilds.getSettings(GUILD), 'sound'), 'bitrate:sound'),
    ).toBeUndefined();
    const unset = settingsCard(ctx, GUILD, guilds.updateSettings(GUILD, { qualityMode: 'manual' }), 'sound');
    expect(byArg(ids, unset, 'bitrate:sound')).toMatchObject({ label: 'Set' });
    expect(textOf(unset)).toContain('Not set yet, so Manual follows the station.');
    expect(qualityText(guilds.updateSettings(GUILD, { manualBitrateKbps: max + 10 }), max)).toBe(
      `Manual (${max + 10} kbps, capped at ${max})`,
    );
  });

  it('setup offers Skip until a question is answered, then Next', () => {
    const { ctx, ids, guilds } = context();
    const step1 = settingsCard(ctx, GUILD, guilds.getSettings(GUILD), 'setup1');
    expect(byArg(ids, step1, 'go:setup2')).toMatchObject({ label: 'Skip', style: ButtonStyle.Secondary });
    expect(byArg(ids, step1, 'go:home')).toMatchObject({ label: 'Back' });
    const answered = guilds.updateSettings(GUILD, { preferredVoiceChannelId: '700000000000000001' });
    expect(byArg(ids, settingsCard(ctx, GUILD, answered, 'setup1'), 'go:setup2')).toMatchObject({
      label: 'Next',
      style: ButtonStyle.Primary,
    });
    // No station yet: choosing one is the recommended step.
    const step2 = settingsCard(ctx, GUILD, answered, 'setup2');
    expect(byArg(ids, step2, 'station:setup2')).toMatchObject({
      label: 'Choose a station',
      style: ButtonStyle.Primary,
    });
    expect(textOf(settingsCard(ctx, GUILD, answered, 'setup4'))).toContain('Step 4 of 4');
  });

  it('the reset confirmation says what everything goes back to, and what stays', () => {
    const { ctx, ids, guilds } = context();
    const card = settingsCard(ctx, GUILD, guilds.updateSettings(GUILD, { qualityMode: 'balanced' }), 'reset');
    const text = textOf(card);
    expect(text).toContain('- Sound: Maximum (follows each station’s bitrate, up to');
    expect(text).toContain('when everyone leaves: leave the channel');
    expect(text).toContain('resume after a restart off');
    expect(text).toContain(
      'Favourites, source choices, custom stations and the control panel stay as they are.',
    );
    expect(byArg(ids, card, 'reset:home')).toMatchObject({
      label: 'Reset everything',
      style: ButtonStyle.Danger,
    });
  });

  it('offers Remove only when there is a control panel', () => {
    const { ctx, ids, guilds } = context();
    expect(
      byArg(ids, settingsCard(ctx, GUILD, guilds.getSettings(GUILD), 'panel'), 'go:unpanel'),
    ).toBeUndefined();
    const none = settingsCard(ctx, GUILD, guilds.getSettings(GUILD), 'unpanel');
    expect(byArg(ids, none, 'unpanel:panel')).toBeUndefined();
    expect(textOf(none)).toContain('There is no control panel to remove.');
    const posted = guilds.updateSettings(GUILD, { panelChannelId: '700000000000000003' });
    expect(byArg(ids, settingsCard(ctx, GUILD, posted, 'panel'), 'go:unpanel')).toMatchObject({
      style: ButtonStyle.Danger,
    });
  });

  it('builds forms within Discord’s limits', () => {
    const { ctx, ids, stations } = context();
    const all = stations.listStations(GUILD);
    const station = stationModal(ctx, GUILD, 'setup2', all, all[0]!.id, () => 'favourite').toJSON();
    expect(station.title.length).toBeLessThanOrEqual(45);
    expect(station.components.length).toBeLessThanOrEqual(5);
    expect(ids.parse(GUILD, station.custom_id)).toMatchObject({ action: 'cfgm', arg: 'station:setup2' });
    const labels = station.components as unknown as Array<{
      label: string;
      description: string;
      component: { options?: Array<{ value: string; default?: boolean }> };
    }>;
    for (const l of labels) {
      expect(l.label.length).toBeLessThanOrEqual(45);
      expect(l.description.length).toBeLessThanOrEqual(100);
    }
    const options = labels[0]!.component.options!;
    expect(options.length).toBeLessThanOrEqual(25);
    expect(options[0]).toMatchObject({ value: NO_DEFAULT_STATION, default: false });
    expect(options.find((o) => o.value === all[0]!.id)!.default).toBe(true);
    const bitrate = bitrateModal(ctx, GUILD, 'sound', null).toJSON();
    expect(ids.parse(GUILD, bitrate.custom_id)).toMatchObject({ action: 'cfgm', arg: 'bitrate:sound' });
    expect(JSON.stringify(bitrate)).not.toContain('"value"');
  });

  it('resets to what a new server gets', () => {
    const { guilds } = context();
    const fresh = guilds.getSettings('323456789012345678');
    const defaults = guilds.defaultSettings();
    for (const [key, value] of Object.entries(defaults))
      expect(fresh[key as keyof typeof fresh], key).toEqual(value);
  });

  it('knows its screens', () => {
    expect(isSettingsScreen('home')).toBe(true);
    expect(isSettingsScreen('setup5')).toBe(true);
    expect(isSettingsScreen('nowhere')).toBe(false);
    expect(isSettingsScreen(undefined)).toBe(false);
  });
});

describe('formatting helpers', () => {
  it('labels transport and availability', () => {
    expect(transportLabel('hls')).toBe('HLS (delivery protocol)');
    expect(transportLabel('http-continuous')).toBe('Direct HTTP stream');
    expect(transportLabel(null)).toBe('Unknown transport');
    expect(availabilityBadge('available')).toBe('🟢 Available');
    expect(availabilityBadge('no_source')).toBe('⚫ No stream source known');
  });

  it('describes measured formats and is explicit about unknowns (NFR-12)', () => {
    expect(sourceFormat(makeSource())).toBe('MP3 · ≈128 kbps (measured) · 44.1 kHz · stereo');
    const unknown = makeSource({
      codec: null,
      codecHint: 'aac',
      measuredBitrateKbps: null,
      codecBitrateKbps: null,
      advertisedBitrateKbps: null,
      sampleRateHz: null,
      channels: null,
    });
    expect(sourceFormat(unknown)).toBe(
      'codec not measured (hint: aac) · bitrate unknown · sample rate unknown · channels unknown',
    );
    const advertised = { measuredBitrateKbps: null, codecBitrateKbps: null, advertisedBitrateKbps: 256 };
    expect(sourceFormat(makeSource({ ...advertised, transport: 'hls' }))).toContain('(manifest, unverified)');
    expect(sourceFormat(makeSource(advertised))).toContain('(advertised, unverified)');
    expect(sourceFormat(makeSource({ measuredBitrateKbps: null }))).toContain('(codec metadata)');
    expect(sourceFormat(makeSource({ channels: 1 }))).toMatch(/mono$/);
    expect(sourceFormat(makeSource({ channels: 6 }))).toMatch(/6 channels$/);
  });

  it('summarises identity with the first decisive piece of evidence', () => {
    const at = new Date().toISOString();
    expect(identityLine(makeSource({ identityConfidence: 'high' }))).toBe(
      'Verified as this station (high confidence)',
    );
    const mismatch = makeSource({
      identityStatus: 'mismatch',
      identityEvidence: [
        { kind: 'metadata', verdict: 'inconclusive', detail: 'brand only', at },
        { kind: 'metadata', verdict: 'contradicts', detail: 'x'.repeat(300), at },
      ],
    });
    const line = identityLine(mismatch);
    expect(line.startsWith('Plays a different station, so it is not used: xxx')).toBe(true);
    expect(line.length).toBeLessThanOrEqual('Plays a different station, so it is not used: '.length + 160);
    expect(identityLine(makeSource({ identityStatus: 'unverified' }))).toBe(
      'Not yet verified as this station',
    );
  });

  it('reports the Discord output and that the channel setting is not a cap', () => {
    expect(outputLine(null)).toBe('Not encoding.');
    const plan = planEncoder({
      qualityMode: 'maximum',
      manualBitrateKbps: null,
      channelBitrateBps: 64_000,
      sourceSampleRateHz: 44_100,
      sourceChannels: 2,
    });
    expect(outputLine(plan)).toBe(
      'Opus · 48 kHz · stereo · 20 ms frames · encoder target 510 kbps (maximum quality) · voice channel bitrate setting 64 kbps (does not limit the bot)',
    );
  });

  it('marks the current station and custom stations', () => {
    const st = { displayName: 'Mine', provider: 'custom' } as Station;
    expect(stationLine(st, 'unverified', true)).toBe('▶ **Mine** — ⚪ Unverified · custom');
  });

  it('truncates free-text embeds to Discord limits', () => {
    expect(errorEmbed('e'.repeat(5000)).toJSON().description).toHaveLength(2000);
    const info = infoEmbed('t'.repeat(300), 'm'.repeat(5000)).toJSON();
    expect(info.title).toHaveLength(256);
    expect(info.description).toHaveLength(4000);
  });
});

describe('status embeds', () => {
  const station = { id: 'demo:demo-chic', displayName: 'Demo Chic', provider: 'demo' } as Station;
  const status = (o: Partial<SessionStatus> = {}): SessionStatus =>
    ({
      guildId: GUILD,
      state: 'PLAYING',
      desiredState: 'playing',
      stationId: station.id,
      channelId: 'v1',
      source: makeSource(),
      selection: null,
      plan: planEncoder({
        qualityMode: 'maximum',
        manualBitrateKbps: null,
        channelBitrateBps: 96_000,
        sourceSampleRateHz: 44_100,
        sourceChannels: 2,
      }),
      startedAt: Date.now(),
      nowPlaying: null,
      lastError: null,
      observedOutputKbps: null,
      observedInputKbps: null,
      encryption: 'aead_aes256_gcm_rtpsize',
      inputTransport: 'http-continuous',
      hls: null,
      ...o,
    }) as SessionStatus;

  it('shows an idle embed when nothing plays', () => {
    const e = nowEmbed(null, null, null).toJSON();
    expect(e.title).toBe('Radio is idle');
    expect(e.footer?.text).toBe(DISCLAIMER);
    expect(nowEmbed(station, status({ state: 'IDLE' }), null).toJSON().title).toBe('Radio is idle');
  });

  it('lays out the song, the stream and why this source plays', () => {
    const e = nowEmbed(station, status(), '999').toJSON();
    expect(e.title).toBe('▶ Playing: Demo Chic');
    expect(e.color).toBe(COLOR.ok);
    expect(e.description).toBe('-# The station isn’t sending a song or show title right now.');
    const fields = Object.fromEntries((e.fields ?? []).map((f) => [f.name, f]));
    // One full-width field, not three narrow columns, which wrapped the stream on a phone. The
    // bitrate carries its evidence here too, as in Sources.
    expect(fields.Stream?.inline).toBeFalsy();
    expect(fields.Stream?.value).toMatch(
      /^Direct MP3 · ≈128 kbps \(measured\)\nTo Discord: Opus · \d+ kbps · in <#999>$/,
    );
    expect(fields.Source?.value).toMatch(/Verified as this station · checked/);
    const titled = nowEmbed(
      station,
      status({ nowPlaying: { title: 'Artist - Song', receivedAt: new Date().toISOString() } as never }),
      null,
    ).toJSON();
    expect(titled.description).toMatch(/^🎵 \*\*Artist - Song\*\*\n-# From the station’s stream, updated /);
    const hostile = nowEmbed(
      station,
      status({
        nowPlaying: {
          title: '[Free](https://evil.example) **now**',
          receivedAt: new Date().toISOString(),
        } as never,
      }),
      null,
    ).toJSON();
    expect(hostile.description).toContain(String.raw`\[Free](https://evil.example) \*\*now\*\*`);
    // Short enough to read at a glance: no field runs to more than a few lines.
    for (const f of e.fields ?? []) expect(f.value.split('\n').length).toBeLessThanOrEqual(3);
  });

  it('shows the last error while recovering', () => {
    const e = nowEmbed(
      station,
      status({
        state: 'RECOVERING',
        lastError: { code: 'STREAM_STALLED', message: 'The stream stalled.', at: '' },
      }),
      null,
    ).toJSON();
    expect(e.title).toBe('Reconnecting to the stream: Demo Chic');
    expect(e.description).toContain('⚠️ The stream stalled.');
    expect(e.color).toBe(COLOR.warn);
  });

  it('colours each playback state the same way in every view', () => {
    expect(stateColor('PLAYING')).toBe(COLOR.ok);
    expect(stateColor('ERROR')).toBe(COLOR.error);
    expect(stateColor('RECOVERING')).toBe(COLOR.warn);
    expect(stateColor('FAILING_OVER')).toBe(COLOR.warn);
    // Starting up is normal, not a fault: grey, like the "Joining…" message for the same moment.
    expect(stateColor('BUFFERING')).toBe(COLOR.neutral);
    expect(stateColor(undefined)).toBe(COLOR.neutral);
    expect(nowEmbed(station, status({ state: 'BUFFERING' }), null).toJSON().color).toBe(COLOR.neutral);
  });

  it('says Stopped after a listener stops it, without an old error, a fallback or empty stream facts', () => {
    const e = nowEmbed(
      station,
      status({
        state: 'CONNECTED',
        desiredState: 'stopped',
        selection: { degraded: true } as never,
        lastError: { code: 'STREAM_STALLED', message: 'The stream stalled.', at: '' },
      }),
      '999',
    ).toJSON();
    expect(e.title).toBe('Stopped: Demo Chic');
    expect(e.color).toBe(COLOR.neutral);
    expect(e.description).toBe('Nothing is playing. Press **Browse** or use `/radio play` to start again.');
    expect(e.description).not.toMatch(/⚠️|fallback/);
    expect((e.fields ?? []).map((f) => f.name)).toEqual(['Channel']);
  });

  it('says Paused while the channel is empty, and that it plays again when someone joins', () => {
    const e = nowEmbed(station, status({ state: 'CONNECTED', desiredState: 'paused_empty' }), '999').toJSON();
    expect(e.title).toBe('Paused: Demo Chic');
    expect(e.color).toBe(COLOR.neutral);
    expect(e.description).toMatch(/plays again when someone joins/);
  });

  it('writes a check just made the way every view writes a source', () => {
    const o = {
      codec: 'aac',
      profile: 'LC',
      measuredBitrateKbps: null,
      codecBitrateKbps: 127.9,
      advertisedBitrateKbps: null,
      sampleRateHz: 44_100,
      channels: 2,
      transport: 'http-continuous',
    } as unknown as ProbeOutcome;
    expect(checkedLine(o)).toBe(
      'AAC-LC · ≈128 kbps (codec metadata) · 44.1 kHz · stereo · Direct HTTP stream',
    );
    const unknown = {
      ...o,
      codec: null,
      profile: null,
      codecBitrateKbps: null,
      sampleRateHz: null,
      channels: null,
      transport: 'hls',
    } as unknown as ProbeOutcome;
    expect(checkedLine(unknown)).toBe(
      'codec unknown · bitrate unknown · sample rate unknown · channels unknown · HLS (delivery protocol)',
    );
  });

  it('reports one lossy encode and no processing in the quality embed', () => {
    expect(qualityEmbed(null, null).toJSON().description).toMatch(/Nothing is playing/);
    const e = qualityEmbed(station, status());
    embedSize(e);
    const text = JSON.stringify(e.toJSON());
    expect(text).toContain('exactly one lossy encode (MP3 → Opus)');
    expect(text).toContain('44100 Hz → 48000 Hz');
    expect(text).toContain('Volume/normalisation/EQ/compression: off');
    // The bitrate and its evidence are written as in every other view.
    expect(text).toContain('Bitrate: ≈128 kbps (measured)');
    const manifest = JSON.stringify(
      qualityEmbed(
        station,
        status({
          source: makeSource({
            transport: 'hls',
            measuredBitrateKbps: null,
            codecBitrateKbps: null,
            advertisedBitrateKbps: 96,
          }),
        }),
      ).toJSON(),
    );
    expect(manifest).toContain('Bitrate: ≈96 kbps (manifest, unverified)');
    const opus = JSON.stringify(
      qualityEmbed(station, status({ source: makeSource({ codec: 'opus' }) })).toJSON(),
    );
    expect(opus).toContain('the bot never passes a stream through unchanged');
  });

  it('lists sources with roles, redacted endpoints and within embed limits', () => {
    const now = Date.now();
    const sources: StationSource[] = Array.from({ length: 4 }, (_, i) =>
      makeSource({
        id: `demo-chic-src-${i}`,
        url: `https://stream.example.com/live${i}?token=SECRET${i}&listener=1`,
        transport: i === 3 ? 'hls' : 'http-continuous',
        priority: i,
        lastFailureCode: 'STREAM_STALLED',
        icyName: 'Demo Chic',
      }),
    );
    const selection = selectSource(sources, null, { now });
    const e = sourcesEmbed(station, sources, selection, true);
    expect(embedSize(e)).toBeLessThanOrEqual(6000);
    const text = JSON.stringify(e.toJSON());
    expect(text).not.toContain('SECRET');
    expect(text).toContain('#1 ');
    expect(text).toContain('— **best choice**');
    expect(text).toContain('— fallback');
    // Usable sources come first, in rank order; the best one heads the list.
    const fields = e.toJSON().fields ?? [];
    expect(fields[0]!.name).toMatch(/^#1 .*best choice/);
    // Inspect marks identity with the same ✅/❌/❔ as Sources.
    expect(fields[0]!.value.split('\n')[1]).toMatch(/^(✅|❌|❔) (Verified|Plays|Not yet)/);
    // What plays now, and a listener's choice, are marked.
    const live = sourcesEmbed(station, sources, selection, false, {
      playingId: selection.ordered[1]!.id,
      manualId: selection.ordered[1]!.id,
    }).toJSON();
    expect(live.fields![1]!.name).toMatch(/▶ playing now · chosen by a listener for this play/);
    expect(sourcesEmbed(station, [], selectSource([], null), false).toJSON().description).toMatch(
      /No stream is known/,
    );
  });

  it('stays within the 6000-character embed limit for stations with many detailed sources', () => {
    const now = Date.now();
    // Sources of slightly different sizes, so one of them fills the embed close to its budget.
    for (let extra = 0; extra < 60; extra += 3) {
      const sources: StationSource[] = Array.from({ length: 12 }, (_, i) =>
        makeSource({
          id: `example-station-with-a-long-name-source-${i}`,
          label: `Direct mount ${i} (high bitrate, primary CDN)`,
          url: `https://stream-${i}.example.com/a/very/long/mount/path/for/source/${i}/stream.mp3`,
          effectiveHost: `n0${i}-eu1.cdn.example.com`,
          priority: i,
          lastFailureCode: 'STREAM_STALLED',
          icyName: `An unusually long stream name ${'x'.repeat(extra)}`,
          healthScore: 40,
          cooldownUntil: new Date(now + 60_000).toISOString(),
        }),
      );
      const e = sourcesEmbed(station, sources, selectSource(sources, null, { now }), true);
      // The controller may add its "On this server" field (up to about 400 characters) and a
      // re-check summary, which fits itself into what is left.
      expect(embedSize(e)).toBeLessThanOrEqual(5500);
      expect(JSON.stringify(e.toJSON())).toMatch(/more sources? not shown/);
    }
  });
});
