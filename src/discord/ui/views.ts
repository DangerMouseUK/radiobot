import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  type MessageActionRowComponentBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { searchStations } from '../../catalogue/search.ts';
import { AVAILABILITY_LABEL, type Station } from '../../catalogue/types.ts';
import type { GuildSettings, QueueEntry } from '../../persistence/repositories/guilds.ts';
import { truncate } from '../../shared/text.ts';
import type { ComponentAction } from '../components/custom-id.ts';
import type { AppContext } from '../context.ts';
import { groupName, visibleStations } from '../context.ts';
import { availabilityBadge, COLOR, DISCLAIMER, stationLine } from './format.ts';

type Row = ActionRowBuilder<MessageActionRowComponentBuilder>;
const row = (...c: MessageActionRowComponentBuilder[]) =>
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...c);

export interface View {
  embeds: EmbedBuilder[];
  components: Row[];
}

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

export interface BrowseState {
  /** A pack id, "custom" or null for everything. */
  pack: string | null;
  /** A category id, "favourites", or null. */
  category: string | null;
  search: string | null;
}

/** Filters the browse list. Stations stay grouped by pack, in pack order, custom stations last. */
export function browseStations(ctx: AppContext, guildId: string, state: BrowseState): Station[] {
  let list = visibleStations(ctx, guildId);
  if (state.pack) list = list.filter((s) => s.provider === state.pack);
  if (state.category === 'favourites') {
    const fav = new Set(ctx.guilds.listFavourites(guildId));
    list = list.filter((s) => fav.has(s.id));
  } else if (state.category === 'custom') {
    list = list.filter((s) => s.provider === 'custom');
  } else if (state.category) {
    list = list.filter((s) => s.category === state.category);
  }
  if (state.search) {
    const order = new Map(searchStations(list, state.search, 500).map((h, i) => [h.station.id, i]));
    list = list.filter((s) => order.has(s.id)).sort((x, y) => order.get(x.id)! - order.get(y.id)!);
  }
  return list;
}

