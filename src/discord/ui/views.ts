import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  type MessageActionRowComponentBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { searchStations } from '../../catalogue/search.ts';
import { AVAILABILITY_LABEL, type Station } from '../../catalogue/types.ts';
import type { QueueEntry } from '../../persistence/repositories/guilds.ts';
import { truncate } from '../../shared/text.ts';
import type { CoverageCounts } from '../../streams/source-service.ts';
import type { ComponentAction } from '../components/custom-id.ts';
import type { AppContext } from '../context.ts';
import { catalogueKey, groupName, listedStation, visibleStations } from '../context.ts';
import { availabilityBadge, COLOR, DISCLAIMER, stationLine } from './format.ts';

type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;
const row = (...c: MessageActionRowComponentBuilder[]) =>
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...c);

export interface View {
  embeds: EmbedBuilder[];
  components: Row[];
}

/**
 * Shown when the bot has no stations at all: a fresh install starts with no station packs. Packs
 * are shared by every server, so only the bot's owner installs them.
 */
const NO_STATIONS_YET =
  'No stations yet. The bot’s operator can install station packs with `/radio packs library`, and admins can add a custom station with `/radio add`.';

/** Stations per page in browse and list. List lines carry IDs, so 20 keeps a page under 4000 characters. */
const PAGE_SIZE = 20;

/** "Page 1/3 · 63 stations": how every paged station list starts its footer. */
const pageLine = (p: number, pages: number, count: number) =>
  `Page ${p + 1}/${pages} · ${count} ${count === 1 ? 'station' : 'stations'}`;

/** Previous page and Next page, last in the message; nothing when everything fits on one page. */
function pageRow(
  ctx: AppContext,
  guildId: string,
  action: 'browse' | 'list',
  arg: (page: number) => string,
  p: number,
  pages: number,
): Row[] {
  if (pages <= 1) return [];
  return [
    row(
      new ButtonBuilder()
        .setCustomId(ctx.ids.make(guildId, action, arg(p - 1)))
        .setLabel('Previous page')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(p === 0),
      new ButtonBuilder()
        .setCustomId(ctx.ids.make(guildId, action, arg(p + 1)))
        .setLabel('Next page')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(p >= pages - 1),
    ),
  ];
}

/** A browse filter in the words the category suggestions use ("Electronic", not its ID). */
function categoryFilter(ctx: AppContext, category: string): string {
  if (category === 'favourites') return 'favourites only';
  if (category === 'custom') return 'category: custom stations';
  return `category: ${ctx.packs.categories().find((c) => c.id === category)?.name ?? category}`;
}

/** A browse list's search results, with what they were worked out from. */
export interface BrowseResults {
  key: string;
  stations: readonly Station[];
}

export interface BrowseState {
  /** A pack id, "custom" or null for everything. */
  pack: string | null;
  /** A category id, "favourites", or null. */
  category: string | null;
  search: string | null;
  /**
   * The search's results (at most 500 stations), kept so that Next page and Previous page don't
   * search the whole catalogue again. Reused only while the catalogue, the filters, the search
   * and (for the favourites filter) the favourites are what they were.
   */
  results?: BrowseResults | undefined;
}

/** How many stations a browse search keeps, best first. */
const BROWSE_SEARCH_LIMIT = 500;

/** Filters the browse list. Stations stay grouped by pack, in pack order, custom stations last. */
export function browseStations(
  ctx: AppContext,
  guildId: string,
  state: BrowseState,
  /** This server's favourites, when the caller has read them already. */
  allFavourites?: readonly string[],
): readonly Station[] {
  const favourites =
    state.category === 'favourites' ? (allFavourites ?? ctx.guilds.listFavourites(guildId)) : null;
  const key = state.search
    ? [
        catalogueKey(ctx),
        state.pack ?? '',
        state.category ?? '',
        state.search,
        favourites?.join(',') ?? '',
      ].join('|')
    : null;
  if (key !== null && state.results?.key === key) return state.results.stations;
  state.results = undefined;
  let list = visibleStations(ctx, guildId);
  if (state.pack) list = list.filter((s) => s.provider === state.pack);
  if (favourites) {
    const fav = new Set(favourites);
    list = list.filter((s) => fav.has(s.id));
  } else if (state.category === 'custom') {
    list = list.filter((s) => s.provider === 'custom');
  } else if (state.category) {
    list = list.filter((s) => s.category === state.category);
  }
  if (key !== null) {
    const order = new Map(
      searchStations(list, state.search!, BROWSE_SEARCH_LIMIT).map((h, i) => [h.station.id, i]),
    );
    list = list.filter((s) => order.has(s.id)).sort((x, y) => order.get(x.id)! - order.get(y.id)!);
    state.results = { key, stations: list };
  }
  return list;
}

