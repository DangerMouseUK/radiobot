import { type APIEmbed, ButtonStyle, type EmbedBuilder } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { planEncoder } from '../../src/audio/encoder.ts';
import { ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import { PackRegistry, seedPacks } from '../../src/catalogue/packs.ts';
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
  ambiguityView,
  browseView,
  configView,
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
import { makeSource, memoryDb, silentLogger } from '../helpers.ts';

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
  const packs = PackRegistry.load(null);
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
    ['packs', 'fg', 0],
    ['packs', null, 3],
    ['custom', null, 1],
    ['favourites', null, 0],
    ['packs', 'my-pack', -1],
  ] as const)('round-trips %s / %s / page %i', (scope, pack, page) => {
    expect(parseListArg(listArg(scope, pack, page))).toEqual({ scope, pack, page });
  });

  it('falls back to the first page of all packs for unknown input', () => {
    expect(parseListArg('')).toEqual({ scope: 'packs', pack: null, page: 0 });
    expect(parseListArg('bogus_x:pz')).toEqual({ scope: 'packs', pack: 'x', page: 0 });
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

  it('lays the buttons out in three short rows, one blurple button at most per row and nothing red', () => {
    const { ctx, ids, guilds } = context();
    guilds.enqueue(GUILD, 'fg:fg-chic', null);
    const rows = controlRows(ctx, GUILD, 'fg:fg-dj-radio', true).map((r) => r.toJSON().components);
    const actions = rows.map((r) =>
      r.map(
        (c) =>
          (ids.parse(GUILD, String((c as { custom_id: string }).custom_id)) as { action: string }).action,
      ),
    );
    // Change station; this station; then the card itself, with ending playback last.
    expect(actions).toEqual([
      ['prev', 'next', 'skip'],
      ['obrowse', 'fav', 'srcs', 'insp'],
      ['now', 'stop', 'leave'],
    ]);
    const styles = rows.map((r) => r.map((c) => (c as { style: ButtonStyle }).style));
    for (const r of styles) expect(r.filter((s) => s === ButtonStyle.Primary).length).toBeLessThanOrEqual(1);
    expect(styles.flat()).not.toContain(ButtonStyle.Danger);
    // An empty queue doesn't call for attention.
    guilds.clearQueue(GUILD);
    const empty = controlRows(ctx, GUILD, null, true)[0]!.toJSON().components;
    expect(empty.at(-1)).toMatchObject({ label: 'Skip (queue empty)', style: ButtonStyle.Secondary });
  });

  it('adds station buttons carrying the station id, and a queue-aware skip', () => {
    const { ctx, ids, guilds } = context();
    guilds.enqueue(GUILD, 'fg:fg-chic', null);
    guilds.enqueue(GUILD, 'fg:fg-dance', null);
    guilds.toggleFavourite(GUILD, 'fg:fg-dj-radio');
    const rows = controlRows(ctx, GUILD, 'fg:fg-dj-radio');
    const comps = checkComponents({ components: rows });
    expect(comps.map((c) => c.label)).toContain('Skip (2 queued)');
    expect(comps.map((c) => c.label)).toContain('Unfavourite');
    const parsed = parseAll(ids, comps).filter((p) => p && 'action' in p && p.arg);
    expect(parsed.map((p) => p && 'action' in p && [p.action, p.arg])).toEqual([
      ['unfav', 'fg:fg-dj-radio'],
      ['srcs', 'fg:fg-dj-radio'],
      ['insp', 'fg:fg-dj-radio'],
    ]);
  });

  it('builds persistent panel buttons that never expire, and expiring ones otherwise', () => {
    let now = 1_800_000_000_000;
    const { ctx, ids } = context({ now: () => now });
    const panel = checkComponents({ components: controlRows(ctx, GUILD, 'fg:fg-chic', true) });
    const temporary = checkComponents({ components: controlRows(ctx, GUILD, 'fg:fg-chic') });
    expect(panel).toHaveLength(10);
    expect(panel.map((c) => c.label)).toEqual(expect.arrayContaining(['Skip (queue empty)', 'Browse']));
    now += 16 * 60_000;
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
    expect(first.embeds[0]!.toJSON().footer?.text).toMatch(/^Page 1\/4 · 63 stations\. /);
    // The page buttons come last, as a pair, under the favourites switch.
    expect(first.components.at(-1)!.toJSON().components).toHaveLength(2);
    embedSize(first.embeds[0]!);

    const last = browseView(ctx, GUILD, { pack: null, category: null, search: null }, 'tok123', 99);
    expect(last.embeds[0]!.toJSON().footer?.text).toMatch(/^Page 4\/4/);
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
    expect(empty().description).toMatch(/^No stations match\. Try a shorter search/);
    expect(empty().footer?.text).toMatch(/^Page 1\/1 · 0 stations · favourites only · search: "zzzz"\./);
  });

  it('explains the default station, and says when autostart is missing what it needs', () => {
    const { ctx, guilds } = context();
    const text = () => {
      const e = configView(ctx, GUILD, guilds.getSettings(GUILD), 'playback').embeds[0]!.toJSON();
      return [e.description, ...(e.fields ?? []).map((f) => `${f.name}\n${f.value}`)].join('\n');
    };
    expect(text()).toMatch(/default station is what `\/radio join` plays/);
    expect(text()).not.toMatch(/Autostart needs/);
    guilds.updateSettings(GUILD, { autostart: true });
    expect(text()).toMatch(
      /missing the default station and the preferred voice channel, so it does nothing yet/,
    );
    guilds.updateSettings(GUILD, { defaultStationId: ctx.stations.listStations(GUILD)[0]!.id });
    expect(text()).toMatch(/missing the preferred voice channel, so/);
    guilds.updateSettings(GUILD, { preferredVoiceChannelId: '700000000000000001' });
    expect(text()).not.toMatch(/Autostart needs/);
  });

  it('says when Channel lock is on without a preferred voice channel', () => {
    const { ctx, guilds } = context();
    const text = () =>
      configView(ctx, GUILD, guilds.getSettings(GUILD), 'playback').embeds[0]!.toJSON().fields![0]!.value;
    guilds.updateSettings(GUILD, { voiceLock: true });
    expect(text()).toContain('⚠️ Channel lock needs a preferred voice channel, so it does nothing yet.');
    guilds.updateSettings(GUILD, { preferredVoiceChannelId: '700000000000000001' });
    expect(text()).not.toMatch(/Channel lock needs/);
    // And that changes save straight away, since there is no Save button.
    const e = configView(ctx, GUILD, guilds.getSettings(GUILD), 'notify').embeds[0]!.toJSON();
    expect(e.description).toMatch(/Changes save as soon as you make them\./);
    expect(e.fields![0]!.value).toMatch(/optional Set Voice Channel Status permission/);
  });

  it('filters by search, category and favourites and says when nothing matches', () => {
    const { ctx, guilds } = context();
    const search = browseView(ctx, GUILD, { pack: 'fg', category: null, search: 'techno' }, 't', 0);
    expect(search.embeds[0]!.toJSON().description).toMatch(/FG TECHNO/);
    expect(search.embeds[0]!.toJSON().footer?.text).toMatch(/search: "techno"/);
    guilds.toggleFavourite(GUILD, 'fg:fg-yoga');
    const fav = browseView(ctx, GUILD, { pack: null, category: 'favourites', search: null }, 't', 0);
    expect(fav.embeds[0]!.toJSON().description).toMatch(/FG YOGA/);
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
    const v = listView(ctx, GUILD, 'packs', 'fg', 0);
    const e = v.embeds[0]!.toJSON();
    expect(e.title).toBe('Station pack: Radio FG');
    expect(e.description).toMatch(/^\*\*Radio FG\*\*\n1\. /);
    expect(e.description).toContain('`fg:fg-dj-radio`');
    expect(e.footer?.text).toMatch(/Page 1\/4 · 63 stations · 63 with a known stream/);
    expect(e.footer?.text).toMatch(/list may be out of date/);
    // Only the generic notice: the bundled pack's footer never names its broadcaster.
    expect(e.footer?.text).toContain('not affiliated with or endorsed by any broadcaster');
    expect(e.footer?.text).not.toMatch(/Radio FG|Maison/);
    embedSize(v.embeds[0]!);
    const nav = checkComponents(v);
    expect(ids.parse(GUILD, String(nav[1]!.custom_id))).toMatchObject({ arg: 'packs_fg:p1' });
  });

  it('shows empty custom and favourite lists without paging buttons', () => {
    const { ctx } = context();
    const custom = listView(ctx, GUILD, 'custom', null, 0);
    expect(custom.embeds[0]!.toJSON().description).toMatch(/^This server has no custom stations yet\./);
    expect(custom.embeds[0]!.toJSON().footer?.text).toMatch(/^Page 1\/1 · 0 stations\. /);
    expect(custom.components).toEqual([]);
    expect(listView(ctx, GUILD, 'favourites', null, 0).embeds[0]!.toJSON().description).toMatch(
      /No favourites yet/,
    );
  });

  it('offers at most 25 candidates when a name is ambiguous', () => {
    const { ctx, ids, stations } = context();
    const candidates = stations.listStations(null).slice(0, 40);
    const v = ambiguityView(ctx, GUILD, 'fg', candidates, { channelId: '323456789012345678' });
    const [select] = checkComponents(v);
    expect((select!.options as unknown[]).length).toBe(25);
    // The picker plays in the channel the original /radio play named.
    expect(parseAll(ids, [select!])[0]).toMatchObject({ action: 'pick', arg: '323456789012345678' });
    embedSize(v.embeds[0]!);
  });

  it('only offers a play picker for /radio play; other commands ask for the exact name', () => {
    const { ctx, stations } = context();
    const v = ambiguityView(ctx, GUILD, 'fg', stations.listStations(null).slice(0, 3), null);
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

describe('settings view', () => {
  it.each(['access', 'playback', 'notify'] as const)('builds a valid %s page with signed cfg ids', (page) => {
    const { ctx, ids, guilds } = context();
    const s = guilds.updateSettings(GUILD, {
      djRoleIds: ['223456789012345678'],
      qualityMode: 'manual',
      manualBitrateKbps: 256,
      defaultStationId: 'fg:fg-chic',
    });
    const v = configView(ctx, GUILD, s, page);
    const comps = checkComponents(v);
    for (const p of parseAll(ids, comps)) expect(p).toMatchObject({ action: 'cfg', expired: false });
    const e = v.embeds[0]!.toJSON();
    // Only the page being edited is shown, so the message stays short on a phone.
    const name = { access: 'Access', playback: 'Playback', notify: 'Notifications' }[page];
    expect(e.title).toBe(`Radio Bot settings: ${name}`);
    expect((e.fields ?? []).map((f) => f.name)).toEqual([name]);
    const d = e.fields![0]!.value;
    if (page === 'access') expect(d).toContain('<@&223456789012345678>');
    if (page === 'playback') {
      expect(d).toContain('FG CHIC');
      expect(d).toContain('manual (256 kbps)');
    }
    // Every page ends with the page buttons, and has room to spare under Discord's five rows.
    expect(v.components.length).toBeLessThanOrEqual(5);
    const last = v.components.at(-1)!.toJSON().components;
    expect(last.map((c) => (c as { label?: string }).label)).toEqual(['Access', 'Playback', 'Notifications']);
    // Option labels are short enough for a phone; the detail is in the description.
    for (const c of comps)
      for (const o of (Array.isArray(c.options) ? c.options : []) as { label: string }[])
        expect(o.label.length).toBeLessThanOrEqual(40);
  });

  it('marks the current choices in the access and playback selects', () => {
    const { ctx, guilds } = context();
    const s = guilds.updateSettings(GUILD, { idleMode: '24x7', memberControlMode: 'any' });
    const chosen = (page: 'access' | 'playback') =>
      checkComponents(configView(ctx, GUILD, s, page))
        .flatMap((c) => (Array.isArray(c.options) ? c.options : []))
        .filter((o: { default?: boolean }) => o.default)
        .map((o: { value: string }) => o.value);
    expect(chosen('access')).toEqual(['any']);
    expect(chosen('playback')).toEqual(['24x7', 'maximum']);
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
  const station = { id: 'fg:fg-chic', displayName: 'FG CHIC', provider: 'fg' } as Station;
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

  it('lays out the song, three short facts and why this source plays', () => {
    const e = nowEmbed(station, status(), '999').toJSON();
    expect(e.title).toBe('▶ Playing: FG CHIC');
    expect(e.color).toBe(COLOR.ok);
    expect(e.description).toBe('-# The station isn’t sending a song or show title right now.');
    const fields = Object.fromEntries((e.fields ?? []).map((f) => [f.name, f]));
    expect(fields.Channel).toMatchObject({ value: '<#999>', inline: true });
    // The bitrate carries its evidence here too, as in Sources.
    expect(fields['Station stream']).toMatchObject({
      value: 'Direct MP3 · ≈128 kbps (measured)',
      inline: true,
    });
    expect(fields['To Discord']?.value).toMatch(/^Opus · \d+ kbps$/);
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
    expect(e.title).toBe('Reconnecting to the stream: FG CHIC');
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
    expect(e.title).toBe('Stopped: FG CHIC');
    expect(e.color).toBe(COLOR.neutral);
    expect(e.description).toBe('Nothing is playing. Press **Browse** or use `/radio play` to start again.');
    expect(e.description).not.toMatch(/⚠️|fallback/);
    expect((e.fields ?? []).map((f) => f.name)).toEqual(['Channel']);
  });

  it('says Paused while the channel is empty, and that it plays again when someone joins', () => {
    const e = nowEmbed(station, status({ state: 'CONNECTED', desiredState: 'paused_empty' }), '999').toJSON();
    expect(e.title).toBe('Paused: FG CHIC');
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
        id: `fg-chic-src-${i}`,
        url: `https://stream.example.com/live${i}?token=SECRET${i}&listener=1`,
        transport: i === 3 ? 'hls' : 'http-continuous',
        priority: i,
        lastFailureCode: 'STREAM_STALLED',
        icyName: 'FG CHIC',
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