/** Station lines grouped under their pack (or "Custom") headings. */
function groupedLines(
  ctx: AppContext,
  stations: Station[],
  current: string | null,
  withIds = false,
  offset = 0,
): string[] {
  const lines: string[] = [];
  let group: string | null = null;
  stations.forEach((s, i) => {
    if (s.provider !== group) {
      if (lines.length > 0) lines.push('');
      lines.push(`**${groupName(ctx, s.provider)}**`);
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
  const all = browseStations(ctx, guildId, state);
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const slice = all.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  const current = ctx.sessions.get(guildId)?.stationId ?? null;
  const favourites = ctx.guilds.listFavourites(guildId).length;
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
            : 'No stations match. Try a shorter search or another filter, or run `/radio browse` on its own to see every station.',
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
  // The favourites switch has a row of its own, so the page buttons below it stay an even pair.
  components.push(
    row(
      new ButtonBuilder()
        .setCustomId(ctx.ids.make(guildId, 'bfav', token))
        .setLabel(
          onlyFavourites
            ? 'Show all stations'
            : favourites
              ? `Show favourites (${favourites})`
              : 'No favourites yet',
        )
        .setStyle(onlyFavourites ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(!onlyFavourites && favourites === 0),
    ),
    ...pageRow(ctx, guildId, 'browse', (n) => `${token}:p${n}`, p, pages),
  );
  return { embeds: [embed], components };
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

export type ListScope = 'packs' | 'custom' | 'favourites';

/** Encodes a list query into a component argument (pack ids never contain "_"). */
export const listArg = (scope: ListScope, pack: string | null, page: number) =>
  `${scope}_${pack ?? ''}:p${page}`;

export function parseListArg(arg: string): { scope: ListScope; pack: string | null; page: number } {
  const [head = '', p = 'p0'] = arg.split(':');
  const [scope, pack] = head.split('_');
  const valid: ListScope[] = ['packs', 'custom', 'favourites'];
  return {
    scope: valid.includes(scope as ListScope) ? (scope as ListScope) : 'packs',
    pack: pack ? pack : null,
    page: Number(p.slice(1)) || 0,
  };
}

export function listView(
  ctx: AppContext,
  guildId: string,
  scope: ListScope,
  pack: string | null,
  page: number,
): View {
  const all = visibleStations(ctx, guildId);
  let list: Station[];
  if (scope === 'favourites') {
    // A lookup table, not a search per favourite: favourites have no cap, and packs can be large.
    const byId = new Map(all.map((s) => [s.id, s]));
    list = ctx.guilds
      .listFavourites(guildId)
      .map((id) => byId.get(id))
      .filter((s): s is Station => Boolean(s));
  } else if (scope === 'custom') {
    list = all.filter((s) => s.provider === 'custom');
  } else {
    list = all.filter((s) => s.provider !== 'custom' && (!pack || s.provider === pack));
  }
  const per = PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(list.length / per));
  const p = Math.min(Math.max(0, page), pages - 1);
  const lines = groupedLines(ctx, list.slice(p * per, (p + 1) * per), null, true, p * per);
  const title =
    scope === 'favourites'
      ? 'Favourite stations'
      : scope === 'custom'
        ? 'Custom stations (this server)'
        : pack
          ? `Station pack: ${groupName(ctx, pack)}`
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
              : 'No stations.'),
        4000,
      ),
    );
  let footer = pageLine(p, pages, list.length);
  if (scope === 'packs') {
    const cov = ctx.sources.coverage(list);
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
  return {
    embeds: [embed],
    components: pageRow(ctx, guildId, 'list', (n) => listArg(scope, pack, n), p, pages),
  };
}

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
  const ttl = persistent ? null : 15 * 60_000;
  const b = (action: ComponentAction, label: string, style: ButtonStyle, arg = '') =>
    new ButtonBuilder()
      .setCustomId(ctx.ids.make(guildId, action, arg, ttl))
      .setLabel(label)
      .setStyle(style);
  // Three short rows, so each wraps evenly on a phone: change station, this station, then the
  // card itself and ending playback last. Blurple marks the main action of a row; nothing here
  // deletes anything, so nothing is red.
  const tune: ButtonBuilder[] = [
    b('prev', 'Previous', ButtonStyle.Secondary),
    b('next', 'Next', ButtonStyle.Secondary),
  ];
  const queued = queue.length;
  if (persistent || queued > 0) {
    tune.push(
      queued > 0
        ? b('skip', `Skip (${queued} queued)`, ButtonStyle.Primary)
        : b('skip', 'Skip (queue empty)', ButtonStyle.Secondary),
    );
  }
  const station: ButtonBuilder[] = [b('obrowse', 'Browse', ButtonStyle.Primary)];
  if (stationId) {
    // The button says what it does, so a second click or an old card can't undo it.
    const fav = ctx.guilds.isFavourite(guildId, stationId);
    station.push(
      fav
        ? b('unfav', 'Unfavourite', ButtonStyle.Secondary, stationId)
        : b('fav', 'Favourite', ButtonStyle.Secondary, stationId),
      b('srcs', 'Sources', ButtonStyle.Secondary, stationId),
      b('insp', 'Inspect', ButtonStyle.Secondary, stationId),
    );
  }
  return [
    row(...tune),
    row(...station),
    row(
      b('now', 'Refresh', ButtonStyle.Secondary),
      b('stop', 'Stop', ButtonStyle.Secondary),
      b('leave', 'Leave', ButtonStyle.Secondary),
    ),
  ];
}

export type ConfigPage = 'access' | 'playback' | 'notify';

const PAGE_LABEL: Record<ConfigPage, string> = {
  access: 'Access',
  playback: 'Playback',
  notify: 'Notifications',
};

const IDLE_LABEL: Record<GuildSettings['idleMode'], string> = {
  leave_when_empty: 'leave',
  pause_when_empty: 'pause, and resume when someone joins',
  '24x7': 'keep playing (24/7)',
};

export function configView(ctx: AppContext, guildId: string, s: GuildSettings, page: ConfigPage): View {
  const id = (field: string) => ctx.ids.make(guildId, 'cfg', field, 30 * 60_000);
  const station = s.defaultStationId ? ctx.stations.getStation(s.defaultStationId) : null;
  // Long lists are shortened, so a field never exceeds Discord's 1024-character limit.
  const fmtIds = (ids: string[], kind: '#' | '@&') =>
    ids.length === 0
      ? 'any'
      : `${ids
          .slice(0, 6)
          .map((x) => `<${kind}${x}>`)
          .join(', ')}${ids.length > 6 ? ` and ${ids.length - 6} more` : ''}`;
  // Only the page being edited is shown, so the message stays short on a phone; the page
  // buttons switch between them.
  const fields = {
    access: {
      name: 'Access',
      value: truncate(
        [
          `Commands work in: ${fmtIds(s.allowedTextChannelIds, '#')}`,
          `Radio can play in: ${fmtIds(s.allowedVoiceChannelIds, '#')}`,
          `DJ roles: ${s.djRoleIds.length ? fmtIds(s.djRoleIds, '@&') : 'none'}`,
          `Listeners can control: ${s.memberControlMode === 'same_channel' ? 'from the bot’s voice channel' : s.memberControlMode === 'any' ? 'from anywhere' : 'no (DJs and admins only)'}`,
          '-# Admins are the server owner and members with the Administrator permission.',
        ].join('\n'),
        1024,
      ),
    },
    playback: {
      name: 'Playback',
      value: truncate(
        [
          `Default station: ${station?.displayName ?? 'none'}`,
          `Preferred voice channel: ${s.preferredVoiceChannelId ? `<#${s.preferredVoiceChannelId}>${s.voiceLock ? ' (locked: the bot always plays there)' : ''}` : 'none'}`,
          `When the channel is empty: ${IDLE_LABEL[s.idleMode]}`,
          `Quality: ${s.qualityMode}${s.qualityMode === 'manual' ? (s.manualBitrateKbps !== null ? ` (${s.manualBitrateKbps} kbps)` : ' (no bitrate set yet, so it follows the station)') : ''}`,
          `Autostart: ${s.autostart ? 'on' : 'off'} · Resume after restart: ${s.resumeOnRestart ? 'on' : 'off'}`,
          ...(s.autostart && (!station || !s.preferredVoiceChannelId)
            ? [
                `⚠️ Autostart needs a default station and a preferred voice channel, and is missing ${[!station ? 'the default station' : null, !s.preferredVoiceChannelId ? 'the preferred voice channel' : null].filter(Boolean).join(' and ')}, so it does nothing yet.`,
              ]
            : []),
          ...(s.voiceLock && !s.preferredVoiceChannelId
            ? ['⚠️ Channel lock needs a preferred voice channel, so it does nothing yet.']
            : []),
          '-# The default station is what `/radio join` plays, and what autostart plays in the preferred voice channel when the bot starts.',
          '-# Set it with `/radio config default_station`, and a manual bitrate with `manual_bitrate`.',
        ].join('\n'),
        1024,
      ),
    },
    notify: {
      name: 'Notifications',
      value: truncate(
        [
          `Problem notices: ${s.notificationChannelId ? `<#${s.notificationChannelId}>` : 'off'}`,
          `Voice channel status: ${s.voiceChannelStatus ? 'on' : 'off'}`,
          '-# The voice channel status shows what is playing, under the channel’s name. It needs the bot’s optional Set Voice Channel Status permission; without it, nothing shows.',
        ].join('\n'),
        1024,
      ),
    },
  };
  const embed = new EmbedBuilder()
    .setTitle(`Radio Bot settings: ${PAGE_LABEL[page]}`)
    .setColor(COLOR.info)
    .setDescription(
      'Change a setting with the menus and buttons below. Changes save as soon as you make them.',
    )
    .addFields(fields[page]);
  const nav = row(
    ...(['access', 'playback', 'notify'] as ConfigPage[]).map((p) =>
      new ButtonBuilder()
        .setCustomId(id(`page-${p}`))
        .setLabel(PAGE_LABEL[p])
        .setStyle(p === page ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(p === page),
    ),
  );
  // Short option labels (a phone shows about 40 characters); the detail is in each description.
  const opt = (value: string, label: string, description: string, current: string) => ({
    value,
    label,
    description,
    default: value === current,
  });
  // A setting that is on is green, so the row reads at a glance.
  const toggle = (field: string, label: string, on: boolean) =>
    new ButtonBuilder()
      .setCustomId(id(field))
      .setLabel(`${label}: ${on ? 'on' : 'off'}`)
      .setStyle(on ? ButtonStyle.Success : ButtonStyle.Secondary);
  // Each page has at most four menus or rows of switches, then the page buttons last.
  const components: Row[] = [];
  if (page === 'access') {
    components.push(
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId(id('text'))
          .setPlaceholder('Channels for radio commands (none = all)')
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice)
          .setMinValues(0)
          .setMaxValues(25)
          .setDefaultChannels(s.allowedTextChannelIds.slice(0, 25)),
      ),
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId(id('voice'))
          .setPlaceholder('Voice channels to play in (none = all)')
          .setChannelTypes(ChannelType.GuildVoice)
          .setMinValues(0)
          .setMaxValues(25)
          .setDefaultChannels(s.allowedVoiceChannelIds.slice(0, 25)),
      ),
      row(
        new RoleSelectMenuBuilder()
          .setCustomId(id('djs'))
          .setPlaceholder('DJ roles (can always control the radio)')
          .setMinValues(0)
          .setMaxValues(25)
          .setDefaultRoles(s.djRoleIds.slice(0, 25)),
      ),
      row(
        new StringSelectMenuBuilder()
          .setCustomId(id('member'))
          .setPlaceholder('Who else can control the radio')
          .addOptions(
            opt('same_channel', 'Listeners in the bot’s channel', 'Plus DJs and admins', s.memberControlMode),
            opt('none', 'Only DJs and admins', 'Listeners can only listen', s.memberControlMode),
            opt('any', 'Anyone', 'Anyone who can use radio commands, from any channel', s.memberControlMode),
          ),
      ),
      nav,
    );
  } else if (page === 'playback') {
    components.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(id('idle'))
          .setPlaceholder('When the voice channel is empty')
          .addOptions(
            opt('leave_when_empty', 'Leave', 'Leave the voice channel when everyone has gone', s.idleMode),
            opt('pause_when_empty', 'Pause', 'Pause, and play again when someone joins', s.idleMode),
            opt('24x7', 'Keep playing (24/7)', 'Stay in the channel and keep playing', s.idleMode),
          ),
      ),
      row(
        new StringSelectMenuBuilder()
          .setCustomId(id('quality'))
          .setPlaceholder('Audio quality')
          .addOptions(
            opt('maximum', 'Maximum', 'Match the station’s own bitrate, up to the limit', s.qualityMode),
            opt('balanced', 'Balanced', 'Up to 128 kbps', s.qualityMode),
            opt('manual', 'Manual', 'A fixed bitrate, set with /radio config manual_bitrate', s.qualityMode),
          ),
      ),
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId(id('pvoice'))
          .setPlaceholder('Preferred voice channel')
          .setChannelTypes(ChannelType.GuildVoice)
          .setMinValues(0)
          .setMaxValues(1)
          .setDefaultChannels(s.preferredVoiceChannelId ? [s.preferredVoiceChannelId] : []),
      ),
      row(
        toggle('autostart', 'Autostart', s.autostart),
        toggle('resume', 'Resume after restart', s.resumeOnRestart),
        toggle('lock', 'Channel lock', s.voiceLock),
      ),
      nav,
    );
  } else {
    components.push(
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId(id('notify'))
          .setPlaceholder('Channel for problem notices (none = off)')
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(0)
          .setMaxValues(1)
          .setDefaultChannels(s.notificationChannelId ? [s.notificationChannelId] : []),
      ),
      row(toggle('vstatus', 'Voice channel status', s.voiceChannelStatus)),
      nav,
    );
  }
  return { embeds: [embed], components };
}