/**
 * The heading over a group of stations. A pack's is labelled, so it never reads as a station when a
 * pack and its main station share a name; custom stations aren't a pack.
 */
function groupHeading(ctx: AppContext, provider: string): string {
  return provider === 'custom' ? 'Custom stations (this server)' : `Pack: ${groupName(ctx, provider)}`;
}

/** Station lines grouped under their pack (or custom stations) headings. */
function groupedLines(
  ctx: AppContext,
  stations: readonly Station[],
  current: string | null,
  withIds = false,
  offset = 0,
): string[] {
  const lines: string[] = [];
  let group: string | null = null;
  stations.forEach((s, i) => {
    if (s.provider !== group) {
      if (lines.length > 0) lines.push('');
      lines.push(`**${groupHeading(ctx, s.provider)}**`);
      group = s.provider;
    }
    const prefix = withIds ? `${offset + i + 1}. ` : '';
    const suffix = withIds ? ` — \`${s.id}\`` : '';
    lines.push(`${prefix}${stationLine(s, ctx.sources.availability(s), s.id === current)}${suffix}`);
  });
  return lines;
}

export function browseView(
  ctx: AppContext,
  guildId: string,
  state: BrowseState,
  token: string,
  page: number,
): View {
  const favouriteIds = ctx.guilds.listFavourites(guildId);
  const all = browseStations(ctx, guildId, state, favouriteIds);
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = all.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  const current = ctx.sessions.get(guildId)?.stationId ?? null;
  const favourites = favouriteIds.length;
  const onlyFavourites = state.category === 'favourites';
  const lines = groupedLines(ctx, slice, current);
  const filter = [
    state.pack ? `pack: ${groupName(ctx, state.pack)}` : null,
    state.category ? categoryFilter(ctx, state.category) : null,
    state.search ? `search: "${state.search}"` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const embed = new EmbedBuilder()
    .setTitle('Browse stations')
    .setColor(COLOR.info)
    .setDescription(
      truncate(
        lines.length > 0
          ? lines.join('\n')
          : // "No favourites yet" only when there are none: a search can also leave the favourites empty.
            onlyFavourites && favourites === 0
            ? 'No favourites yet. Press Favourite under a playing station to add one.'
            : state.search
              ? 'No stations match. Press **Change search** to try a shorter or different word, or empty the search to see every station.'
              : visibleStations(ctx, guildId).length === 0
                ? NO_STATIONS_YET
                : 'No stations match. Try another filter, or run `/radio browse` on its own to see every station.',
        4000,
      ),
    )
    .setFooter({ text: `${pageLine(p, pages, all.length)}${filter ? ` · ${filter}` : ''}. ${DISCLAIMER}` });
  const components: Row[] = [];
  if (slice.length > 0) {
    const select = new StringSelectMenuBuilder()
      .setCustomId(ctx.ids.make(guildId, 'pick'))
      .setPlaceholder('Choose a station to play')
      .addOptions(
        slice.map((s) => ({
          label: truncate(s.displayName, 100),
          value: s.id,
          description: truncate(
            `${AVAILABILITY_LABEL[ctx.sources.availability(s)]}${s.tags.length ? ` · ${s.tags.slice(0, 3).join(', ')}` : ''}`,
            100,
          ),
          default: s.id === current,
        })),
      );
    components.push(row(select));
  }
  // Search and the favourites switch share a row, so the page buttons below them stay an even pair.
  components.push(
    row(
      new ButtonBuilder()
        .setCustomId(ctx.ids.make(guildId, 'bsearch', token))
        .setLabel(state.search ? 'Change search' : 'Search')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(ctx.ids.make(guildId, 'bfav', token))
        .setLabel(
          onlyFavourites
            ? 'Show all stations'
            : favourites
              ? `Show favourites (${favourites})`
              : 'No favourites yet',
        )
        // Grey either way: blurple marks a next step, never a state (the title says what's shown).
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!onlyFavourites && favourites === 0),
    ),
    ...pageRow(ctx, guildId, 'browse', (n) => `${token}:p${n}`, p, pages),
  );
  return { embeds: [embed], components };
}

