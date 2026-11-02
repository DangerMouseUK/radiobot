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
import type { GuildSettings } from '../../persistence/repositories/guilds.ts';
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

const PAGE_SIZE = 25;

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
  const lines = groupedLines(ctx, slice, current);
  const filter = [
    state.pack ? `pack: ${groupName(ctx, state.pack)}` : null,
    state.category ? `category: ${state.category}` : null,
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
          : state.category === 'favourites'
            ? 'No favourites yet. Press Favourite under a playing station to add one.'
            : 'No stations match.',
        4000,
      ),
    )
    .setFooter({
      text: `Page ${p + 1}/${pages}${filter ? ` · ${filter}` : ''} · ${all.length} ${all.length === 1 ? 'station' : 'stations'}. ${DISCLAIMER}`,
    });
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
  const favourites = ctx.guilds.listFavourites(guildId).length;
  const onlyFavourites = state.category === 'favourites';
  components.push(
    row(
      new ButtonBuilder()
        .setCustomId(ctx.ids.make(guildId, 'browse', `${token}:p${p - 1}`))
        .setLabel('Previous page')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(p === 0),
      new ButtonBuilder()
        .setCustomId(ctx.ids.make(guildId, 'browse', `${token}:p${p + 1}`))
        .setLabel('Next page')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(p >= pages - 1),
      new ButtonBuilder()
        .setCustomId(ctx.ids.make(guildId, 'bfav', token))
        .setLabel(
          onlyFavourites
            ? 'All stations'
            : favourites
              ? `Favourites (${favourites})`
              : 'Favourites (none yet)',
        )
        .setStyle(onlyFavourites ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(!onlyFavourites && favourites === 0),
    ),
  );
  return { embeds: [embed], components };
}

/** Station picker used when a typed name is ambiguous — never guesses (FR-001). */
/**
 * Disambiguation for a station name. Only `/radio play` gets a picker (which plays, in the
 * channel it named); other commands list the matches and ask for the exact name.
 */
export function ambiguityView(
  ctx: AppContext,
  guildId: string,
  query: string,
  candidates: Station[],
  play: { channelId: string | null } | null,
): View {
  const list = candidates
    .map((s) => `• ${s.displayName} — ${availabilityBadge(ctx.sources.availability(s))}`)
    .join('\n');
  const ask = play
    ? 'Pick one below.'
    : 'Run the command again and choose the station from the suggestions as you type.';
  const embed = new EmbedBuilder()
    .setColor(COLOR.warn)
    .setTitle('Which station did you mean?')
    .setDescription(truncate(`"${query}" matches several stations. ${ask}\n\n${list}`, 4000));
  if (!play) return { embeds: [embed], components: [] };
  const select = new StringSelectMenuBuilder()
    .setCustomId(ctx.ids.make(guildId, 'pick', play.channelId ?? ''))
    .setPlaceholder('Choose the exact station')
    .addOptions(candidates.slice(0, 25).map((s) => ({ label: truncate(s.displayName, 100), value: s.id })));
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
    const fav = ctx.guilds.listFavourites(guildId);
    list = fav.map((id) => all.find((s) => s.id === id)).filter((s): s is Station => Boolean(s));
  } else if (scope === 'custom') {
    list = all.filter((s) => s.provider === 'custom');
  } else {
    list = all.filter((s) => s.provider !== 'custom' && (!pack || s.provider === pack));
  }
  const per = 20;
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
            ? 'No favourites yet. Use the Favourite button under /radio now to add one.'
            : 'No stations.'),
        4000,
      ),
    );
  let footer = `Page ${p + 1}/${pages}`;
  if (scope === 'packs') {
    const cov = ctx.sources.coverage(list);
    footer += ` · ${cov.catalogued} stations · ${cov.withSources} with a known stream · ${cov.usable} with a working stream · ${cov.verifiedPlayable} verified and playable`;
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
  const nav = row(
    new ButtonBuilder()
      .setCustomId(ctx.ids.make(guildId, 'list', listArg(scope, pack, p - 1)))
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(p === 0),
    new ButtonBuilder()
      .setCustomId(ctx.ids.make(guildId, 'list', listArg(scope, pack, p + 1)))
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(p >= pages - 1),
  );
  return { embeds: [embed], components: pages > 1 ? [nav] : [] };
}

