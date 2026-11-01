import { randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  ActionRowBuilder,
  AttachmentBuilder,
  type AutocompleteInteraction,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  embedLength,
  type Guild,
  type Interaction,
  type InteractionEditReplyOptions,
  type MessageActionRowComponentBuilder,
  type MessageComponentInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { resolveStation, searchStations } from '../catalogue/search.ts';
import { AVAILABILITY_LABEL, type IdentityStatus, type Station } from '../catalogue/types.ts';
import {
  applyImport,
  exportGuild,
  type GuildExport,
  parseImport,
  previewImport,
} from '../import-export/config-io.ts';
import { type LatencySummary, regionHint, tcpPing } from '../observability/netstats.ts';
import type { DesiredState, GuildSettings, SettingsPatch } from '../persistence/repositories/guilds.ts';
import { errorCode, isRadioError, RadioError } from '../shared/errors.ts';
import { truncate } from '../shared/text.ts';
import { codecLabel } from '../streams/probe.ts';
import { CONCLUSION_TEXT } from '../streams/ranking.ts';
import { STATE_LABEL } from '../voice/state-machine.ts';
import {
  type AppContext,
  authContext,
  chooseVoiceChannel,
  groupName,
  isOperator,
  lockConflict,
  visibleStation,
  visibleStations,
} from './context.ts';
import { type AuthResult, authorize, type Capability } from './permissions/authorize.ts';
import {
  COLOR,
  DISCLAIMER,
  errorEmbed,
  infoEmbed,
  loopDelayLine,
  nowEmbed,
  qualityEmbed,
  sourceFormat,
  sourcesEmbed,
  stationLine,
  transportLabel,
} from './ui/format.ts';
import {
  ambiguityView,
  type BrowseState,
  browseView,
  type ConfigPage,
  configView,
  controlRows,
  type ListScope,
  listView,
  parseListArg,
  type View,
} from './ui/views.ts';

/** Identity status as a word for autocomplete and rescan summaries. */
const IDENTITY_WORD: Record<IdentityStatus, string> = {
  verified: 'verified',
  unverified: 'unverified',
  mismatch: 'wrong station',
};

/** What the server has asked the radio to do, for /radio status. */
const DESIRED_LABEL: Record<DesiredState, string> = {
  idle: 'nothing',
  playing: 'play',
  paused_empty: 'play (paused while the channel is empty)',
  stopped: 'stay stopped',
  left: 'stay out of voice',
  kicked: 'stay out of voice (a moderator disconnected it)',
};

type Cmd = ChatInputCommandInteraction<'cached'>;
type Comp = MessageComponentInteraction<'cached'>;
const EPHEMERAL = MessageFlags.Ephemeral;

interface PendingImport {
  guildId: string;
  userId: string;
  data: GuildExport;
  expires: number;
}

/** Handles every /radio interaction. All checks run server-side on every call. */
export class RadioController {
  readonly #ctx: AppContext;
  readonly #browse = new Map<string, BrowseState & { expires: number }>();
  readonly #imports = new Map<string, PendingImport>();

  constructor(ctx: AppContext) {
    this.#ctx = ctx;
  }

  // ------------------------------------------------------------------ entry points

  async handle(i: Interaction): Promise<void> {
    if (!i.inCachedGuild()) {
      if (i.isRepliable())
        await i.reply({ content: 'Radio Bot only works inside servers.', flags: EPHEMERAL }).catch(() => {});
      return;
    }
    try {
      if (i.isAutocomplete()) await this.#autocomplete(i);
      else if (i.isChatInputCommand() && i.commandName === 'radio') await this.#command(i);
      else if (i.isMessageComponent()) await this.#component(i);
    } catch (err) {
      await this.#fail(i, err);
    }
  }

  async #fail(i: Interaction<'cached'>, err: unknown): Promise<void> {
    const message = isRadioError(err)
      ? err.userMessage
      : 'Something went wrong. The details were logged for the person who runs this bot.';
    if (!isRadioError(err) || err.code === 'INTERNAL') {
      this.#ctx.logger.error({ err, guildId: i.guildId, type: i.type }, 'interaction failed');
      this.#ctx.metrics.incident(i.guildId, 'INTERNAL', 'bot', 'interaction failed');
    }
    if (!i.isRepliable()) return;
    const payload = { embeds: [errorEmbed(message)], components: [] };
    try {
      if (i.deferred || i.replied) await i.editReply(payload);
      else await i.reply({ ...payload, flags: EPHEMERAL });
    } catch {
      /* interaction expired */
    }
  }

  #auth(i: Cmd | Comp, cap: Capability, target: string | null = null): AuthResult {
    return authorize(authContext(this.#ctx, i), this.#ctx.guilds.getSettings(i.guildId), cap, target);
  }

  async #deny(i: Cmd | Comp, reason: string): Promise<void> {
    await i.reply({ embeds: [errorEmbed(reason)], flags: EPHEMERAL });
  }

  #rate(limiter: { take(k: string): number }, key: string, what: string): void {
    const wait = limiter.take(key);
    if (wait > 0)
      throw new RadioError(
        'RATE_LIMITED',
        `Too many ${what} in a short time. Try again in ${Math.ceil(wait / 1000)} s.`,
      );
  }

  #station(guildId: string, query: string): Station {
    const direct = visibleStation(this.#ctx, guildId, query);
    if (direct) return direct;
    const r = resolveStation(visibleStations(this.#ctx, guildId), query);
    if (r.kind === 'match') return r.station;
    if (r.kind === 'ambiguous') throw new AmbiguousStation(query, r.candidates);
    throw new RadioError(
      'URL_INVALID',
      `No station matches "${truncate(query, 60)}". Use /radio browse to see them all.`,
    );
  }

  // ------------------------------------------------------------------ autocomplete

  async #autocomplete(i: AutocompleteInteraction<'cached'>): Promise<void> {
    const focused = i.options.getFocused(true);
    const q = String(focused.value ?? '');
    const sub = i.options.getSubcommand(false);
    if (focused.name === 'source') {
      const stationQ = i.options.getString('station') ?? '';
      let st: Station | null = null;
      try {
        st = this.#station(i.guildId, stationQ);
      } catch {
        st = null;
      }
      const sources = st ? this.#ctx.sources.sourcesFor(st.id) : [];
      await i.respond(
        sources
          .filter(
            (s) =>
              !q || s.id.includes(q.toLowerCase()) || (s.label ?? '').toLowerCase().includes(q.toLowerCase()),
          )
          .slice(0, 25)
          .map((s) => ({
            name: truncate(`${s.label ?? 'Source'} · ${s.id} · ${IDENTITY_WORD[s.identityStatus]}`, 100),
            value: s.id,
          })),
      );
      return;
    }
    if (focused.name === 'pack') {
      const packs = this.#ctx.packs
        .enabledPacks()
        .filter((p) => sub !== 'sync' || p.meta.sync !== null)
        .filter((p) => !q || `${p.meta.id} ${p.meta.name}`.toLowerCase().includes(q.toLowerCase()));
      const options = packs.map((p) => ({
        name: truncate(`${p.meta.name} (${p.stations.length} stations)`, 100),
        value: p.meta.id,
      }));
      if (sub !== 'sync' && (!q || 'custom'.includes(q.toLowerCase()))) {
        options.push({ name: 'Custom stations (this server)', value: 'custom' });
      }
      await i.respond(options.slice(0, 25));
      return;
    }
    if (focused.name === 'category') {
      const pack = i.options.getString('pack');
      const cats = [
        ...this.#ctx.packs
          .categories()
          .filter((c) => !pack || c.packId === pack)
          .map((c) => ({ name: `${c.name} — ${groupName(this.#ctx, c.packId)}`, value: c.id })),
        { name: 'Favourites', value: 'favourites' },
        { name: 'Custom (this server)', value: 'custom' },
      ];
      const seen = new Set<string>();
      await i.respond(
        cats
          .filter((c) => !q || c.name.toLowerCase().includes(q.toLowerCase()))
          .filter((c) => {
            if (seen.has(c.value)) return false;
            seen.add(c.value);
            return true;
          })
          .slice(0, 25)
          .map((c) => ({ name: truncate(c.name, 100), value: c.value })),
      );
      return;
    }
    let stations = visibleStations(this.#ctx, i.guildId);
    if (sub === 'edit' || sub === 'remove') stations = stations.filter((s) => s.provider === 'custom');
    const hits = q
      ? searchStations(stations, q, 25).map((h) => h.station)
      : this.#defaultSuggestions(i.guildId, stations);
    await i.respond(
      hits.slice(0, 25).map((s) => ({
        name: truncate(
          `${s.displayName}${s.provider === 'custom' ? ' (custom)' : ''} — ${AVAILABILITY_LABEL[this.#ctx.sources.availability(s)].toLowerCase()}`,
          100,
        ),
        value: s.id,
      })),
    );
  }

  #defaultSuggestions(guildId: string, stations: Station[]): Station[] {
    const fav = this.#ctx.guilds.listFavourites(guildId);
    const favStations = fav
      .map((id) => stations.find((s) => s.id === id))
      .filter((s): s is Station => Boolean(s));
    return [...favStations, ...stations.filter((s) => !fav.includes(s.id))].slice(0, 25);
  }

  // ------------------------------------------------------------------ slash commands

  async #command(i: Cmd): Promise<void> {
    const group = i.options.getSubcommandGroup(false);
    const sub = i.options.getSubcommand();
    try {
      if (group === 'source') return await this.#sourceGroup(i, sub);
      if (group === 'queue') return await this.#queueGroup(i, sub);
      switch (sub) {
        case 'browse':
          return await this.#cmdBrowse(i);
        case 'play':
          return await this.#cmdPlay(i);
        case 'stop':
          return await this.#cmdStop(i);
        case 'join':
          return await this.#cmdJoin(i);
        case 'leave':
          return await this.#cmdLeave(i);
        case 'now':
          return await this.#cmdNow(i);
        case 'list':
          return await this.#cmdList(i);
        case 'inspect':
          return await this.#cmdSources(i, true);
        case 'sources':
          return await this.#cmdSources(i, false);
        case 'quality':
          return await this.#cmdQuality(i);
        case 'status':
          return await this.#cmdStatus(i);
        case 'stats':
          return await this.#cmdStats(i);
        case 'skip':
          return await this.#cmdSkip(i);
        case 'add':
          return await this.#cmdAdd(i);
        case 'edit':
          return await this.#cmdEdit(i);
        case 'remove':
          return await this.#cmdRemove(i);
        case 'rescan':
          return await this.#cmdRescan(i);
        case 'sync':
          return await this.#cmdSync(i);
        case 'config':
          return await this.#cmdConfig(i);
        case 'export':
          return await this.#cmdExport(i);
        case 'import':
          return await this.#cmdImport(i);
        case 'panel':
          return await this.#cmdPanel(i);
        case 'help':
          return await this.#cmdHelp(i);
        default:
          await this.#deny(i, 'That command is not recognised.');
      }
    } catch (err) {
      if (err instanceof AmbiguousStation) {
        const play =
          !group && sub === 'play' ? { channelId: i.options.getChannel('channel')?.id ?? null } : null;
        const v = ambiguityView(this.#ctx, i.guildId, err.query, err.candidates, play);
        if (i.deferred || i.replied) await i.editReply(v);
        else await i.reply({ ...v, flags: EPHEMERAL });
        return;
      }
      throw err;
    }
  }

  async #replyView(i: Cmd, cap: Capability, view: View): Promise<void> {
    const a = this.#auth(i, cap);
    if (!a.ok) return this.#deny(i, a.reason);
    await i.reply({ ...view, flags: EPHEMERAL });
  }

  async #cmdBrowse(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'read');
    if (!a.ok) return this.#deny(i, a.reason);
    const token = randomBytes(6).toString('base64url');
    const state: BrowseState = {
      pack: i.options.getString('pack'),
      category: i.options.getString('category'),
      search: i.options.getString('search'),
    };
    this.#browse.set(token, { ...state, expires: Date.now() + 15 * 60_000 });
    this.#sweep();
    await i.reply({ ...browseView(this.#ctx, i.guildId, state, token, 0), flags: EPHEMERAL });
  }

  /** Shared play path for /radio play, buttons and select menus. */
  async #play(
    i: Cmd | Comp,
    station: Station,
    explicitChannel: string | null,
    respond: (o: InteractionEditReplyOptions) => Promise<unknown>,
    defer: () => Promise<unknown>,
  ): Promise<void> {
    const ctx = this.#ctx;
    const settings = ctx.guilds.getSettings(i.guildId);
    const auth = authContext(ctx, i);
    const target = chooseVoiceChannel(ctx, i.guildId, settings, explicitChannel, auth.userVoiceChannelId);
    const a = authorize(auth, settings, 'control', target);
    if (!a.ok) return this.#deny(i, a.reason);
    if (!target)
      return this.#deny(i, 'Join a voice channel first, or ask an admin to set a preferred voice channel.');
    const locked = lockConflict(settings, explicitChannel, target);
    if (locked) return this.#deny(i, locked);
    const availability = ctx.sources.availability(station);
    if (availability === 'retired')
      return this.#deny(i, `${station.displayName} is no longer in the catalogue, so it can’t be played.`);
    if (availability === 'no_source') {
      return this.#deny(
        i,
        `${station.displayName} is listed, but no stream is known for it yet, so it can’t be played. Nothing else was played in its place.`,
      );
    }
    this.#rate(ctx.limits.playUser, i.user.id, 'station changes');
    this.#rate(ctx.limits.playGuild, i.guildId, 'station changes');
    await defer();
    const switching = ctx.sessions.get(i.guildId)?.connected;
    await respond({
      embeds: [
        infoEmbed(
          switching ? 'Switching…' : 'Joining…',
          `${switching ? 'Switching to' : `Joining <#${target}> for`} **${station.displayName}**…`,
          COLOR.neutral,
        ),
      ],
      components: [],
    });
    const result = await ctx.sessions.play(i.guildId, station.id, target, i.user.id);
    if (result.code === 'CANCELLED') {
      await respond({
        embeds: [
          infoEmbed('Request replaced', 'A newer station request took over from this one.', COLOR.neutral),
        ],
        components: [],
      });
      return;
    }
    if (result.retrying) {
      // The first attempt failed, but recovery is already running in the background.
      await respond({
        embeds: [
          infoEmbed(
            `Starting ${station.displayName}`,
            `${result.message}\nCheck progress with /radio now.`,
            COLOR.warn,
          ),
        ],
        components: [],
      });
      return;
    }
    const session = ctx.sessions.get(i.guildId);
    const status = session?.status() ?? null;
    if (!result.ok) {
      const reasons = result.selection?.eligibility
        .filter((e) => !e.eligible)
        .slice(0, 4)
        .map((e) => `• \`${e.sourceId}\`: ${e.reasons.join('; ')}`)
        .join('\n');
      await respond({
        embeds: [
          errorEmbed(
            `${result.message}${reasons ? `\n\n**Why each source was skipped:**\n${reasons}` : ''}${
              result.code === 'NO_ELIGIBLE_SOURCE'
                ? '\n\nI will try again automatically in a couple of minutes.'
                : ''
            }`,
          ),
        ],
        components: [],
      });
      return;
    }
    const embed = nowEmbed(station, status, target);
    if (result.selection) {
      embed.addFields({
        name: 'Why this source',
        value: truncate(
          [CONCLUSION_TEXT[result.selection.conclusion], ...result.selection.explanation].join('\n'),
          1024,
        ),
      });
    }
    await respond({
      embeds: [this.#withQueue(embed, i.guildId)],
      components: controlRows(ctx, i.guildId, station.id),
    });
    await this.refreshPanel(i.guildId);
  }

  async #cmdPlay(i: Cmd): Promise<void> {
    const station = this.#station(i.guildId, i.options.getString('station', true));
    const channel = i.options.getChannel('channel');
    await this.#play(
      i,
      station,
      channel?.id ?? null,
      (o) => i.editReply(o),
      () => i.deferReply(),
    );
  }

  async #cmdStop(i: Cmd | Comp): Promise<void> {
    const a = this.#auth(i, 'control');
    if (!a.ok) return this.#deny(i, a.reason);
    const s = this.#ctx.sessions.get(i.guildId);
    if (!s) {
      this.#ctx.guilds.setIntent(i.guildId, { desiredState: 'stopped' });
      await i.reply({
        embeds: [infoEmbed('Stopped', 'Nothing was playing.', COLOR.neutral)],
        flags: EPHEMERAL,
      });
      return;
    }
    s.stop();
    await i.reply({
      embeds: [
        infoEmbed(
          'Stopped',
          `<@${i.user.id}> stopped the radio. It won’t start again by itself until someone uses /radio play.`,
          COLOR.neutral,
        ),
      ],
      allowedMentions: { parse: [] },
    });
    await this.refreshPanel(i.guildId);
  }

  async #cmdLeave(i: Cmd | Comp): Promise<void> {
    const a = this.#auth(i, 'control');
    if (!a.ok) return this.#deny(i, a.reason);
    const s = this.#ctx.sessions.get(i.guildId);
    if (s) s.leave('left');
    else this.#ctx.guilds.setIntent(i.guildId, { desiredState: 'left' });
    await i.reply({
      embeds: [
        infoEmbed(
          'Left',
          `<@${i.user.id}> disconnected the radio. I won’t rejoin until someone uses /radio play.`,
          COLOR.neutral,
        ),
      ],
      allowedMentions: { parse: [] },
    });
    await this.refreshPanel(i.guildId);
  }

  async #cmdJoin(i: Cmd): Promise<void> {
    const settings = this.#ctx.guilds.getSettings(i.guildId);
    const auth = authContext(this.#ctx, i);
    const explicit = i.options.getChannel('channel')?.id ?? null;
    const target = chooseVoiceChannel(this.#ctx, i.guildId, settings, explicit, auth.userVoiceChannelId);
    const a = authorize(auth, settings, 'control', target);
    if (!a.ok) return this.#deny(i, a.reason);
    if (!target) return this.#deny(i, 'Join a voice channel first, or pick one with the channel option.');
    const locked = lockConflict(settings, explicit, target);
    if (locked) return this.#deny(i, locked);
    const session = this.#ctx.sessions.get(i.guildId);
    if (session?.connected && session.channelId === target) {
      await i.reply({
        embeds: [infoEmbed('Already here', `Radio Bot is already in <#${target}>.`)],
        flags: EPHEMERAL,
      });
      return;
    }
    this.#rate(this.#ctx.limits.playUser, i.user.id, 'join requests');
    this.#rate(this.#ctx.limits.playGuild, i.guildId, 'join requests');
    const def = settings.defaultStationId
      ? visibleStation(this.#ctx, i.guildId, settings.defaultStationId)
      : null;
    if (def) {
      await this.#play(
        i,
        def,
        explicit,
        (o) => i.editReply(o),
        () => i.deferReply(),
      );
      return;
    }
    await i.deferReply();
    await this.#ctx.sessions.ensure(i.guildId).join(target);
    await i.editReply({
      embeds: [
        infoEmbed(
          'Joined',
          `Joined <#${target}>. There is no default station, so pick one with /radio play or /radio browse.`,
        ),
      ],
    });
  }

  async #cmdNow(i: Cmd | Comp, update = false): Promise<void> {
    const a = this.#auth(i, 'read');
    if (!a.ok) return this.#deny(i, a.reason);
    const s = this.#ctx.sessions.get(i.guildId);
    const status = s?.status() ?? null;
    const st = status?.stationId ? this.#ctx.stations.getStation(status.stationId) : null;
    const view = {
      embeds: [this.#withQueue(nowEmbed(st, status, status?.channelId ?? null), i.guildId)],
      components: controlRows(this.#ctx, i.guildId, st?.id ?? null),
    };
    if (update && i.isMessageComponent()) await i.update(view);
    else await i.reply({ ...view, flags: EPHEMERAL });
  }

  async #cmdList(i: Cmd): Promise<void> {
    const pack = i.options.getString('pack');
    const requested = i.options.getString('scope') as ListScope | null;
    const scope: ListScope = pack === 'custom' ? 'custom' : (requested ?? 'packs');
    const page = (i.options.getInteger('page') ?? 1) - 1;
    await this.#replyView(
      i,
      'read',
      listView(this.#ctx, i.guildId, scope, pack === 'custom' ? null : pack, page),
    );
  }

  async #cmdSources(i: Cmd, detailed: boolean): Promise<void> {
    const a = this.#auth(i, 'read');
    if (!a.ok) return this.#deny(i, a.reason);
    const st = this.#station(i.guildId, i.options.getString('station', true));
    await i.reply({ ...this.#sourcesView(i.guildId, st, detailed, a.level === 'admin'), flags: EPHEMERAL });
  }

  #sourcesView(guildId: string, st: Station, detailed: boolean, admin: boolean): View {
    const sources = this.#ctx.sources.sourcesFor(st.id);
    const selection = this.#ctx.sources.select(guildId, st.id);
    const embed = sourcesEmbed(st, sources, selection, detailed);
    const pref = this.#ctx.guilds.getPreference(guildId, st.id);
    if (pref)
      embed.addFields({ name: 'Server override', value: `${pref.mode} → \`${pref.sourceId ?? 'none'}\`` });
    const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
    if (admin && sources.length > 0) {
      components.push(
        new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(this.#ctx.ids.make(guildId, 'rescan', st.id))
            .setLabel('Check sources again')
            .setStyle(ButtonStyle.Primary),
        ),
      );
    }
    return { embeds: [embed], components };
  }

  async #cmdQuality(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'read');
    if (!a.ok) return this.#deny(i, a.reason);
    const status = this.#ctx.sessions.get(i.guildId)?.status() ?? null;
    const st = status?.stationId ? this.#ctx.stations.getStation(status.stationId) : null;
    await i.reply({ embeds: [qualityEmbed(st, status)], flags: EPHEMERAL });
  }

  async #cmdStatus(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'read');
    if (!a.ok) return this.#deny(i, a.reason);
    const s = this.#ctx.sessions.get(i.guildId);
    const status = s?.status() ?? null;
    const intent = this.#ctx.guilds.getIntent(i.guildId);
    const desired = intent?.desiredStationId ? this.#ctx.stations.getStation(intent.desiredStationId) : null;
    const lines = [
      `**Connection:** ${status ? STATE_LABEL[status.state] : 'Idle'}${status?.channelId ? ` in <#${status.channelId}>` : ''}`,
      `**Set to:** ${DESIRED_LABEL[intent?.desiredState ?? 'idle']}${desired ? ` — ${desired.displayName}` : ''}`,
    ];
    if (status?.source) lines.push(`**Source:** ${sourceFormat(status.source)}`);
    if (status?.lastError) lines.push(`**Last problem:** ${status.lastError.message}`);
    if (intent?.lastErrorCode === 'RESUME_DISABLED')
      lines.push('Playback was not resumed after the last restart because "resume after restart" is off.');
    await i.reply({ embeds: [infoEmbed('Radio status', lines.join('\n'))], flags: EPHEMERAL });
  }

  /** Admin-only, private (ephemeral) live statistics with Refresh and Close buttons. */
  async #cmdStats(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    await i.deferReply({ flags: EPHEMERAL });
    await i.editReply(await this.#statsView(i.guildId));
  }

  async #statsView(guildId: string): Promise<View> {
    const ctx = this.#ctx;
    const session = ctx.sessions.get(guildId);
    const status = session?.status() ?? null;
    const live = session?.liveStats() ?? null;
    const st = status?.stationId ? ctx.stations.getStation(status.stationId) : null;
    const kbps = (v: number | null | undefined) =>
      v === null || v === undefined ? '—' : `${Math.round(v)} kbps`;
    const lat = (l: LatencySummary | null) =>
      l
        ? `${l.lastMs} ms (avg ${l.avgMs}, min ${l.minMs}, max ${l.maxMs}, jitter ${l.jitterMs ?? '—'} ms, ${l.samples} samples)`
        : 'not measured yet';
    const where = (host: string | null | undefined) => {
      const hint = regionHint(host);
      return hint ? ` (${hint}, from host name)` : '';
    };

    // Stream endpoint round trip: TCP handshakes to the exact IP the audio comes from.
    let streamRtt: LatencySummary | null = null;
    if (live?.input?.remoteAddress && live.input.remotePort) {
      try {
        ctx.policy.assertAddressAllowed(live.input.remoteAddress);
        streamRtt = await tcpPing(live.input.remoteAddress.replace(/^::ffff:/, ''), live.input.remotePort, 5);
      } catch {
        streamRtt = null;
      }
    }
    // Discord voice server: endpoint host, its address, and the channel's region setting.
    const endpointHost = live?.voice?.endpoint?.replace(/:\d+$/, '') ?? null;
    let endpointIp: string | null = null;
    if (endpointHost) endpointIp = (await dnsLookup(endpointHost).catch(() => null))?.address ?? null;
    const channel = status?.channelId ? ctx.client.channels.cache.get(status.channelId) : null;
    const rtcRegion = channel && 'rtcRegion' in channel ? (channel.rtcRegion ?? 'automatic') : 'unknown';

    const liveEmbed = new EmbedBuilder()
      .setTitle(st ? `Live stats: ${st.displayName}` : 'Live stats')
      .setColor(status?.state === 'PLAYING' ? COLOR.ok : COLOR.neutral)
      .setTimestamp(new Date());
    if (!status || !live?.input) {
      liveEmbed.setDescription(
        status
          ? `State: ${STATE_LABEL[status.state]}. No stream is running, so there are no live figures yet.`
          : 'Nothing is playing in this server.',
      );
    } else {
      const inp = live.input;
      const out = live.output;
      const src = status.source;
      liveEmbed.setDescription(
        `**State:** ${STATE_LABEL[status.state]} · source \`${src?.id ?? '—'}\`${src?.label ? ` (${src.label})` : ''}` +
          (live.connectedSince ? ` · voice connected <t:${Math.floor(live.connectedSince / 1000)}:R>` : ''),
      );
      liveEmbed.addFields(
        {
          name: 'Stream input',
          value: truncate(
            [
              `Requested: \`${inp.requestedHost}\`${inp.redirects.length ? ` → redirected to \`${inp.finalHost}\`` : ''}${where(inp.finalHost)}`,
              `Connected to: \`${inp.remoteAddress ?? 'unknown'}${inp.remotePort ? `:${inp.remotePort}` : ''}\``,
              inp.transport === 'hls'
                ? `HLS segments: ${inp.segmentsFetched} fetched, ${inp.segmentFailures} failed, ${inp.skippedSegments} skipped · last from \`${inp.segmentHost ?? '—'}\`${where(inp.segmentHost)}`
                : 'Transport: direct HTTP stream',
              `Codec: ${src ? sourceFormat(src) : 'unknown'}`,
              `Live input rate: ${kbps(inp.kbps10s)} (10 s) · ${kbps(inp.kbps60s)} (60 s) · ${(inp.bytes / 1048576).toFixed(1)} MB received`,
              `Endpoint round trip (TCP): ${lat(streamRtt)}`,
            ].join('\n'),
            1024,
          ),
        },
        {
          name: 'Output to Discord',
          value: truncate(
            [
              `Opus target: ${out ? `${out.targetKbps} kbps (${status.plan?.qualityMode ?? '—'})` : '—'} · voice channel setting ${kbps(out?.channelBitrateKbps)} (not a cap)`,
              `Sent to Discord: ${kbps(out?.kbps10s)} (10 s) · ${kbps(out?.kbps60s)} (60 s) · Ogg Opus pulled by the voice player`,
              `Packets to Discord: ${live.voice?.packetsPerSecond ?? '—'} per second (expect ~50) · ${live.voice?.packetsPlayed ?? '—'} sent on this connection`,
            ].join('\n'),
            1024,
          ),
        },
        {
          name: 'Discord connection',
          value: truncate(
            [
              `Voice server: \`${endpointHost ?? 'unknown'}\`${where(endpointHost)}${endpointIp ? ` · \`${endpointIp}\`` : ''} · channel region: ${rtcRegion}`,
              `Voice WebSocket ping: ${lat(live.voice?.ws ?? null)}`,
              `Gateway ping: ${ctx.client.ws.ping >= 0 ? `${ctx.client.ws.ping} ms` : 'not measured yet'}`,
              `Encryption: ${live.voice?.encryption ?? '—'}${live.voice?.encryptionMode ? ` · ${live.voice.encryptionMode}` : ''}`,
              `Source failovers: ${status.failovers} · voice reconnects: ${status.reconnects} · encoder PID: ${status.encoderPid ?? '—'}`,
            ].join('\n'),
            1024,
          ),
        },
      );
      if (status.ffmpegWarnings.length) {
        liveEmbed.addFields({
          name: 'FFmpeg warnings',
          value: truncate(status.ffmpegWarnings.slice(-3).join('\n'), 1024),
        });
      }
    }

    const mem = process.memoryUsage();
    const visible = visibleStations(ctx, guildId);
    const packLines = ctx.packs.packs.map((p) => {
      if (!ctx.packs.isEnabled(p.meta.id)) return `**${p.meta.name}** (\`${p.meta.id}\`): disabled`;
      const cov = ctx.sources.coverage(visible.filter((x) => x.provider === p.meta.id));
      const sync = p.meta.sync ? ctx.stations.lastSyncReport(p.meta.id) : null;
      const syncText = !p.meta.sync
        ? 'no official list'
        : sync
          ? `list synced ${sync.finishedAt.slice(0, 16).replace('T', ' ')} UTC ${sync.success ? '(ok)' : '(failed)'}`
          : 'list never synced';
      return `**${p.meta.name}** (\`${p.meta.id}\`): ${cov.catalogued} stations · ${cov.usable} with a working stream · ${cov.verifiedPlayable} verified and playable · ${syncText}`;
    });
    const incidents = ctx.metrics.recentIncidents(guildId, 6);
    const healthEmbed = new EmbedBuilder()
      .setTitle('Bot health')
      .setColor(COLOR.info)
      .addFields(
        {
          name: 'Process',
          value: [
            `Uptime: ${Math.round(process.uptime() / 60)} min · memory: RSS ${Math.round(mem.rss / 1048576)} MB, heap ${Math.round(mem.heapUsed / 1048576)} MB`,
            `Active streams: ${ctx.sessions.activeStreams()}/${ctx.config.maxActiveGuildStreams} · stream checks running: ${ctx.sources.activeProbes}/${ctx.config.maxConcurrentProbes}`,
            `FFmpeg processes: ${ctx.registry.active} running, ${ctx.registry.spawned} started, ${ctx.registry.reaped} cleaned up · libopus: ${ctx.ffmpegInfo?.libopus ? 'yes' : 'missing'}`,
            loopDelayLine(ctx.eventLoop.lastWindow() ?? ctx.eventLoop.current()),
            `Stream User-Agent: \`${ctx.http.userAgent}\` · database schema v${ctx.db.schemaVersion()}`,
          ].join('\n'),
        },
        {
          name: 'Station packs',
          value: truncate(packLines.join('\n') || 'No station packs are loaded.', 1024),
        },
        {
          name: 'Recent problems (repeats grouped)',
          value: truncate(
            incidents.length
              ? incidents
                  .map((x) => `\`${x.at.slice(11, 19)}\` ${x.code} [${x.domain}] ×${x.count}: ${x.detail}`)
                  .join('\n')
              : 'None.',
            1024,
          ),
        },
      )
      .setFooter({
        text: 'Only you can see this. Secrets and URL query strings are hidden. Radio Bot sends no telemetry.',
      });
    const buttons = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(ctx.ids.make(guildId, 'stats', '', 30 * 60_000))
        .setLabel('Refresh')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(ctx.ids.make(guildId, 'close', '', 30 * 60_000))
        .setLabel('Close')
        .setStyle(ButtonStyle.Secondary),
    );
    return { embeds: [liveEmbed, healthEmbed], components: [buttons] };
  }

  // ------------------------------------------------------------------ queue

  /** Adds "Up next" to a now-playing style embed when the queue is not empty. */
  #withQueue(embed: EmbedBuilder, guildId: string): EmbedBuilder {
    const q = this.#ctx.guilds.listQueue(guildId);
    if (q.length === 0) return embed;
    const names = q
      .slice(0, 5)
      .map((e, n) => `${n + 1}. ${this.#ctx.stations.getStation(e.stationId)?.displayName ?? e.stationId}`);
    return embed.addFields({
      name: `Up next (${q.length} in the queue)`,
      value: truncate(names.join('\n') + (q.length > 5 ? `\n…and ${q.length - 5} more` : ''), 1024),
    });
  }

  async #queueGroup(i: Cmd, sub: string): Promise<void> {
    const ctx = this.#ctx;
    if (sub === 'list') {
      const a = this.#auth(i, 'read');
      if (!a.ok) return this.#deny(i, a.reason);
      const q = ctx.guilds.listQueue(i.guildId);
      const current = ctx.sessions.get(i.guildId)?.stationId;
      const now = current ? ctx.stations.getStation(current)?.displayName : null;
      const lines = q.map((e, n) => {
        const st = ctx.stations.getStation(e.stationId);
        return `${n + 1}. ${st ? stationLine(st, ctx.sources.availability(st)) : e.stationId}${e.addedById ? ` — added by <@${e.addedById}>` : ''}`;
      });
      await i.reply({
        embeds: [
          infoEmbed(
            'Station queue',
            `${now ? `**Now:** ${now}\n\n` : ''}${lines.length ? lines.join('\n') : 'The queue is empty. Add stations with /radio queue add.'}`,
          ),
        ],
        flags: EPHEMERAL,
        allowedMentions: { parse: [] },
      });
      return;
    }
    const a = this.#auth(i, 'control');
    if (!a.ok) return this.#deny(i, a.reason);
    if (sub === 'clear') {
      const n = ctx.guilds.clearQueue(i.guildId);
      await i.reply({
        embeds: [
          infoEmbed('Queue cleared', `Removed ${n} ${n === 1 ? 'station' : 'stations'}.`, COLOR.neutral),
        ],
        flags: EPHEMERAL,
      });
      return;
    }
    if (sub === 'remove') {
      const pos = i.options.getInteger('position', true);
      const removed = ctx.guilds.removeFromQueue(i.guildId, pos);
      if (!removed) return this.#deny(i, `There is no station at position ${pos}.`);
      const name = ctx.stations.getStation(removed.stationId)?.displayName ?? removed.stationId;
      await i.reply({
        embeds: [infoEmbed('Removed from queue', `${name} was number ${pos} in the queue.`, COLOR.neutral)],
        flags: EPHEMERAL,
      });
      return;
    }
    // add
    const st = this.#station(i.guildId, i.options.getString('station', true));
    const availability = ctx.sources.availability(st);
    if (availability === 'retired' || availability === 'no_source') {
      return this.#deny(
        i,
        availability === 'retired'
          ? `${st.displayName} is no longer in the catalogue, so it can’t be played.`
          : `${st.displayName} can’t be played because no stream is known for it yet.`,
      );
    }
    const session = ctx.sessions.get(i.guildId);
    const busy = session?.connected && ctx.guilds.getIntent(i.guildId)?.desiredState === 'playing';
    if (!busy) {
      // Nothing playing: "queue add" starts the station straight away.
      await this.#play(
        i,
        st,
        null,
        (o) => i.editReply(o),
        () => i.deferReply(),
      );
      return;
    }
    const position = ctx.guilds.enqueue(i.guildId, st.id, i.user.id);
    if (position === null) return this.#deny(i, 'The queue is full (25 stations).');
    await i.reply({
      embeds: [
        infoEmbed(
          'Queued',
          `**${st.displayName}** is number ${position} in the queue.${position === 1 ? ' Use /radio skip to play it now.' : ''}`,
          COLOR.ok,
        ),
      ],
      allowedMentions: { parse: [] },
    });
    await this.refreshPanel(i.guildId);
  }

  /** Plays the next queued station (skipping any that can no longer be played). */
  async #cmdSkip(i: Cmd | Comp): Promise<void> {
    const a = this.#auth(i, 'control');
    if (!a.ok) return this.#deny(i, a.reason);
    // Entries that can no longer be played are dropped; the chosen one stays queued until it
    // has actually started, so a refused skip (channel rules, rate limit) loses nothing.
    let next: { station: Station; entryId: number } | null = null;
    for (const entry of this.#ctx.guilds.listQueue(i.guildId)) {
      const st = visibleStation(this.#ctx, i.guildId, entry.stationId);
      if (st && !['retired', 'no_source'].includes(this.#ctx.sources.availability(st))) {
        next = { station: st, entryId: entry.id };
        break;
      }
      this.#ctx.guilds.removeQueueEntry(i.guildId, entry.id);
    }
    if (!next) return this.#deny(i, 'The queue is empty. Add stations with /radio queue add.');
    const { station, entryId } = next;
    const requestedBefore = this.#ctx.guilds.getIntent(i.guildId)?.lastRequestedAt ?? null;
    const started = () => {
      // Remove only if this skip really issued a new play request for the station.
      const intent = this.#ctx.guilds.getIntent(i.guildId);
      if (intent?.desiredStationId === station.id && intent.lastRequestedAt !== requestedBefore) {
        this.#ctx.guilds.removeQueueEntry(i.guildId, entryId);
      }
    };
    try {
      if (i.isMessageComponent()) {
        await this.#play(
          i,
          station,
          null,
          (o) => i.editReply(o),
          () => i.deferReply({ flags: EPHEMERAL }),
        );
      } else {
        await this.#play(
          i,
          station,
          null,
          (o) => i.editReply(o),
          () => i.deferReply(),
        );
      }
    } finally {
      started();
    }
  }

  async #cmdAdd(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    this.#rate(this.#ctx.limits.addGuild, i.guildId, 'stations added');
    await i.deferReply({ flags: EPHEMERAL });
    const { station, report } = await this.#ctx.custom.add(i.guildId, i.user.id, {
      name: i.options.getString('name', true),
      url: i.options.getString('url', true),
      website: i.options.getString('website'),
      description: i.options.getString('description'),
      category: i.options.getString('category'),
      language: i.options.getString('language'),
    });
    const o = report.outcome;
    await i.editReply({
      embeds: [
        infoEmbed(
          `Added: ${station.displayName}`,
          [
            `Stream checked: ${codecLabel(o.codec, o.profile)} · ${o.measuredBitrateKbps ?? o.codecBitrateKbps ?? '?'} kbps · ${o.sampleRateHz ?? '?'} Hz · ${o.channels ?? '?'} channel(s) · ${transportLabel(o.transport)}`,
            `Station ID: \`${station.id}\` (custom, this server only).`,
            'Custom stations are listed in their own section, after the station packs.',
            o.transport === 'http-continuous' && i.options.getString('url', true).startsWith('http://')
              ? '⚠ This stream uses plain HTTP, so it is not encrypted on its way to the bot.'
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
          COLOR.ok,
        ),
      ],
    });
  }

  async #cmdEdit(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    const st = this.#station(i.guildId, i.options.getString('station', true));
    if (st.provider !== 'custom') return this.#deny(i, 'Only custom stations can be edited.');
    if (i.options.getString('url')) this.#rate(this.#ctx.limits.probeGuild, i.guildId, 'stream checks');
    await i.deferReply({ flags: EPHEMERAL });
    const { station } = await this.#ctx.custom.edit(i.guildId, st.id, {
      ...(i.options.getString('name') ? { name: i.options.getString('name')! } : {}),
      ...(i.options.getString('url') ? { url: i.options.getString('url')! } : {}),
      ...(i.options.getString('website') !== null ? { website: i.options.getString('website') } : {}),
      ...(i.options.getString('description') !== null
        ? { description: i.options.getString('description') }
        : {}),
    });
    await i.editReply({ embeds: [infoEmbed('Updated', `${station.displayName} was updated.`, COLOR.ok)] });
  }

  async #cmdRemove(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    const st = this.#station(i.guildId, i.options.getString('station', true));
    if (st.provider !== 'custom')
      return this.#deny(i, 'Only custom stations can be removed, not stations from a station pack.');
    const session = this.#ctx.sessions.get(i.guildId);
    if (session?.stationId === st.id) session.stop();
    const ok = this.#ctx.custom.remove(i.guildId, st.id);
    const settings = this.#ctx.guilds.getSettings(i.guildId);
    if (settings.defaultStationId === st.id)
      this.#ctx.guilds.updateSettings(i.guildId, { defaultStationId: null });
    await i.reply({
      embeds: [
        infoEmbed(
          ok ? 'Removed' : 'Not found',
          ok ? `${st.displayName} was removed.` : 'Nothing was removed.',
        ),
      ],
      flags: EPHEMERAL,
    });
  }

  async #rescan(i: Cmd | Comp, st: Station, compare: boolean): Promise<void> {
    this.#rate(this.#ctx.limits.probeGuild, i.guildId, 'stream checks');
    await i.deferReply({ flags: EPHEMERAL });
    const reports = await this.#ctx.sources.rescanStation(st.id);
    let compareNote = '';
    if (compare) {
      try {
        const results = await this.#ctx.sources.deepVerify(i.guildId, st.id);
        compareNote = results.length
          ? `\n**Audio comparison:**\n${results.map((r) => `• \`${r.sourceId}\`: ${r.evidence?.detail ?? r.error}`).join('\n')}`
          : '\nThere were no unverified sources to compare.';
      } catch (err) {
        compareNote = `\nThe audio comparison did not run: ${isRadioError(err) ? err.userMessage : 'it failed.'}`;
      }
    }
    const view = this.#sourcesView(i.guildId, st, true, false);
    const summary = reports
      .map(
        (r) =>
          `• \`${r.source.id}\`: ${r.outcome.success ? `${codecLabel(r.outcome.codec, r.outcome.profile)} ${r.outcome.measuredBitrateKbps ?? '?'} kbps · identity ${IDENTITY_WORD[r.identity.status]}` : `check failed (${r.outcome.failureCode})`}`,
      )
      .join('\n');
    // Discord's 6000-character limit covers every embed in the message together.
    const used = view.embeds.reduce((n, e) => n + embedLength(e.toJSON()), 0);
    const title = `Checked ${reports.length} ${reports.length === 1 ? 'source' : 'sources'} again`;
    view.embeds.unshift(
      infoEmbed(title, truncate(`${summary}${compareNote}`, Math.min(4000, 5900 - used - title.length))),
    );
    await i.editReply(view);
  }

  async #cmdRescan(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    const st = this.#station(i.guildId, i.options.getString('station', true));
    await this.#rescan(i, st, i.options.getBoolean('compare') ?? false);
  }

  async #cmdSync(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    const packId = i.options.getString('pack');
    const syncable = this.#ctx.catalogueSync.syncablePacks();
    if (syncable.length === 0)
      return this.#deny(i, 'None of the enabled station packs has an official list to check against.');
    if (packId && !syncable.some((p) => p.meta.id === packId)) {
      return this.#deny(i, 'That pack is either not enabled or has no official list to check against.');
    }
    this.#rate(this.#ctx.limits.syncGuild, i.guildId, 'catalogue syncs');
    this.#rate(this.#ctx.limits.syncGlobal, 'global', 'catalogue syncs');
    await i.deferReply({ flags: EPHEMERAL });
    const reports = packId
      ? [await this.#ctx.catalogueSync.sync(packId, 'admin')]
      : await this.#ctx.catalogueSync.syncAll('admin');
    const sections = reports.map((r) => {
      const lines = r.ok
        ? [
            `**${r.packName}**: the official list has ${r.officialCount} stations.`,
            `Added: ${r.added.length ? r.added.join(', ') : 'none'}`,
            `Renamed: ${r.renamed.length ? r.renamed.map((x) => `${x.from} → ${x.to}`).join(', ') : 'none'}`,
            `No longer on the official list: ${r.missing.length ? `${r.missing.join(', ')} (kept here, so favourites still work)` : 'none'}`,
            `Back on the list: ${r.returned.length ? r.returned.join(', ') : 'none'}`,
            r.needsSourceMapping.length
              ? `New stations with no stream yet (they can’t play until a reviewed source is added to the pack): ${r.needsSourceMapping.join(', ')}`
              : 'No new stations are waiting for a stream.',
            r.unreachable.length
              ? `Stations whose sources all failed their last check: ${r.unreachable.join(', ')}`
              : 'No station has all of its checked sources failing.',
          ]
        : [
            `**${r.packName}**: the sync failed. ${r.error}`,
            'Nothing was removed. The list is marked as possibly out of date.',
          ];
      return lines.join('\n');
    });
    const allOk = reports.every((r) => r.ok);
    await i.editReply({
      embeds: [
        infoEmbed(
          'Catalogue sync report',
          truncate(sections.join('\n\n'), 4000),
          allOk ? COLOR.ok : COLOR.warn,
        ),
      ],
    });
  }

  async #cmdConfig(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    const patch: SettingsPatch = {};
    const def = i.options.getString('default_station');
    if (def) patch.defaultStationId = this.#station(i.guildId, def).id;
    const manual = i.options.getInteger('manual_bitrate');
    if (manual !== null) patch.manualBitrateKbps = manual;
    const settings = this.#ctx.guilds.updateSettings(i.guildId, patch);
    if ('manualBitrateKbps' in patch) this.#ctx.sessions.get(i.guildId)?.refreshEncoder();
    await i.reply({ ...configView(this.#ctx, i.guildId, settings, 'access'), flags: EPHEMERAL });
  }

  async #cmdExport(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    const data = exportGuild(i.guildId, this.#ctx.guilds, this.#ctx.stations);
    const file = new AttachmentBuilder(Buffer.from(`${JSON.stringify(data, null, 2)}\n`), {
      name: `radio-bot-config-${i.guildId}.json`,
    });
    await i.reply({
      content:
        'This server’s settings. The file contains no tokens, and custom station URLs that include a query string are left out.',
      files: [file],
      flags: EPHEMERAL,
    });
  }

  async #cmdImport(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    const att = i.options.getAttachment('file', true);
    if (att.size > 256 * 1024)
      return this.#deny(i, 'That file is too big to be a settings export (the limit is 256 KB).');
    const url = new URL(att.url);
    if (!['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) {
      return this.#deny(i, 'That attachment is not stored on Discord, so it was not read.');
    }
    await i.deferReply({ flags: EPHEMERAL });
    const { text } = await this.#ctx.http.fetchText(att.url, { maxBytes: 256 * 1024 });
    let data: GuildExport;
    try {
      data = parseImport(text);
    } catch (err) {
      await i.editReply({ embeds: [errorEmbed((err as Error).message)] });
      return;
    }
    const channels = new Set(i.guild.channels.cache.keys());
    const roles = new Set(i.guild.roles.cache.keys());
    const preview = previewImport(i.guildId, data, this.#ctx.guilds, this.#ctx.stations, channels, roles);
    const token = randomBytes(6).toString('base64url');
    this.#imports.set(token, {
      guildId: i.guildId,
      userId: i.user.id,
      data,
      expires: Date.now() + 10 * 60_000,
    });
    this.#sweep();
    await i.editReply({
      embeds: [
        infoEmbed(
          'Import preview (nothing has changed yet)',
          truncate(
            [
              ...preview.lines,
              '',
              ...(preview.warnings.length ? ['**Warnings**', ...preview.warnings.map((w) => `⚠ ${w}`)] : []),
            ].join('\n'),
            4000,
          ),
        ),
      ],
      components: [
        new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(this.#ctx.ids.make(i.guildId, 'imp', token, 10 * 60_000))
            .setLabel('Apply import')
            .setStyle(ButtonStyle.Danger),
          new ButtonBuilder()
            .setCustomId(this.#ctx.ids.make(i.guildId, 'impx', token, 10 * 60_000))
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Secondary),
        ),
      ],
    });
  }

  async #cmdPanel(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    const channel = i.options.getChannel('channel') ?? i.channel;
    if (!channel?.isSendable() || channel.type === ChannelType.GuildVoice) {
      return this.#deny(i, 'Pick a text channel for the control panel.');
    }
    const me = i.guild.members.me;
    if (
      me &&
      'permissionsFor' in channel &&
      !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])
    ) {
      return this.#deny(i, `I need View Channel and Send Messages in <#${channel.id}>.`);
    }
    await i.deferReply({ flags: EPHEMERAL });
    const msg = await channel.send({ ...this.#panelView(i.guildId), allowedMentions: { parse: [] } });
    const old = this.#ctx.guilds.getSettings(i.guildId);
    this.#ctx.guilds.updateSettings(i.guildId, { panelChannelId: channel.id, panelMessageId: msg.id });
    if (old.panelMessageId && old.panelChannelId) {
      const oldCh = i.guild.channels.cache.get(old.panelChannelId);
      if (oldCh?.isTextBased()) await oldCh.messages.delete(old.panelMessageId).catch(() => {});
    }
    await i.editReply({
      embeds: [
        infoEmbed(
          'Control panel posted',
          `Posted in <#${channel.id}>. Every click is checked, so only people allowed to control the radio can use the buttons.`,
          COLOR.ok,
        ),
      ],
    });
  }

  #panelView(guildId: string): View {
    const s = this.#ctx.sessions.get(guildId);
    const status = s?.status() ?? null;
    const st = status?.stationId ? this.#ctx.stations.getStation(status.stationId) : null;
    const embed = nowEmbed(st, status, status?.channelId ?? null).setAuthor({
      name: 'Radio Bot control panel',
    });
    return { embeds: [embed], components: controlRows(this.#ctx, guildId, st?.id ?? null, true) };
  }

  /** Re-renders (and thereby rebinds) a guild's persistent panel. Safe to call often. */
  async refreshPanel(guildId: string): Promise<void> {
    const settings = this.#ctx.guilds.getSettings(guildId);
    if (!settings.panelChannelId || !settings.panelMessageId) return;
    try {
      const ch = await this.#ctx.client.channels.fetch(settings.panelChannelId);
      if (!ch?.isTextBased()) return;
      await ch.messages.edit(settings.panelMessageId, this.#panelView(guildId));
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === 10008 || code === 10003) {
        this.#ctx.guilds.updateSettings(guildId, { panelChannelId: null, panelMessageId: null });
      }
    }
  }

  async #cmdHelp(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'read');
    const lines = [
      '**Listen**',
      '`/radio browse`: pick a station from the list',
      '`/radio play <station>`: play a station in your voice channel',
      '`/radio now` shows what is playing. `/radio stop` stops it, and `/radio leave` takes the bot out of the channel.',
      'Also: `/radio list` · `/radio join` · `/radio status` · `/radio quality`',
      '',
      '**Queue**',
      '`/radio queue add <station>` lines up a station, and `/radio skip` plays the next one.',
      'Also: `/radio queue list` · `/radio queue remove` · `/radio queue clear`',
      '',
      '**Sources**',
      'A station can have several sources (streams). The bot only plays one it has verified as the right station.',
      '`/radio sources <station>`: which sources exist and which one plays',
      '`/radio inspect <station>`: codec, bitrate and the evidence behind them',
      '',
      a.ok && a.level === 'admin'
        ? '**Admin**\n`/radio config` · `/radio add` · `/radio edit` · `/radio remove` · `/radio source pin|prefer|auto|verify` · `/radio rescan` · `/radio sync` · `/radio export` · `/radio import` · `/radio panel`\n`/radio stats`: live stream and connection figures, shown only to you'
        : 'Server admins choose channels and DJ roles with `/radio config` and add custom stations with `/radio add`.',
      '',
      'Audio reaches Discord as 48 kHz stereo Opus at up to the station’s own bitrate (510 kbps at most). A higher bitrate can’t add detail that the station’s stream does not contain.',
      DISCLAIMER,
    ];
    await i.reply({ embeds: [infoEmbed('Radio Bot help', lines.join('\n'))], flags: EPHEMERAL });
  }

  async #sourceGroup(i: Cmd, sub: string): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    let st: Station;
    try {
      st = this.#station(i.guildId, i.options.getString('station', true));
    } catch (err) {
      if (err instanceof AmbiguousStation) {
        await i.reply({
          ...ambiguityView(this.#ctx, i.guildId, err.query, err.candidates, null),
          flags: EPHEMERAL,
        });
        return;
      }
      throw err;
    }
    if (sub === 'auto') {
      this.#ctx.guilds.setPreference(i.guildId, st.id, 'auto', null, i.user.id);
      await i.reply({
        embeds: [
          infoEmbed(
            'Automatic selection',
            `The bot chooses the source for ${st.displayName} again, based on its own checks.`,
            COLOR.ok,
          ),
        ],
        flags: EPHEMERAL,
      });
      return;
    }
    const sourceId = i.options.getString('source', true);
    const source = this.#ctx.stations.getSource(sourceId);
    if (!source || source.stationId !== st.id)
      return this.#deny(i, `\`${truncate(sourceId, 60)}\` is not a source of ${st.displayName}.`);
    if (sub === 'verify') {
      if (st.provider !== 'custom' && !isOperator(this.#ctx, i.user.id)) {
        return this.#deny(
          i,
          'A review of a station-pack source applies to every server that uses this bot, so only the bot’s operator can record it (someone in OPERATOR_USER_IDS, or the application’s owner or team).',
        );
      }
      if (st.provider === 'custom' && st.guildId !== i.guildId)
        return this.#deny(i, 'That custom station belongs to another server.');
      const verdict = i.options.getString('verdict', true);
      this.#ctx.stations.setIdentityOverride(
        source.id,
        verdict === 'clear' ? null : (verdict as 'verified' | 'mismatch'),
      );
      const decision = this.#ctx.sources.reevaluateIdentity(source.id);
      this.#ctx.logger.info({ sourceId: source.id, verdict, by: i.user.id }, 'identity override recorded');
      await i.reply({
        embeds: [
          infoEmbed(
            'Identity review recorded',
            `\`${source.id}\`: ${decision?.summary ?? `Verdict: ${verdict}.`} It is kept in the source’s evidence as a human review.`,
            COLOR.ok,
          ),
        ],
        flags: EPHEMERAL,
      });
      return;
    }
    const mode = sub === 'pin' ? 'pin' : 'prefer';
    this.#ctx.guilds.setPreference(i.guildId, st.id, mode, source.id, i.user.id);
    const selection = this.#ctx.sources.select(i.guildId, st.id);
    const warn =
      selection.selected?.id === source.id
        ? ''
        : `\n⚠ That source can’t be used right now (${selection.eligibility.find((e) => e.sourceId === source.id)?.reasons.join('; ') ?? 'reason unknown'}).${mode === 'pin' ? ' Until it recovers, the station plays from a fallback and is shown as degraded.' : ''}`;
    await i.reply({
      embeds: [
        infoEmbed(
          mode === 'pin' ? 'Source pinned' : 'Source preferred',
          `${st.displayName} → \`${source.id}\` (${sourceFormat(source)}).${warn}`,
          warn ? COLOR.warn : COLOR.ok,
        ),
      ],
      flags: EPHEMERAL,
    });
  }

  // ------------------------------------------------------------------ components

  async #component(i: Comp): Promise<void> {
    const parsed = this.#ctx.ids.parse(i.guildId, i.customId);
    if (!parsed) {
      await i.reply({ embeds: [errorEmbed('This button or menu is not valid here.')], flags: EPHEMERAL });
      return;
    }
    if (parsed.expired) {
      await i.reply({
        embeds: [errorEmbed('These buttons have expired. Run the command again.')],
        flags: EPHEMERAL,
      });
      return;
    }
    this.#rate(this.#ctx.limits.componentUser, i.user.id, 'clicks');
    const { action, arg } = parsed;
    try {
      switch (action) {
        case 'pick': {
          if (!i.isStringSelectMenu()) return;
          const st = visibleStation(this.#ctx, i.guildId, i.values[0] ?? '');
          if (!st) return this.#deny(i, 'That station is no longer available.');
          return await this.#play(
            i,
            st,
            arg || null,
            (o) => i.editReply(o),
            () => i.deferUpdate(),
          );
        }
        case 'play': {
          const st = visibleStation(this.#ctx, i.guildId, arg);
          if (!st) return this.#deny(i, 'That station is no longer available.');
          return await this.#play(
            i,
            st,
            null,
            (o) => i.editReply(o),
            () => i.deferReply({ flags: EPHEMERAL }),
          );
        }
        case 'browse': {
          const a = this.#auth(i, 'read');
          if (!a.ok) return this.#deny(i, a.reason);
          const [token, p] = arg.split(':');
          const state = this.#browse.get(token ?? '');
          if (!state || state.expires < Date.now())
            return this.#deny(i, 'This station list has expired. Run /radio browse again.');
          await i.update(browseView(this.#ctx, i.guildId, state, token!, Number((p ?? 'p0').slice(1)) || 0));
          return;
        }
        case 'openbrowse': {
          const a = this.#auth(i, 'read');
          if (!a.ok) return this.#deny(i, a.reason);
          const token = randomBytes(6).toString('base64url');
          this.#browse.set(token, {
            pack: null,
            category: null,
            search: null,
            expires: Date.now() + 15 * 60_000,
          });
          this.#sweep();
          await i.reply({
            ...browseView(this.#ctx, i.guildId, { pack: null, category: null, search: null }, token, 0),
            flags: EPHEMERAL,
          });
          return;
        }
        case 'list': {
          const a = this.#auth(i, 'read');
          if (!a.ok) return this.#deny(i, a.reason);
          const q = parseListArg(arg);
          await i.update(listView(this.#ctx, i.guildId, q.scope, q.pack, q.page));
          return;
        }
        case 'skip':
          return await this.#cmdSkip(i);
        case 'stats': {
          const a = this.#auth(i, 'admin');
          if (!a.ok) return this.#deny(i, a.reason);
          await i.deferUpdate();
          await i.editReply(await this.#statsView(i.guildId));
          return;
        }
        case 'close': {
          const a = this.#auth(i, 'read');
          if (!a.ok) return this.#deny(i, a.reason);
          await i.deferUpdate();
          await i.deleteReply().catch(() => {});
          return;
        }
        case 'stop':
          return await this.#cmdStop(i);
        case 'leave':
          return await this.#cmdLeave(i);
        case 'now':
          return await this.#cmdNow(i, !this.#isPanel(i));
        case 'next':
        case 'prev':
          return await this.#step(i, action === 'next' ? 1 : -1);
        case 'fav': {
          const a = this.#auth(i, 'control');
          if (!a.ok) return this.#deny(i, a.reason);
          const st = visibleStation(this.#ctx, i.guildId, arg);
          if (!st) return this.#deny(i, 'That station is no longer available.');
          const on = this.#ctx.guilds.toggleFavourite(i.guildId, st.id);
          await i.reply({
            embeds: [
              infoEmbed(
                'Favourites',
                `${st.displayName} ${on ? 'added to' : 'removed from'} this server’s favourites.`,
                COLOR.ok,
              ),
            ],
            flags: EPHEMERAL,
          });
          return;
        }
        case 'srcs':
        case 'insp': {
          const a = this.#auth(i, 'read');
          if (!a.ok) return this.#deny(i, a.reason);
          const st = visibleStation(this.#ctx, i.guildId, arg);
          if (!st) return this.#deny(i, 'That station is no longer available.');
          await i.reply({
            ...this.#sourcesView(i.guildId, st, action === 'insp', a.level === 'admin'),
            flags: EPHEMERAL,
          });
          return;
        }
        case 'rescan': {
          const a = this.#auth(i, 'admin');
          if (!a.ok) return this.#deny(i, a.reason);
          const st = visibleStation(this.#ctx, i.guildId, arg);
          if (!st) return this.#deny(i, 'That station is no longer available.');
          return await this.#rescan(i, st, false);
        }
        case 'cfg':
          return await this.#configComponent(i, arg);
        case 'imp':
        case 'impx':
          return await this.#importComponent(i, action === 'imp', arg);
        default:
          await this.#deny(i, 'That button is no longer supported. Run the command again.');
      }
    } catch (err) {
      if (err instanceof AmbiguousStation) return;
      throw err;
    }
  }

  #isPanel(i: Comp): boolean {
    return this.#ctx.guilds.getSettings(i.guildId).panelMessageId === i.message.id;
  }

  /** Next/Previous station within the current station's pack (or favourites order if favourites exist). Skips unplayable entries. */
  async #step(i: Comp, dir: 1 | -1): Promise<void> {
    const ctx = this.#ctx;
    const current =
      ctx.sessions.get(i.guildId)?.stationId ?? ctx.guilds.getIntent(i.guildId)?.desiredStationId ?? null;
    const all = visibleStations(ctx, i.guildId);
    const fav = ctx.guilds.listFavourites(i.guildId);
    const ring = (
      fav.length >= 2 && current && fav.includes(current)
        ? fav.map((id) => all.find((s) => s.id === id)).filter((s): s is Station => Boolean(s))
        : all.filter(
            (s) =>
              s.provider ===
              (current ? (this.#ctx.stations.getStation(current)?.provider ?? null) : all[0]?.provider),
          )
    ).filter((s) => ['available', 'degraded', 'unverified'].includes(ctx.sources.availability(s)));
    if (ring.length === 0) return this.#deny(i, 'There is no other playable station to move to.');
    const idx = current ? ring.findIndex((s) => s.id === current) : -1;
    const next = ring[(idx + dir + ring.length) % ring.length]!;
    await this.#play(
      i,
      next,
      null,
      (o) => i.editReply(o),
      () => i.deferReply({ flags: EPHEMERAL }),
    );
  }

  async #configComponent(i: Comp, field: string): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    const g = i.guildId;
    const cur = this.#ctx.guilds.getSettings(g);
    let page: ConfigPage = 'access';
    let patch: SettingsPatch = {};
    if (field.startsWith('page-')) {
      page = field.slice(5) as ConfigPage;
    } else if (i.isChannelSelectMenu()) {
      const ids = [...i.values];
      if (field === 'text') patch = { allowedTextChannelIds: ids };
      else if (field === 'voice') patch = { allowedVoiceChannelIds: ids };
      else if (field === 'pvoice') {
        patch = { preferredVoiceChannelId: ids[0] ?? null };
        page = 'playback';
      } else if (field === 'notify') {
        patch = { notificationChannelId: ids[0] ?? null };
        page = 'notify';
      }
    } else if (i.isRoleSelectMenu()) {
      const ids = [...i.values].filter((id) => id !== g);
      if (field === 'djs') patch = { djRoleIds: ids };
    } else if (i.isStringSelectMenu()) {
      page = 'playback';
      const v = i.values[0];
      if (field === 'idle' && (v === '24x7' || v === 'pause_when_empty' || v === 'leave_when_empty'))
        patch = { idleMode: v };
      if (field === 'member' && (v === 'none' || v === 'same_channel' || v === 'any'))
        patch = { memberControlMode: v };
      if (field === 'quality' && (v === 'maximum' || v === 'balanced' || v === 'manual'))
        patch = { qualityMode: v };
    } else if (i.isButton()) {
      page = 'playback';
      if (field === 'autostart') patch = { autostart: !cur.autostart };
      if (field === 'resume') patch = { resumeOnRestart: !cur.resumeOnRestart };
      if (field === 'lock') patch = { voiceLock: !cur.voiceLock };
    }
    const settings: GuildSettings = Object.keys(patch).length
      ? this.#ctx.guilds.updateSettings(g, patch)
      : cur;
    if ('qualityMode' in patch || 'manualBitrateKbps' in patch) this.#ctx.sessions.get(g)?.refreshEncoder();
    if ('idleMode' in patch) this.#recheckIdle(i.guild);
    await i.update(configView(this.#ctx, g, settings, page));
  }

  /** Re-applies the idle mode to the bot's current channel after the setting may have changed. */
  #recheckIdle(guild: Guild): void {
    const s = this.#ctx.sessions.get(guild.id);
    const ch = s?.channelId;
    if (!s || !ch) return;
    let humans = 0;
    for (const vs of guild.voiceStates.cache.values())
      if (vs.channelId === ch && !vs.member?.user.bot) humans++;
    s.onListenersChanged(humans);
  }

  async #importComponent(i: Comp, apply: boolean, token: string): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    const pending = this.#imports.get(token);
    this.#imports.delete(token);
    if (!pending || pending.guildId !== i.guildId || pending.expires < Date.now()) {
      return this.#deny(i, 'This import preview expired. Run /radio import again.');
    }
    if (!apply) {
      await i.update({
        embeds: [infoEmbed('Import cancelled', 'Nothing was changed.', COLOR.neutral)],
        components: [],
      });
      return;
    }
    await i.deferUpdate();
    const channels = new Set(i.guild.channels.cache.keys());
    const roles = new Set(i.guild.roles.cache.keys());
    applyImport(i.guildId, pending.data, this.#ctx.guilds, this.#ctx.stations, channels, roles, (fn) =>
      this.#ctx.db.transaction(fn),
    );
    // Imported quality and idle settings apply to the station already playing, as menu changes do.
    this.#ctx.sessions.get(i.guildId)?.refreshEncoder();
    this.#recheckIdle(i.guild);
    const added: string[] = [];
    const failed: string[] = [];
    // Re-applying the same file must not duplicate stations; each add probes, so it is rate-limited.
    const existing = new Set(
      visibleStations(this.#ctx, i.guildId)
        .filter((s) => s.provider === 'custom')
        .map((s) => s.displayName.toLowerCase()),
    );
    for (const c of pending.data.customStations.filter((x) => !x.urlRedacted)) {
      if (existing.has(c.name.toLowerCase())) {
        failed.push(`${c.name} (already exists)`);
        continue;
      }
      if (this.#ctx.limits.addGuild.take(i.guildId) > 0) {
        failed.push(`${c.name} (too many added at once; add it later with /radio add)`);
        continue;
      }
      try {
        await this.#ctx.custom.add(i.guildId, i.user.id, c);
        existing.add(c.name.toLowerCase());
        added.push(c.name);
      } catch (err) {
        failed.push(`${c.name} (${isRadioError(err) ? err.code : errorCode(err)})`);
      }
    }
    await i.editReply({
      embeds: [
        infoEmbed(
          'Import applied',
          truncate(
            [
              'Settings, favourites and source preferences were applied.',
              added.length ? `Custom stations added: ${added.join(', ')}` : '',
              failed.length ? `Custom stations not added: ${failed.join(', ')}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
            4000,
          ),
          COLOR.ok,
        ),
      ],
      components: [],
    });
  }

  #sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.#browse) if (v.expires < now) this.#browse.delete(k);
    for (const [k, v] of this.#imports) if (v.expires < now) this.#imports.delete(k);
  }
}

class AmbiguousStation extends Error {
  readonly query: string;
  readonly candidates: Station[];
  constructor(query: string, candidates: Station[]) {
    super('ambiguous station');
    this.query = query;
    this.candidates = candidates;
  }
}