/** The custom ID of the search modal's text box. */
export const SEARCH_INPUT = 'search';

/** The text box behind Browse's Search button; it keeps the current search so it can be changed. */
export function browseSearchModal(ctx: AppContext, guildId: string, token: string, current: string | null) {
  const input = new TextInputBuilder()
    .setCustomId(SEARCH_INPUT)
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(60)
    .setPlaceholder('For example: jazz');
  if (current) input.setValue(current);
  return new ModalBuilder()
    .setCustomId(ctx.ids.make(guildId, 'bsearch', token))
    .setTitle('Search stations')
    .addLabelComponents(
      new LabelBuilder()
        .setLabel('Name, alias or genre')
        .setDescription('Leave it empty to see every station again.')
        .setTextInputComponent(input),
    );
}

/**
 * Disambiguation for a station name, which never guesses (FR-001). Only `/radio play` gets a
 * picker (which plays, in the channel it named); other commands list the matches and ask for
 * the exact name.
 */
export function ambiguityView(
  ctx: AppContext,
  guildId: string,
  query: string,
  candidates: Station[],
  play: { channelId: string | null } | null,
): View {
  // The pack is shown only when the matches come from more than one, which is when it tells them apart.
  const several = new Set(candidates.map((s) => s.provider)).size > 1;
  const where = (s: Station) => (several ? ` · ${groupName(ctx, s.provider)}` : '');
  const avail = candidates.map((s) => ctx.sources.availability(s));
  const list = candidates
    .map((s, n) => `• ${s.displayName} — ${availabilityBadge(avail[n]!)}${where(s)}`)
    .join('\n');
  const ask = play
    ? 'Pick one below.'
    : 'Run the command again and choose the station from the suggestions as you type.';
  const embed = new EmbedBuilder()
    .setColor(COLOR.warn)
    .setTitle('Which station did you mean?')
    .setDescription(truncate(`"${query}" matches several stations. ${ask}\n\n${list}`, 4000))
    .setFooter({ text: DISCLAIMER });
  if (!play) return { embeds: [embed], components: [] };
  const select = new StringSelectMenuBuilder()
    .setCustomId(ctx.ids.make(guildId, 'pick', play.channelId ?? ''))
    .setPlaceholder('Choose the exact station')
    .addOptions(
      candidates.slice(0, 25).map((s, n) => ({
        label: truncate(s.displayName, 100),
        value: s.id,
        description: truncate(`${AVAILABILITY_LABEL[avail[n]!]}${where(s)}`, 100),
      })),
    );
  return { embeds: [embed], components: [row(select)] };
}

/** `all` is every station (the packs, then this server's custom stations); the others narrow it. */
export type ListScope = 'all' | 'packs' | 'custom' | 'favourites';

/** Encodes a list query into a component argument (pack ids never contain "_"). */
export const listArg = (scope: ListScope, pack: string | null, page: number) =>
  `${scope}_${pack ?? ''}:p${page}`;

export function parseListArg(arg: string): { scope: ListScope; pack: string | null; page: number } {
  const [head = '', p = 'p0'] = arg.split(':');
  const [scope, pack] = head.split('_');
  const valid: ListScope[] = ['all', 'packs', 'custom', 'favourites'];
  return {
    scope: valid.includes(scope as ListScope) ? (scope as ListScope) : 'all',
    pack: pack ? pack : null,
    page: Number(p.slice(1)) || 0,
  };
}

/**
 * The button that widens or narrows the list: hide or show this server's custom stations, or go
 * back to every station from the custom or favourites list. None when a pack is chosen.
 */
function listToggle(ctx: AppContext, guildId: string, scope: ListScope, pack: string | null, custom: number) {
  let to: ListScope;
  let label: string;
  if (scope === 'custom' || scope === 'favourites') {
    to = 'all';
    label = 'Show all stations';
  } else if (pack || custom === 0) {
    return null;
  } else if (scope === 'all') {
    to = 'packs';
    label = `Hide custom stations (${custom})`;
  } else {
    to = 'all';
    label = `Show custom stations (${custom})`;
  }
  return new ButtonBuilder()
    .setCustomId(ctx.ids.make(guildId, 'list', listArg(to, null, 0)))
    .setLabel(label)
    .setStyle(ButtonStyle.Secondary);
}