/** Now-playing controls. `persistent` buttons (control panel) do not expire but are re-authorised on click. */
export function controlRows(
  ctx: AppContext,
  guildId: string,
  stationId: string | null,
  persistent = false,
): Row[] {
  const ttl = persistent ? null : 15 * 60_000;
  const b = (action: ComponentAction, label: string, style: ButtonStyle, arg = '') =>
    new ButtonBuilder()
      .setCustomId(ctx.ids.make(guildId, action, arg, ttl))
      .setLabel(label)
      .setStyle(style);
  const rows: Row[] = [
    row(
      b('prev', 'Previous station', ButtonStyle.Secondary),
      b('next', 'Next station', ButtonStyle.Secondary),
      b('stop', 'Stop', ButtonStyle.Danger),
      b('leave', 'Leave', ButtonStyle.Secondary),
    ),
  ];
  const queued = ctx.guilds.listQueue(guildId).length;
  if (persistent || queued > 0) {
    rows[0]!.addComponents(
      b('skip', queued > 0 ? `Skip (${queued} queued)` : 'Skip (queue empty)', ButtonStyle.Primary),
    );
  }
  const second: ButtonBuilder[] = [
    b('obrowse', 'Browse stations', ButtonStyle.Success),
    b('now', 'Refresh', ButtonStyle.Primary),
  ];
  if (stationId) {
    const fav = ctx.guilds.isFavourite(guildId, stationId);
    second.push(
      b('fav', fav ? 'Unfavourite' : 'Favourite', ButtonStyle.Secondary, stationId),
      b('srcs', 'Sources', ButtonStyle.Secondary, stationId),
      b('insp', 'Inspect', ButtonStyle.Secondary, stationId),
    );
  }
  rows.push(row(...second.slice(0, 5)));
  return rows;
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
  const embed = new EmbedBuilder()
    .setTitle('Radio Bot settings')
    .setColor(COLOR.info)
    .setDescription(
      'Change a setting with the menus and buttons below; the pages switch between Access, Playback and Notifications. Set the default station and the manual bitrate with the `default_station` and `manual_bitrate` options of `/radio config` (choose "No default station" to clear the default).',
    )
    .addFields(
      {
        name: 'Access',
        value: truncate(
          [
            `Commands work in: ${fmtIds(s.allowedTextChannelIds, '#')}`,
            `Voice channels: ${fmtIds(s.allowedVoiceChannelIds, '#')}`,
            `DJ roles: ${s.djRoleIds.length ? fmtIds(s.djRoleIds, '@&') : 'none'}`,
            `Listeners can control: ${s.memberControlMode === 'same_channel' ? 'from the bot’s voice channel' : s.memberControlMode === 'any' ? 'from anywhere' : 'no (DJs and admins only)'}`,
            '-# Admins are the server owner and members with the Administrator permission.',
          ].join('\n'),
          1024,
        ),
      },
      {
        name: 'Playback',
        value: truncate(
          [
            `Default station: ${station?.displayName ?? 'none'}`,
            `Preferred voice channel: ${s.preferredVoiceChannelId ? `<#${s.preferredVoiceChannelId}>${s.voiceLock ? ' (locked)' : ''}` : 'none'}`,
            `When the channel is empty: ${IDLE_LABEL[s.idleMode]}`,
            `Quality: ${s.qualityMode}${s.qualityMode === 'manual' ? (s.manualBitrateKbps !== null ? ` (${s.manualBitrateKbps} kbps)` : ' (no bitrate set yet, so it follows the station)') : ''}`,
            `Autostart: ${s.autostart ? 'on' : 'off'} · Resume after restart: ${s.resumeOnRestart ? 'on' : 'off'}`,
            ...(s.autostart && (!station || !s.preferredVoiceChannelId)
              ? [
                  `⚠️ Autostart needs a default station and a preferred voice channel, and is missing ${[!station ? 'the default station' : null, !s.preferredVoiceChannelId ? 'the preferred voice channel' : null].filter(Boolean).join(' and ')}, so it does nothing yet.`,
                ]
              : []),
            '-# The default station is what `/radio join` plays, and what autostart plays in the preferred voice channel when the bot starts.',
          ].join('\n'),
          1024,
        ),
      },
      {
        name: 'Notifications',
        value: truncate(
          [
            `Problem notices: ${s.notificationChannelId ? `<#${s.notificationChannelId}>` : 'off'}`,
            `Voice channel status: ${s.voiceChannelStatus ? 'on' : 'off'}`,
          ].join('\n'),
          1024,
        ),
      },
    )
    .setFooter({ text: `Page: ${PAGE_LABEL[page]}` });
  const nav = row(
    ...(['access', 'playback', 'notify'] as ConfigPage[]).map((p) =>
      new ButtonBuilder()
        .setCustomId(id(`page-${p}`))
        .setLabel(PAGE_LABEL[p])
        .setStyle(p === page ? ButtonStyle.Primary : ButtonStyle.Secondary)
        .setDisabled(p === page),
    ),
  );
  const components: Row[] = [];
  if (page === 'access') {
    components.push(
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId(id('text'))
          .setPlaceholder('Channels where radio commands work (empty = all)')
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice)
          .setMinValues(0)
          .setMaxValues(25)
          .setDefaultChannels(s.allowedTextChannelIds.slice(0, 25)),
      ),
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId(id('voice'))
          .setPlaceholder('Voice channels the bot may play in (empty = all)')
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
      nav,
    );
  } else if (page === 'playback') {
    const opt = (value: string, label: string, current: string) => ({
      value,
      label,
      default: value === current,
    });
    components.push(
      row(
        new StringSelectMenuBuilder()
          .setCustomId(id('idle'))
          .setPlaceholder('What to do when the voice channel is empty')
          .addOptions(
            opt('leave_when_empty', 'Leave when the channel is empty', s.idleMode),
            opt('pause_when_empty', 'Pause when the channel is empty, resume when someone joins', s.idleMode),
            opt('24x7', '24/7: stay in the channel and keep playing', s.idleMode),
          ),
      ),
      row(
        new StringSelectMenuBuilder()
          .setCustomId(id('member'))
          .setPlaceholder('Who else can control the radio')
          .addOptions(
            opt(
              'same_channel',
              'Listeners in the bot’s voice channel, plus DJs and admins',
              s.memberControlMode,
            ),
            opt('none', 'Only DJs and admins', s.memberControlMode),
            opt('any', 'Anyone who can use radio commands', s.memberControlMode),
          ),
      ),
      row(
        new StringSelectMenuBuilder()
          .setCustomId(id('quality'))
          .setPlaceholder('Audio quality')
          .addOptions(
            opt('maximum', 'Maximum: match the station’s own bitrate, up to the limit', s.qualityMode),
            opt('balanced', 'Balanced: up to 128 kbps', s.qualityMode),
            opt('manual', 'Manual: a fixed bitrate, set with manual_bitrate', s.qualityMode),
          ),
      ),
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId(id('pvoice'))
          .setPlaceholder('Preferred voice channel (used by autostart and the lock)')
          .setChannelTypes(ChannelType.GuildVoice)
          .setMinValues(0)
          .setMaxValues(1)
          .setDefaultChannels(s.preferredVoiceChannelId ? [s.preferredVoiceChannelId] : []),
      ),
      row(
        new ButtonBuilder()
          .setCustomId(id('autostart'))
          .setLabel(`Autostart: ${s.autostart ? 'on' : 'off'}`)
          .setStyle(s.autostart ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(id('resume'))
          .setLabel(`Resume after restart: ${s.resumeOnRestart ? 'on' : 'off'}`)
          .setStyle(s.resumeOnRestart ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(id('lock'))
          .setLabel(`Lock to preferred channel: ${s.voiceLock ? 'on' : 'off'}`)
          .setStyle(s.voiceLock ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(id('page-access')).setLabel('Access').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId(id('page-notify'))
          .setLabel('Notifications')
          .setStyle(ButtonStyle.Secondary),
      ),
    );
  } else {
    components.push(
      row(
        new ChannelSelectMenuBuilder()
          .setCustomId(id('notify'))
          .setPlaceholder('Channel for problem and recovery notices (empty = off)')
          .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setMinValues(0)
          .setMaxValues(1)
          .setDefaultChannels(s.notificationChannelId ? [s.notificationChannelId] : []),
      ),
      row(
        new ButtonBuilder()
          .setCustomId(id('vstatus'))
          .setLabel(`Show what's playing as the voice channel status: ${s.voiceChannelStatus ? 'on' : 'off'}`)
          .setStyle(s.voiceChannelStatus ? ButtonStyle.Success : ButtonStyle.Secondary),
      ),
      nav,
    );
  }
  return { embeds: [embed], components };
}