/** Why a chosen pack lists nothing: it isn't installed, it is switched off, or it has no stations. */
function noPackStations(ctx: AppContext, pack: string): string {
  const loaded = ctx.packs.get(pack);
  if (!loaded)
    return `No station pack called \`${truncate(pack.replaceAll('`', ''), 40)}\` is installed. Run \`/radio list\` on its own to see every station.`;
  if (!ctx.packs.isEnabled(pack))
    return `The station pack ${loaded.meta.name} is switched off on this bot, so its stations can’t be listed or played.`;
  return `The station pack ${loaded.meta.name} has no stations to list.`;
}

/**
 * Stream counts for the listed stations: each pack's cached counts (one pack can have thousands
 * of stations, so they are never counted on a page click), plus this server's custom stations,
 * which are few and counted now.
 */
function listCoverage(
  ctx: AppContext,
  scope: ListScope,
  pack: string | null,
  custom: Station[],
  list: readonly Station[],
): CoverageCounts {
  // Only a hand-made button names "custom" as a pack; its list is the custom stations.
  if (pack === 'custom') return ctx.sources.coverage([...list]);
  const total: CoverageCounts = { catalogued: 0, withSources: 0, usable: 0, verifiedPlayable: 0 };
  const add = (c: CoverageCounts) => {
    total.catalogued += c.catalogued;
    total.withSources += c.withSources;
    total.usable += c.usable;
    total.verifiedPlayable += c.verifiedPlayable;
  };
  const packs = pack
    ? ctx.packs.isEnabled(pack)
      ? [pack]
      : []
    : ctx.packs.enabledPacks().map((p) => p.meta.id);
  for (const id of packs) add(ctx.sources.coverageByProvider(id));
  if (!pack && scope === 'all' && custom.length > 0) add(ctx.sources.coverage(custom));
  return total;
}

export function listView(
  ctx: AppContext,
  guildId: string,
  scope: ListScope,
  pack: string | null,
  page: number,
): View {
  const all = visibleStations(ctx, guildId);
  const custom = all.filter((s) => s.provider === 'custom');
  let list: readonly Station[];
  if (scope === 'favourites') {
    // Each favourite looked up by ID: no table of the whole catalogue on every page click.
    list = ctx.guilds
      .listFavourites(guildId)
      .map((id) => listedStation(ctx, guildId, id))
      .filter((s): s is Station => Boolean(s));
  } else if (scope === 'custom') {
    list = custom;
  } else if (pack) {
    // A chosen pack lists only that pack, whichever of the two wider scopes asked for it.
    list = all.filter((s) => s.provider === pack);
  } else {
    // Already in order: the packs, then this server's custom stations.
    list = scope === 'all' ? all : all.filter((s) => s.provider !== 'custom');
  }
  const per = PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(list.length / per));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = list.slice(p * per, (p + 1) * per);
  const current = ctx.sessions.get(guildId)?.stationId ?? null;
  const lines = groupedLines(ctx, slice, current, true, p * per);
  const title =
    scope === 'favourites'
      ? 'Favourite stations'
      : scope === 'custom'
        ? 'Custom stations (this server)'
        : pack
          ? `Station pack: ${groupName(ctx, pack)}`
          : scope === 'all' && custom.length > 0
            ? 'All stations'
            : 'Station packs';
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(COLOR.info)
    .setDescription(
      truncate(
        lines.join('\n') ||
          (scope === 'favourites'
            ? 'No favourites yet. Press Favourite under a playing station to add one.'
            : scope === 'custom'
              ? 'This server has no custom stations yet. Admins can add one with `/radio add`.'
              : pack
                ? noPackStations(ctx, pack)
                : NO_STATIONS_YET),
        4000,
      ),
    );
  let footer = pageLine(p, pages, list.length);
  if (scope === 'all' || scope === 'packs') {
    const cov = listCoverage(ctx, scope, pack, custom, list);
    footer += ` · ${cov.withSources} with a known stream · ${cov.usable} with a working stream · ${cov.verifiedPlayable} verified and playable`;
    const packMeta = pack ? ctx.packs.get(pack) : null;
    if (packMeta?.meta.sync) {
      const sync = ctx.catalogueSync.lastSync(packMeta.meta.id);
      if (ctx.catalogueSync.isStale(packMeta.meta.id, ctx.config.catalogSyncIntervalHours))
        footer += ' · list may be out of date';
      else if (sync.at) footer += ` · synced ${sync.at.slice(0, 10)}`;
    }
    if (packMeta?.meta.disclaimer) footer += ` · ${packMeta.meta.disclaimer}`;
  }
  embed.setFooter({ text: truncate(`${footer}. ${DISCLAIMER}`, 2048) });
  // The menu plays a station from this page, as Browse's does; then the toggle, then the pages.
  const components: Row[] = [];
  if (slice.length > 0) {
    // The pack is shown only when the page mixes several, which is when it tells them apart.
    const several = new Set(slice.map((s) => s.provider)).size > 1;
    components.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(ctx.ids.make(guildId, 'pick'))
          .setPlaceholder('Choose a station to play')
          .addOptions(
            slice.map((s) => ({
              label: truncate(s.displayName, 100),
              value: s.id,
              description: truncate(
                `${AVAILABILITY_LABEL[ctx.sources.availability(s)]}${several ? ` · ${groupName(ctx, s.provider)}` : ''}`,
                100,
              ),
              default: s.id === current,
            })),
          ),
      ),
    );
  }
  const toggle = listToggle(ctx, guildId, scope, pack, custom.length);
  if (toggle) components.push(row(toggle));
  components.push(...pageRow(ctx, guildId, 'list', (n) => listArg(scope, pack, n), p, pages));
  return { embeds: [embed], components };
}

/**
 * How long a now-playing card's buttons work. The bot keeps nothing for a card (the expiry is in
 * each button's signed ID), so a long life costs nothing; an hour covers someone who leaves the
 * card open while they listen. Browse lists keep state in memory, so they stay at 15 minutes.
 */
export const CARD_TTL_MS = 60 * 60_000;

/**
 * Now-playing controls. `persistent` buttons (control panel) do not expire but are re-authorised on
 * click. A caller that has already read the queue (for "Up next") passes it, so it is read once.
 */
export function controlRows(
  ctx: AppContext,
  guildId: string,
  stationId: string | null,
  persistent = false,
  queue: readonly QueueEntry[] = ctx.guilds.listQueue(guildId),
): Row[] {
  const ttl = persistent ? null : CARD_TTL_MS;
  const b = (action: ComponentAction, label: string, style: ButtonStyle, arg = '') =>
    new ButtonBuilder()
      .setCustomId(ctx.ids.make(guildId, action, arg, ttl))
      .setLabel(label)
      .setStyle(style);
  // Rows of two or three short buttons: a 375-wide phone has room for about 290 pixels of buttons,
  // so four in a row would wrap unevenly. Change station; pick or keep a station; look at its
  // sources; then the card itself, with ending playback last. Colours follow the rule in format.ts:
  // Browse (and Skip while something is queued) is the recommended next step, so blurple. Leave is
  // the one red: it ends playback for everyone in the channel and takes a new /radio join or play
  // to undo, like Discord's own Disconnect. Stop stays grey: the bot stays in the channel, and any
  // station button undoes it. Skip shows no count: "Up next" lists the queue, and the count made
  // the row too wide.
  const tune: ButtonBuilder[] = [
    b('prev', 'Previous', ButtonStyle.Secondary),
    b('next', 'Next', ButtonStyle.Secondary),
  ];
  const queued = queue.length;
  if (persistent || queued > 0)
    tune.push(b('skip', 'Skip', queued > 0 ? ButtonStyle.Primary : ButtonStyle.Secondary));
  const rows: Row[] = [row(...tune)];
  if (stationId) {
    // The button says what it does, so a second click or an old card can't undo it.
    const fav = ctx.guilds.isFavourite(guildId, stationId);
    rows.push(
      row(
        b('obrowse', 'Browse', ButtonStyle.Primary),
        fav
          ? b('unfav', 'Unfavourite', ButtonStyle.Secondary, stationId)
          : b('fav', 'Favourite', ButtonStyle.Secondary, stationId),
      ),
      row(
        b('srcs', 'Sources', ButtonStyle.Secondary, stationId),
        b('insp', 'Inspect', ButtonStyle.Secondary, stationId),
      ),
    );
  } else rows.push(row(b('obrowse', 'Browse', ButtonStyle.Primary)));
  rows.push(
    row(
      b('now', 'Refresh', ButtonStyle.Secondary),
      b('stop', 'Stop', ButtonStyle.Secondary),
      b('leave', 'Leave', ButtonStyle.Danger),
    ),
  );
  return rows;
}
