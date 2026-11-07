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
  DiscordAPIError,
  EmbedBuilder,
  embedLength,
  escapeMarkdown,
  type Guild,
  type Interaction,
  type InteractionEditReplyOptions,
  type MessageActionRowComponentBuilder,
  type MessageComponentInteraction,
  MessageFlags,
  type MessageFlagsBitField,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type SendableChannels,
  StringSelectMenuBuilder,
} from 'discord.js';
import type { LibraryIndex } from '../catalogue/pack-library.ts';
import { resolveStation, searchStations } from '../catalogue/search.ts';
import { AVAILABILITY_LABEL, type IdentityStatus, type Station } from '../catalogue/types.ts';
import {
  applyImport,
  exportGuild,
  type GuildExport,
  IMPORT_MAX_BYTES,
  MAX_FAVOURITES,
  MAX_SOURCE_PREFERENCES,
  parseImport,
  previewImport,
} from '../import-export/config-io.ts';
import { safeErr } from '../observability/logger.ts';
import { type LatencySummary, regionHint, tcpPing } from '../observability/netstats.ts';
import type {
  DesiredState,
  GuildSettings,
  QueueEntry,
  SettingsPatch,
} from '../persistence/repositories/guilds.ts';
import { yieldToEventLoop } from '../shared/async.ts';
import { errorCode, isRadioError, RadioError } from '../shared/errors.ts';
import { plural, truncate } from '../shared/text.ts';
import { codecLabel } from '../streams/probe.ts';
import { STATE_LABEL } from '../voice/state-machine.ts';
import {
  type AppContext,
  authContext,
  chooseVoiceChannel,
  groupName,
  isOperator,
  listedStation,
  lockConflict,
  visibleStation,
  visibleStations,
} from './context.ts';
import { type AuthResult, authorize, type Capability } from './permissions/authorize.ts';
import {
  bitrateText,
  COLOR,
  checkedLine,
  DISCLAIMER,
  errorEmbed,
  infoEmbed,
  latePacketsLine,
  liveDelayLine,
  loopDelayLine,
  nowEmbed,
  processLoadLine,
  qualityEmbed,
  silenceLine,
  sourceFormat,
  sourcesEmbed,
  stateColor,
  stationLine,
  voiceThreadLine,
} from './ui/format.ts';
import {
  fullCheckConfirmView,
  packCardView,
  packRemoveConfirmView,
  packsInstalledView,
  packsLibraryView,
} from './ui/packs-view.ts';
import {
  BITRATE_INPUT,
  bitrateModal,
  isSettingsScreen,
  MANUAL_KBPS_MAX,
  MANUAL_KBPS_MIN,
  NO_DEFAULT_STATION,
  type SettingsScreen,
  STATION_NAME,
  STATION_PICK,
  settingsCard,
  stationModal,
} from './ui/settings-view.ts';
import {
  ambiguityView,
  type BrowseState,
  browseSearchModal,
  browseView,
  controlRows,
  type ListScope,
  listView,
  parseListArg,
  SEARCH_INPUT,
  type View,
} from './ui/views.ts';

/** Identity status as a word for source autocomplete. */
const IDENTITY_WORD: Record<IdentityStatus, string> = {
  verified: 'verified',
  unverified: 'unverified',
  mismatch: 'wrong station',
};

/** A check's identity result, in the words the sources view uses. */
const CHECK_IDENTITY: Record<IdentityStatus, string> = {
  verified: 'verified as this station',
  unverified: 'not yet verified as this station',
  mismatch: 'plays a different station',
};

/** What the server has asked the radio to do, for /radio status. */
const DESIRED_LABEL: Record<DesiredState, string> = {
  idle: 'nothing',
  playing: 'play',
  paused_empty: 'play (paused while the channel is empty)',
  stopped: 'stay stopped',
  left: 'stay out of the voice channel',
  kicked: 'stay out of the voice channel (a moderator disconnected it)',
};

/** Open browse lists kept for their Next, Previous and Favourites buttons (each expires 15 min after last use). */
const MAX_BROWSE_LISTS = 500;

/** Availabilities that Next and Previous may move to. */
const PLAYABLE: ReadonlySet<string> = new Set(['available', 'degraded', 'unverified']);

type Cmd = ChatInputCommandInteraction<'cached'>;
type Comp = MessageComponentInteraction<'cached'>;
type Modal = ModalSubmitInteraction<'cached'>;
const EPHEMERAL = MessageFlags.Ephemeral;
/** Shown when a quality change re-encodes the playing station. */
const REENCODE_NOTE = 'The station restarts for a moment to use the new quality.';
/** Shown when a button or menu names a station that has since gone (removed, or its pack switched off). */
const GONE = 'That station is no longer available. Pick another with `/radio browse`.';
/** How long the reply to "Check them all" follows the run: an interaction token lasts 15 min. */
export const FULL_CHECK_FOLLOW_MS = 14 * 60_000;
/** …editing it at most this often while it runs (and once at the end). */
export const FULL_CHECK_EDIT_MS = 15_000;

/** What an interaction was, for the debug log: "command stats", "autocomplete play", "button stop". */
export function describeInteraction(i: Interaction): string {
  if (i.isChatInputCommand() || i.isAutocomplete()) {
    const group = i.options.getSubcommandGroup(false);
    const sub = i.options.getSubcommand(false);
    const name = [group, sub].filter(Boolean).join(' ') || i.commandName;
    return `${i.isAutocomplete() ? 'autocomplete' : 'command'} ${name}`;
  }
  if (i.isMessageComponent()) {
    // Custom IDs are "rb2:<action>:…"; only the action is worth logging.
    const action = i.customId.split(':')[1] ?? '?';
    return `${i.isButton() ? 'button' : 'menu'} ${action.slice(0, 16)}`;
  }
  if (i.isModalSubmit()) return `form ${(i.customId.split(':')[1] ?? '?').slice(0, 16)}`;
  return `type ${i.type}`;
}

/**
 * With nothing typed yet: the stations in `firstIds` (the default station, say), then the
 * favourites, then everything else in `stations` (custom stations only when `customOnly`), up to
 * `limit`. Each named station or favourite is looked up by ID, and the walk stops at `limit`, so a
 * long favourites list never meets a big catalogue head on.
 */
function defaultSuggestions(
  ctx: AppContext,
  guildId: string,
  stations: readonly Station[],
  firstIds: readonly (string | null)[],
  favourites: readonly string[],
  customOnly: boolean,
  limit = 25,
): Station[] {
  const top: Station[] = [];
  const shown = new Set<string>();
  const offer = (id: string | null) => {
    if (id === null || shown.has(id)) return;
    const s = listedStation(ctx, guildId, id);
    if (!s || (customOnly && s.provider !== 'custom')) return;
    shown.add(id);
    top.push(s);
  };
  for (const id of firstIds) offer(id);
  for (const id of favourites) {
    if (top.length >= limit) break;
    offer(id);
  }
  for (const s of stations) {
    if (top.length >= limit) break;
    if (!shown.has(s.id)) top.push(s);
  }
  return top.slice(0, limit);
}

/** Which page of the settings card a button or menu of a card from before 1.3 belongs to. */
const LEGACY_SETTINGS_SCREEN: Record<string, SettingsScreen> = {
  'page-access': 'access',
  'page-playback': 'playing',
  'page-notify': 'notices',
  text: 'access',
  voice: 'access',
  djs: 'access',
  member: 'access',
  pvoice: 'playing',
  switches: 'playing',
  autostart: 'playing',
  resume: 'playing',
  lock: 'playing',
  idle: 'sound',
  quality: 'sound',
  notify: 'notices',
  vstatus: 'notices',
};

/** Was this message sent in Discord's newer layout (Components V2)? */
const isCard = (m: { flags: Readonly<MessageFlagsBitField> } | null | undefined) =>
  m?.flags.has(MessageFlags.IsComponentsV2) ?? false;

/** An open browse list; `before` is the category to go back to from the Favourites filter. */
type OpenBrowse = BrowseState & { expires: number; before?: string | null };

interface PendingImport {
  /** The token its Apply and Cancel buttons carry. */
  token: string;
  userId: string;
  data: GuildExport;
  expires: number;
}

/** Handles every /radio interaction. All checks run server-side on every call. */
export class RadioController {
  readonly #ctx: AppContext;
  /** Open browse lists; `before` is the category to go back to from the Favourites filter. */
  readonly #browse = new Map<string, OpenBrowse>();
  /** At most one import preview per server, by guild ID: a newer one replaces it. */
  readonly #imports = new Map<string, PendingImport>();
  /** What each server's control panel last showed (see #panelShows), by guild ID. */
  readonly #panelShown = new Map<string, string>();

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
    const started = performance.now();
    const cpu = process.cpuUsage();
    try {
      if (i.isAutocomplete()) await this.#autocomplete(i);
      else if (i.isChatInputCommand() && i.commandName === 'radio') await this.#command(i);
      else if (i.isMessageComponent()) await this.#component(i);
      else if (i.isModalSubmit()) await this.#modal(i);
    } catch (err) {
      await this.#fail(i, err);
    }
    // Interactions run on the thread that sends voice packets, so a slow one can make them late.
    // `ms` includes waiting for Discord; `cpuMs` is the process's CPU time meanwhile, the better
    // guide to what held the thread up (it includes anything else running at the same moment).
    if (this.#ctx.logger.isLevelEnabled('debug')) {
      const used = process.cpuUsage(cpu);
      this.#ctx.logger.debug(
        {
          guildId: i.guildId,
          interaction: describeInteraction(i),
          ms: Math.round(performance.now() - started),
          cpuMs: Math.round((used.user + used.system) / 1000),
        },
        'interaction handled',
      );
    }
  }

  async #fail(i: Interaction<'cached'>, err: unknown): Promise<void> {
    // Suggestions that arrive after Discord stopped waiting (about 3 s) are normal, not a fault.
    if (
      i.isAutocomplete() &&
      err instanceof DiscordAPIError &&
      err.code === RESTJSONErrorCodes.UnknownInteraction
    ) {
      this.#ctx.logger.debug({ guildId: i.guildId }, 'suggestions expired before they were sent');
      return;
    }
    const message = isRadioError(err)
      ? err.userMessage
      : 'Something went wrong. Try again in a moment. If it keeps happening, let the bot owner know.';
    if (!isRadioError(err) || err.code === 'INTERNAL') {
      this.#ctx.logger.error({ err: safeErr(err), guildId: i.guildId, type: i.type }, 'interaction failed');
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

  #auth(i: Cmd | Comp | Modal, cap: Capability, target: string | null = null): AuthResult {
    return authorize(authContext(this.#ctx, i), this.#ctx.guilds.getSettings(i.guildId), cap, target);
  }

  async #deny(i: Cmd | Comp | Modal, reason: string): Promise<void> {
    await i.reply({ embeds: [errorEmbed(reason)], flags: EPHEMERAL });
  }

  #rate(limiter: { take(k: string): number }, key: string, what: string): void {
    const wait = limiter.take(key);
    if (wait > 0) {
      // Some limits refill over an hour: "30 min" reads better than "1800 s".
      const s = Math.ceil(wait / 1000);
      throw new RadioError(
        'RATE_LIMITED',
        `Too many ${what} in a short time. Try again in ${s < 90 ? `${s} s` : s < 90 * 60 ? `${Math.ceil(s / 60)} min` : `${Math.ceil(s / 3600)} h`}.`,
      );
    }
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
    const settings = this.#ctx.guilds.getSettings(i.guildId);
    // Suggestions are authorised like the command they belong to: anyone who may read gets
    // stations and packs, and only admins get `/radio source`'s sources and their review status.
    const need: Capability = i.options.getSubcommandGroup(false) === 'source' ? 'admin' : 'read';
    if (!authorize(authContext(this.#ctx, i), settings, need).ok) {
      await i.respond([]);
      return;
    }
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
    const customOnly = sub === 'edit' || sub === 'remove';
    let stations = visibleStations(this.#ctx, i.guildId);
    if (customOnly) stations = stations.filter((s) => s.provider === 'custom');
    const favourites = this.#ctx.guilds.listFavourites(i.guildId);
    const hits = q
      ? searchStations(stations, q, 25).map((h) => h.station)
      : defaultSuggestions(
          this.#ctx,
          i.guildId,
          stations,
          [settings.defaultStationId],
          favourites,
          customOnly,
        );
    const fav = new Set(favourites);
    const choices = hits.map((s) => {
      const marks = [
        s.provider === 'custom' ? 'custom' : null,
        s.id === settings.defaultStationId ? 'default' : null,
        fav.has(s.id) ? 'favourite' : null,
      ].filter(Boolean);
      return {
        name: truncate(
          `${s.displayName}${marks.length ? ` (${marks.join(', ')})` : ''} — ${AVAILABILITY_LABEL[this.#ctx.sources.availability(s)].toLowerCase()}`,
          100,
        ),
        value: s.id,
      };
    });
    await i.respond(choices.slice(0, 25));
  }

  // ------------------------------------------------------------------ slash commands

  async #command(i: Cmd): Promise<void> {
    const group = i.options.getSubcommandGroup(false);
    const sub = i.options.getSubcommand();
    try {
      if (group === 'source') return await this.#sourceGroup(i, sub);
      if (group === 'queue') return await this.#queueGroup(i, sub);
      if (group === 'packs') return await this.#packsGroup(i, sub);
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
          await this.#deny(
            i,
            'That command is not recognised. Your Discord app may be showing an old list of commands: restart it and try again.',
          );
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
    // The kept state itself is drawn, so the search results it keeps serve its page buttons.
    const state: OpenBrowse = {
      pack: i.options.getString('pack'),
      category: i.options.getString('category'),
      search: i.options.getString('search'),
      expires: Date.now() + 15 * 60_000,
    };
    this.#browse.set(token, state);
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
    skipped = false,
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
            `${result.message}\nPress **Refresh** to check progress.`,
            COLOR.warn,
          ),
        ],
        // Refresh shows progress, Stop cancels the retry, Sources says what is wrong.
        components: controlRows(ctx, i.guildId, station.id),
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
            `Couldn’t play ${station.displayName}`,
          ),
        ],
        // Sources says why, Stop cancels an automatic retry, Browse picks another station.
        components: controlRows(ctx, i.guildId, station.id),
      });
      return;
    }
    // The card says in one line why this source plays; Sources has the full reasoning.
    const queue = ctx.guilds.listQueue(i.guildId);
    await respond({
      embeds: [this.#withQueue(nowEmbed(station, status, target), queue)],
      components: controlRows(ctx, i.guildId, station.id, false, queue),
    });
    // The card above is for the person who asked; the channel gets one short public line, from
    // the command, a button or a menu alike. If Discord refuses it, the private card is enough.
    const verb = skipped ? 'skipped to' : switching ? 'switched to' : 'started';
    await i
      .followUp({
        content: `<@${i.user.id}> ${verb} **${station.displayName}**${switching ? '' : ` in <#${target}>`}.`,
        allowedMentions: { parse: [] },
      })
      .catch(() => {});
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
      () => i.deferReply({ flags: EPHEMERAL }),
    );
  }

  async #cmdStop(i: Cmd | Comp): Promise<void> {
    const a = this.#auth(i, 'control');
    if (!a.ok) return this.#deny(i, a.reason);
    const s = this.#ctx.sessions.get(i.guildId);
    // Playing, paused for an empty channel, or still trying to start: there is something to stop.
    // Otherwise the answer is private, so a second press doesn't post another public notice.
    const desired = this.#ctx.guilds.getIntent(i.guildId)?.desiredState;
    const active = Boolean(s) && (desired === 'playing' || desired === 'paused_empty');
    if (s) s.stop();
    else this.#ctx.guilds.setIntent(i.guildId, { desiredState: 'stopped' });
    if (!active) {
      await i.reply({
        embeds: [infoEmbed('Stopped', 'Nothing was playing.', COLOR.neutral)],
        flags: EPHEMERAL,
      });
    } else {
      await i.reply({
        embeds: [
          infoEmbed(
            'Stopped',
            `<@${i.user.id}> stopped the radio. It won’t start again by itself until someone plays a station.`,
            COLOR.neutral,
          ),
        ],
        allowedMentions: { parse: [] },
      });
    }
    await this.refreshPanel(i.guildId);
  }

  async #cmdLeave(i: Cmd | Comp): Promise<void> {
    const a = this.#auth(i, 'control');
    if (!a.ok) return this.#deny(i, a.reason);
    const s = this.#ctx.sessions.get(i.guildId);
    const here = s?.connected ?? false;
    if (s) s.leave('left');
    else this.#ctx.guilds.setIntent(i.guildId, { desiredState: 'left' });
    if (!here) {
      // Nothing to announce: the bot wasn't in a channel, so the answer is private.
      await i.reply({
        embeds: [
          infoEmbed(
            'Not in a voice channel',
            'Radio Bot wasn’t in a voice channel. It won’t join one until someone uses `/radio join` or plays a station.',
            COLOR.neutral,
          ),
        ],
        flags: EPHEMERAL,
      });
    } else {
      await i.reply({
        embeds: [
          infoEmbed(
            'Left',
            `<@${i.user.id}> disconnected the radio. I won’t rejoin until someone uses /radio join or plays a station.`,
            COLOR.neutral,
          ),
        ],
        allowedMentions: { parse: [] },
      });
    }
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
    const def = settings.defaultStationId
      ? visibleStation(this.#ctx, i.guildId, settings.defaultStationId)
      : null;
    const session = this.#ctx.sessions.get(i.guildId);
    if (session?.connected && session.channelId === target) {
      // Still in the channel after /radio stop: start the default station, as a fresh join would.
      const desired = this.#ctx.guilds.getIntent(i.guildId)?.desiredState;
      const playing = desired === 'playing' || desired === 'paused_empty';
      if (!def || playing) {
        await i.reply({
          embeds: [
            infoEmbed(
              'Already here',
              `Radio Bot is already in <#${target}>.${playing ? '' : ' Pick a station with `/radio play` or `/radio browse`.'}`,
              COLOR.neutral,
            ),
          ],
          flags: EPHEMERAL,
        });
        return;
      }
    }
    // Playing the default station takes play tokens in #play, so only a bare join takes them here.
    if (def) {
      await this.#play(
        i,
        def,
        explicit,
        (o) => i.editReply(o),
        () => i.deferReply({ flags: EPHEMERAL }),
      );
      return;
    }
    this.#rate(this.#ctx.limits.playUser, i.user.id, 'join requests');
    this.#rate(this.#ctx.limits.playGuild, i.guildId, 'join requests');
    await i.deferReply();
    await this.#ctx.sessions.ensure(i.guildId).join(target);
    await i.editReply({
      embeds: [
        infoEmbed(
          'Joined',
          `Joined <#${target}>. There is no default station, so press **Browse** or use \`/radio play\` to pick one. Admins can set one in \`/radio config\`.`,
          COLOR.ok,
        ),
      ],
      // Browse picks a station; Next starts the first one in the catalogue.
      components: controlRows(this.#ctx, i.guildId, null),
    });
  }

  async #cmdNow(i: Cmd | Comp, update = false): Promise<void> {
    const a = this.#auth(i, 'read');
    if (!a.ok) return this.#deny(i, a.reason);
    const s = this.#ctx.sessions.get(i.guildId);
    const status = s?.status() ?? null;
    const st = status?.stationId ? this.#ctx.stations.getStation(status.stationId) : null;
    const queue = this.#ctx.guilds.listQueue(i.guildId);
    const view = {
      embeds: [this.#withQueue(nowEmbed(st, status, status?.channelId ?? null), queue)],
      components: controlRows(this.#ctx, i.guildId, st?.id ?? null, false, queue),
    };
    if (update && i.isMessageComponent()) await i.update(view);
    else await i.reply({ ...view, flags: EPHEMERAL });
  }

  async #cmdList(i: Cmd): Promise<void> {
    const pack = i.options.getString('pack');
    const requested = i.options.getString('scope') as ListScope | null;
    const scope: ListScope = pack === 'custom' ? 'custom' : (requested ?? 'all');
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
    await i.reply({ ...this.#sourcesView(i.guildId, st, detailed, this.#who(i)), flags: EPHEMERAL });
  }

  /** What the person looking at a sources view may change: only offer controls they can use. */
  #who(i: Cmd | Comp): { admin: boolean; control: boolean } {
    const channel = this.#ctx.sessions.get(i.guildId)?.channelId ?? null;
    const auth = authContext(this.#ctx, i);
    const settings = this.#ctx.guilds.getSettings(i.guildId);
    return {
      admin: authorize(auth, settings, 'admin').ok,
      control: authorize(auth, settings, 'control', channel).ok,
    };
  }

  #sourcesView(
    guildId: string,
    st: Station,
    detailed: boolean,
    who: { admin: boolean; control: boolean },
  ): View {
    const ctx = this.#ctx;
    const sources = ctx.sources.sourcesFor(st.id);
    const selection = ctx.sources.select(guildId, st.id);
    const session = ctx.sessions.get(guildId);
    const status = session?.connected && session.stationId === st.id ? session.status() : null;
    const live = { playingId: status?.source?.id ?? null, manualId: status?.manualSourceId ?? null };
    const embed = sourcesEmbed(st, sources, selection, detailed, live);
    const pref = ctx.guilds.getPreference(guildId, st.id);
    const pinned = pref?.mode === 'pin';
    const canPrefer =
      who.admin &&
      sources.length > 0 &&
      live.playingId !== null &&
      (pref?.mode !== 'prefer' || pref.sourceId !== live.playingId);
    const canAuto = who.admin && sources.length > 0 && !!pref && pref.mode !== 'auto';
    // The admin buttons have short labels, so what they do (on this server only) is said here.
    const choice: string[] = [];
    // The source's name, as the list above shows it (its ID only when it has no name).
    const chosen = sources.find((s) => s.id === pref?.sourceId);
    const name = chosen?.label ? `**${truncate(chosen.label, 60)}**` : `\`${pref?.sourceId ?? 'none'}\``;
    if (pinned)
      choice.push(
        `Pinned to ${name}: only admins can switch it. If it fails, another source plays and the station shows as degraded.`,
      );
    else if (pref?.mode === 'prefer')
      choice.push(`${name} is tried first. If it fails, the bot switches to another source.`);
    if (canPrefer)
      choice.push(
        '**Use this source first**: try the source playing now first. If it fails, the bot still switches to another.',
      );
    if (canAuto) choice.push('**Choose automatically**: go back to the bot’s own choice.');
    if (choice.length) embed.addFields({ name: 'On this server', value: choice.join('\n') });
    const row = (...c: MessageActionRowComponentBuilder[]) =>
      new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...c);
    const components: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
    // Anyone who may control the radio can play this station from another usable source while it
    // plays. Only usable sources are offered, and the click is checked again on the server.
    if (who.control && (who.admin || !pinned) && live.playingId && selection.ordered.length > 1) {
      components.push(
        row(
          new StringSelectMenuBuilder()
            .setCustomId(ctx.ids.make(guildId, 'usesrc', st.id))
            .setPlaceholder('Switch source until the station changes')
            .addOptions(
              // A short label a phone shows in full, and the codec and bitrate below it (about 40
              // characters, so a phone shows that in full too; the rest is in the list above).
              selection.ordered.slice(0, 25).map((src, n) => ({
                label: truncate(`#${n + 1} ${src.label ?? 'Source'}`, 100),
                value: src.id,
                description: truncate(
                  `${src.id === selection.selected?.id ? 'Best · ' : ''}${codecLabel(src.codec, src.profile)} · ${bitrateText(src)}`,
                  100,
                ),
                default: src.id === live.playingId,
              })),
            ),
        ),
      );
    }
    if (who.admin && sources.length > 0) {
      const buttons = [
        new ButtonBuilder()
          .setCustomId(ctx.ids.make(guildId, 'rescan', st.id))
          .setLabel('Check sources again')
          .setStyle(ButtonStyle.Primary),
      ];
      if (canPrefer) {
        buttons.push(
          new ButtonBuilder()
            .setCustomId(ctx.ids.make(guildId, 'spref', st.id))
            .setLabel('Use this source first')
            .setStyle(ButtonStyle.Secondary),
        );
      }
      if (canAuto) {
        buttons.push(
          new ButtonBuilder()
            .setCustomId(ctx.ids.make(guildId, 'sauto', st.id))
            .setLabel('Choose automatically')
            .setStyle(ButtonStyle.Secondary),
        );
      }
      components.push(row(...buttons));
    }
    return { embeds: [embed], components };
  }

  /** A listener plays the current station from another of its usable sources (until the station changes). */
  async #useSource(i: Comp, stationId: string): Promise<void> {
    const ctx = this.#ctx;
    if (!i.isStringSelectMenu()) return;
    const st = visibleStation(ctx, i.guildId, stationId);
    if (!st) return this.#deny(i, GONE);
    const session = ctx.sessions.get(i.guildId);
    if (!session?.connected || session.stationId !== st.id || session.status()?.desiredState !== 'playing')
      return this.#deny(i, `${st.displayName} isn’t playing any more, so its source can’t be changed.`);
    const a = this.#auth(i, 'control', session.channelId);
    if (!a.ok) return this.#deny(i, a.reason);
    if (ctx.guilds.getPreference(i.guildId, st.id)?.mode === 'pin' && a.level !== 'admin')
      return this.#deny(
        i,
        `An admin has pinned ${st.displayName} to one source, so only an admin can switch its source.`,
      );
    // Checked again now, not trusted from the menu: it must be a usable source of this station.
    const source = ctx.sources.select(i.guildId, st.id).ordered.find((s) => s.id === i.values[0]);
    if (!source)
      return this.#deny(
        i,
        'That source can’t be used right now: it must be verified as this station and working. The best usable source keeps playing.',
      );
    if (session.status()?.source?.id === source.id)
      return this.#deny(i, `${st.displayName} is already playing from that source.`);
    this.#rate(ctx.limits.playUser, i.user.id, 'station changes');
    this.#rate(ctx.limits.playGuild, i.guildId, 'station changes');
    await i.deferReply({ flags: EPHEMERAL });
    const r = await session.useSource(st.id, source.id);
    ctx.logger.info({ guildId: i.guildId, sourceId: source.id, by: i.user.id }, 'listener chose a source');
    await i.editReply({
      embeds: [
        r.ok
          ? infoEmbed(
              'Source changed',
              `${st.displayName} now plays from **${source.label ?? 'another source'}** until the station changes. If it fails, the bot goes back to the best source.`,
              COLOR.ok,
            )
          : errorEmbed(r.message),
      ],
    });
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
    const e = new EmbedBuilder()
      .setTitle('Radio status')
      .setColor(stateColor(status?.state))
      .addFields(
        {
          name: 'Right now',
          value: `${status ? STATE_LABEL[status.state] : 'Idle'}${status?.channelId ? ` in <#${status.channelId}>` : ''}`,
          inline: true,
        },
        {
          name: 'Asked to',
          value: `${DESIRED_LABEL[intent?.desiredState ?? 'idle']}${desired ? `: ${desired.displayName}` : ''}`,
          inline: true,
        },
      );
    if (status?.source) e.addFields({ name: 'Source', value: sourceFormat(status.source), inline: true });
    const notes: string[] = [];
    if (status?.lastError) notes.push(`⚠️ ${status.lastError.message}`);
    if (intent?.lastErrorCode === 'RESUME_DISABLED')
      notes.push('Playback wasn’t resumed after the last restart, because **Resume after restart** is off.');
    if (notes.length) e.setDescription(notes.join('\n'));
    await i.reply({ embeds: [e], flags: EPHEMERAL });
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
      return hint ? ` (${hint}, guessed from the host name)` : '';
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
      .setColor(stateColor(status?.state))
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
              `Stream server round trip (TCP): ${lat(streamRtt)}`,
            ].join('\n'),
            1024,
          ),
        },
        {
          name: 'Output to Discord',
          value: truncate(
            [
              `Opus target: ${out ? `${out.targetKbps} kbps (${status.plan?.qualityMode ?? '—'})` : '—'} · voice channel setting ${kbps(out?.channelBitrateKbps)} (not a cap)`,
              `Sent to Discord: ${kbps(out?.kbps10s)} (10 s) · ${kbps(out?.kbps60s)} (60 s) · Ogg Opus from the encoder`,
              `Packets to Discord: ${live.voice?.packetsPerSecond ?? '—'} per second (expect ~50) · ${live.voice?.packetsPlayed ?? '—'} sent on this connection`,
              latePacketsLine(live.voice?.latePackets, live.voice?.worstPacketGapMs),
              silenceLine(live.voice?.silenceMs, live.voice?.recentSilenceMs),
              liveDelayLine(live.voice?.live),
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
              `Fallback switches: ${status.failovers} · voice reconnects: ${status.reconnects} · encoder PID: ${status.encoderPid ?? '—'}`,
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
    const packLines: string[] = [];
    for (const p of ctx.packs.packs) {
      if (!ctx.packs.isEnabled(p.meta.id)) {
        packLines.push(`**${p.meta.name}** (\`${p.meta.id}\`): disabled`);
        continue;
      }
      // A pack's counts are cached, but counting a big pack again (after a change, or once they
      // are a minute old) takes milliseconds: each pack gets a slice of its own.
      await yieldToEventLoop();
      const cov = ctx.sources.coverageByProvider(p.meta.id);
      const sync = p.meta.sync ? ctx.stations.lastSyncOutcome(p.meta.id) : null;
      const syncText = !p.meta.sync
        ? 'no official list'
        : sync
          ? // A Discord timestamp shows in the reader's own time zone, with the exact time on hover.
            `list synced <t:${Math.floor(Date.parse(sync.finishedAt) / 1000)}:R> ${sync.success ? '(ok)' : '(failed)'}`
          : 'list never synced';
      packLines.push(
        `**${p.meta.name}** (\`${p.meta.id}\`): ${cov.catalogued} stations · ${cov.usable} with a working stream · ${cov.verifiedPlayable} verified and playable · ${syncText}`,
      );
    }
    const incidents = ctx.metrics.recentIncidents(guildId, 6);
    // With VOICE_THREAD=worker the packets leave from the worker's event loop, not this one.
    const voiceThread = voiceThreadLine(ctx.voiceThreadStats?.() ?? null);
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
            loopDelayLine(ctx.eventLoop.lastWindow() ?? ctx.eventLoop.current(), !voiceThread),
            processLoadLine(ctx.eventLoop.lastWindow() ?? ctx.eventLoop.current()),
            ...(voiceThread ? [voiceThread] : []),
            `Stream User-Agent: \`${ctx.http.userAgent}\` · database schema v${ctx.db.schemaVersion()}`,
          ].join('\n'),
        },
        {
          name: 'Station packs',
          value: truncate(
            [
              ...packLines,
              // An installed pack that failed its checks is skipped, never half-loaded: say so here.
              ...ctx.packs.skipped.map((s) => `Not loaded: \`${s.dir}\` (see \`/radio packs installed\`)`),
            ].join('\n') || 'No station packs are loaded. Add some with `/radio packs library`.',
            1024,
          ),
        },
        {
          name: 'Recent problems (repeats grouped)',
          value: truncate(
            incidents.length
              ? incidents
                  .map(
                    (x) =>
                      `<t:${Math.floor(Date.parse(x.at) / 1000)}:R> ${x.code} [${x.domain}]${x.count > 1 ? ` ×${x.count}` : ''}: ${x.detail}`,
                  )
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

  /**
   * Adds "Up next" to a now-playing style embed when the queue is not empty. The caller reads the
   * queue once and passes the same list to `controlRows()`.
   */
  #withQueue(embed: EmbedBuilder, q: readonly QueueEntry[]): EmbedBuilder {
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
      // "Playing now" only while it plays: after Stop the session still remembers the station.
      const session = ctx.sessions.get(i.guildId);
      const now =
        session?.connected && ctx.guilds.getIntent(i.guildId)?.desiredState === 'playing' && session.stationId
          ? ctx.stations.getStation(session.stationId)?.displayName
          : null;
      const lines = q.map((e, n) => {
        const st = ctx.stations.getStation(e.stationId);
        return `${n + 1}. ${st ? stationLine(st, ctx.sources.availability(st)) : e.stationId}${e.addedById ? ` · added by <@${e.addedById}>` : ''}`;
      });
      const e = new EmbedBuilder()
        .setTitle(`Queue: ${q.length} ${q.length === 1 ? 'station' : 'stations'}`)
        .setColor(COLOR.info)
        .setDescription(
          truncate(
            lines.length ? lines.join('\n') : 'The queue is empty. Add stations with `/radio queue add`.',
            4000,
          ),
        )
        .setFooter({ text: DISCLAIMER });
      if (now) e.addFields({ name: 'Playing now', value: now });
      await i.reply({ embeds: [e], flags: EPHEMERAL, allowedMentions: { parse: [] } });
      return;
    }
    const a = this.#auth(i, 'control');
    if (!a.ok) return this.#deny(i, a.reason);
    // Queue changes are public one-liners, so everyone listening sees who changed what.
    if (sub === 'clear') {
      const n = ctx.guilds.clearQueue(i.guildId);
      if (n === 0) {
        await i.reply({
          embeds: [infoEmbed('Queue already empty', 'There was nothing to clear.', COLOR.neutral)],
          flags: EPHEMERAL,
        });
        return;
      }
      await i.reply({
        content: `<@${i.user.id}> cleared the queue (${n} ${n === 1 ? 'station' : 'stations'}).`,
        allowedMentions: { parse: [] },
      });
      // The panel's Skip button and "Up next" show the queue: redraw it.
      await this.refreshPanel(i.guildId);
      return;
    }
    if (sub === 'remove') {
      const pos = i.options.getInteger('position', true);
      const removed = ctx.guilds.removeFromQueue(i.guildId, pos);
      if (!removed) return this.#deny(i, `There is no station at position ${pos}.`);
      const name = ctx.stations.getStation(removed.stationId)?.displayName ?? removed.stationId;
      await i.reply({
        content: `<@${i.user.id}> removed **${name}** from the queue (it was number ${pos}).`,
        allowedMentions: { parse: [] },
      });
      await this.refreshPanel(i.guildId);
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
        () => i.deferReply({ flags: EPHEMERAL }),
      );
      return;
    }
    const position = ctx.guilds.enqueue(i.guildId, st.id, i.user.id);
    if (position === null) return this.#deny(i, 'The queue is full (25 stations).');
    await i.reply({
      content: `<@${i.user.id}> queued **${st.displayName}** (number ${position}).${position === 1 ? ' `/radio skip` plays it now.' : ''}`,
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
    if (!next) {
      // Nothing went wrong (the panel always offers Skip), so this is grey, not an error.
      await i.reply({
        embeds: [
          infoEmbed(
            'Nothing to skip to',
            'The queue is empty. Add stations with /radio queue add.',
            COLOR.neutral,
          ),
        ],
        flags: EPHEMERAL,
      });
      return;
    }
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
      await this.#play(
        i,
        station,
        null,
        (o) => i.editReply(o),
        () => i.deferReply({ flags: EPHEMERAL }),
        true,
      );
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
            `Stream checked: ${checkedLine(o)}`,
            `Station ID: \`${station.id}\` (custom, this server only).`,
            'Press **Play now**, or type its name in `/radio play`. It is also listed under **Custom stations (this server)** in `/radio browse` and `/radio list`, after the station packs.',
            o.transport === 'http-continuous' && i.options.getString('url', true).startsWith('http://')
              ? '⚠️ This stream uses plain HTTP, so it is not encrypted on its way to the bot.'
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
          COLOR.ok,
        ),
      ],
      // Playing it is the usual next step; the button checks Control like any other Play.
      components: [
        new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(this.#ctx.ids.make(i.guildId, 'play', station.id))
            .setLabel('Play now')
            .setStyle(ButtonStyle.Primary),
        ),
      ],
    });
  }

  async #cmdEdit(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    const st = this.#station(i.guildId, i.options.getString('station', true));
    if (st.provider !== 'custom') return this.#deny(i, 'Only custom stations can be edited.');
    const name = i.options.getString('name');
    const url = i.options.getString('url');
    const website = i.options.getString('website');
    const description = i.options.getString('description');
    const category = i.options.getString('category');
    const language = i.options.getString('language');
    if (!name && !url && website === null && description === null && category === null && language === null)
      return this.#deny(
        i,
        'Nothing to change. Give a new name, url, website, description, category or language.',
      );
    if (url) this.#rate(this.#ctx.limits.probeGuild, i.guildId, 'stream checks');
    await i.deferReply({ flags: EPHEMERAL });
    const { station, report } = await this.#ctx.custom.edit(i.guildId, st.id, {
      ...(name ? { name } : {}),
      ...(url ? { url } : {}),
      ...(website !== null ? { website } : {}),
      ...(description !== null ? { description } : {}),
      ...(category !== null ? { category } : {}),
      ...(language !== null ? { language } : {}),
    });
    const changed = [
      name ? 'name' : null,
      url ? 'stream URL' : null,
      website !== null ? 'website' : null,
      description !== null ? 'description' : null,
      category !== null ? 'category' : null,
      language !== null ? 'language' : null,
    ].filter(Boolean);
    await i.editReply({
      embeds: [
        infoEmbed(
          `Updated: ${station.displayName}`,
          [`Changed: ${changed.join(', ')}.`, report ? `Stream checked: ${checkedLine(report.outcome)}` : '']
            .filter(Boolean)
            .join('\n'),
          COLOR.ok,
        ),
      ],
    });
  }

  async #cmdRemove(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    const st = this.#station(i.guildId, i.options.getString('station', true));
    if (st.provider !== 'custom')
      return this.#deny(i, 'Only custom stations can be removed, not stations from a station pack.');
    const session = this.#ctx.sessions.get(i.guildId);
    const current = session?.stationId === st.id;
    // After a Stop the session still remembers the station, so ask whether it was really playing.
    const desired = current ? this.#ctx.guilds.getIntent(i.guildId)?.desiredState : null;
    const wasPlaying = desired === 'playing' || desired === 'paused_empty';
    if (current) session!.stop('station_removed');
    const ok = this.#ctx.custom.remove(i.guildId, st.id);
    const settings = this.#ctx.guilds.getSettings(i.guildId);
    const wasDefault = settings.defaultStationId === st.id;
    if (wasDefault) this.#ctx.guilds.updateSettings(i.guildId, { defaultStationId: null });
    // No confirm step (the admin named the station), so the reply says exactly what went with it.
    await i.reply({
      embeds: [
        ok
          ? infoEmbed(
              `Removed: ${st.displayName}`,
              [
                'It is gone from this server, with its place in favourites and the queue.',
                wasPlaying ? 'It was playing, so the radio stopped.' : '',
                wasDefault ? 'It was the default station, so there is no default station now.' : '',
                '-# This can’t be undone. To get it back, add it again with `/radio add`.',
              ]
                .filter(Boolean)
                .join('\n'),
              COLOR.ok,
            )
          : infoEmbed('Not found', 'Nothing was removed.', COLOR.neutral),
      ],
      flags: EPHEMERAL,
    });
  }

  async #rescan(i: Cmd | Comp, st: Station, compare: boolean): Promise<void> {
    this.#rate(this.#ctx.limits.probeGuild, i.guildId, 'stream checks');
    await i.deferReply({ flags: EPHEMERAL });
    // One source at a time (per host), so show progress rather than a long silence.
    const reports = await this.#ctx.sources.rescanStation(st.id, undefined, (done, total) => {
      if (done < total) {
        void i
          .editReply({
            embeds: [infoEmbed('Checking sources', `Checked ${done} of ${total}…`, COLOR.neutral)],
          })
          .catch(() => {});
      }
    });
    // Sources by name, as the list below shows them (an ID only when a source has no name): a long
    // ID in a code span overflows on a phone.
    const labels = new Map(reports.map((r) => [r.source.id, r.source.label]));
    const name = (id: string) => {
      const label = labels.get(id);
      return label ? `**${truncate(label, 60)}**` : `\`${id}\``;
    };
    let compareNote = '';
    if (compare) {
      // Each comparison listens to two streams for about 40 s, so say what the wait is for.
      await i
        .editReply({
          embeds: [
            infoEmbed(
              'Comparing audio',
              `Checked all ${reports.length}. Now comparing the sources not yet verified as this station with a verified one. Each comparison listens for about 40 seconds.`,
              COLOR.neutral,
            ),
          ],
        })
        .catch(() => {});
      try {
        const results = await this.#ctx.sources.deepVerify(i.guildId, st.id);
        compareNote = results.length
          ? `\n**Audio comparison:**\n${results.map((r) => `• ${name(r.sourceId)}: ${r.evidence?.detail ?? r.error}`).join('\n')}`
          : '\nThere were no unverified sources to compare.';
      } catch (err) {
        compareNote = `\nThe audio comparison did not run: ${isRadioError(err) ? err.userMessage : 'it failed.'}`;
      }
    }
    const view = this.#sourcesView(i.guildId, st, true, { admin: false, control: false });
    const summary = reports
      .map(
        (r) =>
          `• ${name(r.source.id)}: ${r.outcome.success ? `${codecLabel(r.outcome.codec, r.outcome.profile)} · ${bitrateText(r.outcome)} · ${CHECK_IDENTITY[r.identity.status]}` : `check failed (${r.outcome.failureCode})`}`,
      )
      .join('\n');
    // Discord's 6000-character limit covers every embed in the message together.
    const used = view.embeds.reduce((n, e) => n + embedLength(e.toJSON()), 0);
    const title = `Checked ${reports.length} ${reports.length === 1 ? 'source' : 'sources'} again`;
    view.embeds.unshift(
      infoEmbed(
        title,
        truncate(`${summary}${compareNote}`, Math.min(4000, 5900 - used - title.length)),
        reports.every((r) => r.outcome.success) ? COLOR.ok : COLOR.warn,
      ),
    );
    await i.editReply(view);
  }

  async #cmdRescan(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    const st = this.#station(i.guildId, i.options.getString('station', true));
    await this.#rescan(i, st, i.options.getBoolean('compare') ?? false);
  }

  // ------------------------------------------------------------------ station packs

  /** `/radio packs installed | library | sync`. Viewing is for admins; changing packs is for operators too. */
  async #packsGroup(i: Cmd, sub: string): Promise<void> {
    if (sub === 'sync') return this.#cmdSync(i);
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    await i.deferReply({ flags: EPHEMERAL });
    const pm = this.#ctx.packManager;
    if (sub === 'installed') {
      // For "update available": a network wait, never main-thread work. Offline still lists.
      await pm.index().catch(() => null);
      await i.editReply(packsInstalledView(this.#ctx, i.guildId));
      return;
    }
    let index: LibraryIndex;
    try {
      index = await pm.index();
    } catch (err) {
      await i.editReply({
        embeds: [
          errorEmbed(
            `Couldn’t reach the pack library: ${isRadioError(err) ? err.userMessage : 'try again later.'}`,
          ),
        ],
      });
      return;
    }
    await i.editReply(
      packsLibraryView(this.#ctx, i.guildId, index, {
        words: i.options.getString('search'),
        country: i.options.getString('country'),
      }),
    );
  }

  /** Something that affects every server this bot is in: an admin here, and an operator too. */
  #operatorDenied(i: Comp, why: string): string | null {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return a.reason;
    return isOperator(this.#ctx, i.user.id) ? null : why;
  }

  /** Changing packs affects every server this bot is in, so it also needs an operator. */
  #packChangeDenied(i: Comp): string | null {
    const denied = this.#operatorDenied(
      i,
      'Station packs are shared by every server this bot is in, so only the bot owner can install, update or remove them.',
    );
    if (denied) return denied;
    if (!this.#ctx.packManager.canInstall)
      return 'This bot has no data folder, so it can’t install station packs.';
    return null;
  }

  /**
   * "Check all sources again" on `/radio packs installed`: asks first, then checks every pack
   * source in the background queue (see FullSourceCheck). It affects every server, so it is for
   * the bot owner. The reply follows it for up to 14 minutes (interaction tokens last 15); after
   * that, `/radio packs installed` shows how it stands. Nothing is posted in any channel.
   */
  async #fullCheckComponent(i: Comp, action: 'pkchk' | 'pkchkok' | 'pkchkx'): Promise<void> {
    const denied = this.#operatorDenied(
      i,
      'Checking every source again affects every server this bot is in, so only the bot owner can start or stop it.',
    );
    if (denied) return this.#deny(i, denied);
    const ctx = this.#ctx;
    const fc = ctx.fullCheck;
    if (action === 'pkchkx') {
      await i.deferUpdate();
      await fc.stop();
      await i.editReply(packsInstalledView(ctx, i.guildId));
      return;
    }
    if (fc.running) {
      await i.update(packsInstalledView(ctx, i.guildId, 'A check of every source is already running.'));
      return;
    }
    if (action === 'pkchk') {
      await i.update(fullCheckConfirmView(ctx, i.guildId));
      return;
    }
    this.#rate(ctx.limits.fullCheckGlobal, 'global', 'checks of every source');
    let ready = false;
    let closed = false;
    let lastEdit = 0;
    const edit = (note: string | null = null) =>
      void i.editReply(packsInstalledView(ctx, i.guildId, note)).catch(() => {});
    const timer = setTimeout(() => {
      if (closed) return;
      closed = true;
      edit(
        'This message has stopped updating. Open `/radio packs installed` again to see how the check is going.',
      );
    }, FULL_CHECK_FOLLOW_MS);
    timer.unref?.();
    const started = fc.start((s) => {
      if (!ready || closed) return;
      const end = s.status !== 'running';
      const now = Date.now();
      if (!end && now - lastEdit < FULL_CHECK_EDIT_MS) return;
      lastEdit = now;
      if (end) {
        closed = true;
        clearTimeout(timer);
      }
      edit();
    });
    if (!started) clearTimeout(timer);
    await i.update(
      packsInstalledView(ctx, i.guildId, started ? null : 'A check of every source is already running.'),
    );
    ready = true;
    lastEdit = Date.now();
    // A short run may have ended before the reply was first shown: show how it ended.
    if (started && !closed && !fc.running) {
      closed = true;
      clearTimeout(timer);
      edit();
    }
  }

  async #packComponent(i: Comp, action: 'pksel' | 'pkinst' | 'pkrm' | 'pkrmok', arg: string): Promise<void> {
    const pm = this.#ctx.packManager;
    const entryFor = async (id: string) => {
      const index = pm.cachedIndex() ?? (await pm.index().catch(() => null));
      return index?.packs.find((p) => p.id === id) ?? null;
    };
    if (action === 'pksel') {
      const a = this.#auth(i, 'admin');
      if (!a.ok) return this.#deny(i, a.reason);
      const id = i.isStringSelectMenu() ? i.values[0] : null;
      if (!id) return this.#deny(i, 'Choose a pack from the list.');
      await i.deferUpdate();
      await i.editReply(packCardView(this.#ctx, i.guildId, id, await entryFor(id)));
      return;
    }
    const denied = this.#packChangeDenied(i);
    if (denied) return this.#deny(i, denied);
    if (action === 'pkrm') {
      await i.update(packRemoveConfirmView(this.#ctx, i.guildId, arg));
      return;
    }
    this.#rate(this.#ctx.limits.packGlobal, 'global', 'station pack changes');
    if (action === 'pkrmok') {
      await i.deferUpdate();
      const entry = await entryFor(arg);
      await i.editReply(
        packCardView(
          this.#ctx,
          i.guildId,
          arg,
          entry,
          'Removing it now. This message updates when it’s done.',
          'removing',
        ),
      );
      let note: string;
      try {
        note = (await pm.remove(arg))
          ? 'Removed. Its stations are hidden everywhere; favourites come back if it is installed again.'
          : 'That pack wasn’t installed.';
      } catch (err) {
        note = isRadioError(err) ? err.userMessage : 'Removing the pack failed; the log has the details.';
      }
      await i.editReply(packCardView(this.#ctx, i.guildId, arg, entry, note)).catch(() => {});
      return;
    }
    // Install or update: a background job that waits for any stream that is starting, so the
    // message says so now and is updated when it finishes.
    const entry = await entryFor(arg);
    await i.update(
      packCardView(
        this.#ctx,
        i.guildId,
        arg,
        entry,
        'Working on it in the background, without interrupting any music. This message updates when it’s done.',
        this.#ctx.packs.get(arg) ? 'updating' : 'installing',
      ),
    );
    let note: string;
    try {
      const r = await pm.install(arg);
      note = r.previousVersion
        ? `Updated from version ${r.previousVersion} to ${r.version}: ${plural(r.stations, 'station')}.`
        : `Installed: ${plural(r.stations, 'station')}, ready to play now.`;
    } catch (err) {
      this.#ctx.logger.warn({ err: safeErr(err), pack: arg }, 'station pack install failed');
      note = isRadioError(err) ? err.userMessage : 'Installing the pack failed; the log has the details.';
    }
    await i.editReply(packCardView(this.#ctx, i.guildId, arg, entry, note)).catch(() => {});
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
    // Long lists are shortened, so one pack's changes never push the rest of the report out.
    const names = (list: string[]) =>
      list.length > 15 ? `${list.slice(0, 15).join(', ')} and ${list.length - 15} more` : list.join(', ');
    const sections = reports.map((r) => {
      if (!r.ok)
        return [
          `**${r.packName}**: the sync failed. ${r.error}`,
          'Nothing was removed. The list is marked as possibly out of date.',
        ].join('\n');
      // Every station a sync adds has no stream yet, so that is said once, with the names.
      const allWaiting = r.needsSourceMapping.length === r.added.length;
      const changes = [
        r.added.length
          ? `Added: ${names(r.added)}${allWaiting ? ' (no stream yet: they can’t play until a reviewed source is added to the pack)' : ''}`
          : null,
        !allWaiting && r.needsSourceMapping.length
          ? `New stations with no stream yet (they can’t play until a reviewed source is added to the pack): ${names(r.needsSourceMapping)}`
          : null,
        r.renamed.length ? `Renamed: ${names(r.renamed.map((x) => `${x.from} → ${x.to}`))}` : null,
        r.missing.length
          ? `No longer on the official list: ${names(r.missing)} (kept here, so favourites still work)`
          : null,
        r.returned.length ? `Back on the list: ${names(r.returned)}` : null,
      ].filter((l) => l !== null);
      return [
        `**${r.packName}**: the official list has ${r.officialCount} stations.`,
        ...(changes.length ? changes : ['No stations were added, renamed, dropped or brought back.']),
        r.unreachable.length
          ? `Stations whose sources all failed their last check: ${names(r.unreachable)}`
          : 'No station has all of its checked sources failing.',
      ].join('\n');
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
    const card = settingsCard(this.#ctx, i.guildId, this.#ctx.guilds.getSettings(i.guildId), 'home');
    await i.reply({ ...card, flags: [EPHEMERAL, card.flags] });
  }

  async #cmdExport(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    const data = exportGuild(i.guildId, this.#ctx.guilds, this.#ctx.stations);
    const bytes = Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
    const file = new AttachmentBuilder(bytes, { name: `radio-bot-config-${i.guildId}.json` });
    await i.reply({
      content: [
        'This server’s settings, favourites, source choices and custom stations. To load them here or on another server, use `/radio import` with this file.',
        '-# The file contains no tokens. A custom station URL with a query string, user name or password is left out; add that station again with `/radio add` after an import.',
        // Rare (it takes very long IDs or URLs as well as near the most of everything): say so now,
        // not when the import refuses it.
        bytes.length > IMPORT_MAX_BYTES
          ? `⚠️ This file is larger than \`/radio import\` accepts (${IMPORT_MAX_BYTES / 1024} KB), so it can’t be imported as it is. Fewer favourites, source choices or custom stations make it smaller.`
          : '',
      ]
        .filter(Boolean)
        .join('\n'),
      files: [file],
      flags: EPHEMERAL,
    });
  }

  async #cmdImport(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    const att = i.options.getAttachment('file', true);
    if (att.size > IMPORT_MAX_BYTES)
      return this.#deny(
        i,
        `That file is too big to be a settings export (the limit is ${IMPORT_MAX_BYTES / 1024} KB).`,
      );
    const url = new URL(att.url);
    if (!['cdn.discordapp.com', 'media.discordapp.net'].includes(url.hostname)) {
      return this.#deny(i, 'That attachment is not stored on Discord, so it was not read.');
    }
    this.#rate(this.#ctx.limits.importGuild, i.guildId, 'imports');
    await i.deferReply({ flags: EPHEMERAL });
    const { text } = await this.#ctx.http.fetchText(att.url, { maxBytes: IMPORT_MAX_BYTES });
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
    // Replaces any earlier preview for this server, whose buttons then say it has expired.
    this.#imports.set(i.guildId, {
      token,
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
              ...(preview.warnings.length
                ? ['**Warnings**', ...preview.warnings.map((w) => `⚠️ ${w}`), '']
                : []),
              '-# **Apply import** changes these settings at once and can’t be undone. The buttons work for 10 minutes.',
            ].join('\n'),
            4000,
          ),
          // Warnings need a look before Apply.
          preview.warnings.length ? COLOR.warn : COLOR.info,
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
      return this.#deny(i, 'Pick a text channel for the control panel, with the channel option.');
    }
    const refusal = this.#panelRefusal(i.guild, channel);
    if (refusal) return this.#deny(i, refusal);
    await i.deferReply({ flags: EPHEMERAL });
    const removedOld = await this.#postPanel(i.guild, channel);
    await i.editReply({
      embeds: [
        infoEmbed(
          'Control panel posted',
          [
            `Posted in <#${channel.id}>.${removedOld ? ' The old panel was deleted.' : ''} It updates by itself and keeps working after restarts.`,
            // Browse, Sources and Refresh are for anyone who may use the bot; the rest need control.
            'Each button checks the access of whoever presses it.',
            '-# To move or remove it, use **Control panel** in `/radio config`, or run `/radio panel` again in another channel.',
          ].join('\n'),
          COLOR.ok,
        ),
      ],
    });
  }

  /** Why the control panel can't be posted in `channel`, or null when it can. */
  #panelRefusal(guild: Guild, channel: SendableChannels): string | null {
    const me = guild.members.me;
    // The panel is an embed, so it needs Embed Links as well: without it the post would fail.
    if (
      me &&
      'permissionsFor' in channel &&
      !channel
        .permissionsFor(me)
        ?.has([
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
        ])
    )
      return `I need View Channel, Send Messages and Embed Links in <#${channel.id}>.`;
    return null;
  }

  /**
   * Posts the control panel in `channel`, saves where it is, and deletes the one it replaces.
   * Returns whether an old panel was deleted.
   */
  async #postPanel(guild: Guild, channel: SendableChannels): Promise<boolean> {
    const view = this.#panelView(guild.id);
    const msg = await channel.send({ ...view, allowedMentions: { parse: [] } });
    const old = this.#ctx.guilds.getSettings(guild.id);
    this.#ctx.guilds.updateSettings(guild.id, { panelChannelId: channel.id, panelMessageId: msg.id });
    this.#panelShown.set(guild.id, this.#panelShows(channel.id, msg.id, view));
    if (!old.panelMessageId || !old.panelChannelId) return false;
    const oldCh = guild.channels.cache.get(old.panelChannelId);
    if (!oldCh?.isTextBased()) return false;
    return oldCh.messages.delete(old.panelMessageId).then(
      () => true,
      () => false,
    );
  }

  #panelView(guildId: string): View {
    const s = this.#ctx.sessions.get(guildId);
    const status = s?.status() ?? null;
    const st = status?.stationId ? this.#ctx.stations.getStation(status.stationId) : null;
    // One queue read for both "Up next" and the Skip button.
    const queue = this.#ctx.guilds.listQueue(guildId);
    const embed = this.#withQueue(nowEmbed(st, status, status?.channelId ?? null), queue).setAuthor({
      name: 'Radio Bot control panel',
    });
    return { embeds: [embed], components: controlRows(this.#ctx, guildId, st?.id ?? null, true, queue) };
  }

  /** The panel message and what it shows, as one string: equal strings mean an equal panel. */
  #panelShows(channelId: string, messageId: string, view: View): string {
    return `${channelId}/${messageId}\n${JSON.stringify(view)}`;
  }

  /**
   * Re-renders a guild's persistent panel. Safe to call often: a panel that would look exactly as
   * it was last sent is not edited again (no request to Discord), and a failed edit is retried on
   * the next call.
   */
  async refreshPanel(guildId: string): Promise<void> {
    const settings = this.#ctx.guilds.getSettings(guildId);
    if (!settings.panelChannelId || !settings.panelMessageId) {
      this.#panelShown.delete(guildId);
      return;
    }
    const view = this.#panelView(guildId);
    const shows = this.#panelShows(settings.panelChannelId, settings.panelMessageId, view);
    if (this.#panelShown.get(guildId) === shows) return;
    try {
      const ch = await this.#ctx.client.channels.fetch(settings.panelChannelId);
      if (!ch?.isTextBased()) return;
      await ch.messages.edit(settings.panelMessageId, view);
      this.#panelShown.set(guildId, shows);
    } catch (err) {
      this.#panelShown.delete(guildId);
      const code = (err as { code?: number }).code;
      if (code === 10008 || code === 10003) {
        this.#ctx.guilds.updateSettings(guildId, { panelChannelId: null, panelMessageId: null });
      }
    }
  }

  async #cmdHelp(i: Cmd): Promise<void> {
    const a = this.#auth(i, 'read');
    const admin = a.ok && a.level === 'admin';
    const lines = (...l: string[]) => l.join('\n');
    const e = new EmbedBuilder()
      .setTitle('Radio Bot help')
      .setColor(COLOR.info)
      .setDescription(
        // Help answers in any channel, so outside the command channels it says where the rest work.
        ['Live radio in your voice channel. Every command starts with `/radio`.', a.ok ? null : a.reason]
          .filter(Boolean)
          .join('\n'),
      )
      .addFields(
        {
          name: '🎧 Listen',
          value: lines(
            '`/radio browse`: pick a station from the list (**Search** narrows it)',
            '`/radio play <station>`: play a station in your voice channel (type part of its name)',
            '`/radio now`: what is playing · `/radio stop`: stop playing · `/radio leave`: leave the channel',
            '-# Also: `/radio list` · `/radio join` · `/radio status` · `/radio quality`',
            '-# Station and queue changes, Stop and Leave are announced in the channel in one line. Everything else is shown only to you.',
          ),
        },
        {
          name: '⭐ Favourites and the default station',
          value: lines(
            'Press **Favourite** under a playing station. Favourites come first in the `/radio play` suggestions and have their own list in Browse (**Show favourites**). With two or more, Next and Previous step through them while one plays.',
            'The default station (set by an admin in `/radio config`) is what `/radio join` plays, and what **Autostart** plays when the bot starts.',
          ),
        },
        {
          name: '📋 Queue',
          value: lines(
            '`/radio queue add <station>` lines up a station; `/radio skip` plays the next one.',
            '-# Also: `/radio queue list` · `/radio queue remove` · `/radio queue clear`',
          ),
        },
        {
          name: '📡 Sources',
          value: lines(
            'A station can have several sources (streams). The bot plays the best one it has verified as the right station.',
            '`/radio sources <station>`: its sources, best first. While it plays, you can switch to another usable source until the station changes.',
            '`/radio inspect <station>`: codec, bitrate and the evidence behind them',
          ),
        },
        admin
          ? {
              name: '🛠 Admin',
              value: lines(
                // Grouped by job, setup first, so a phone shows what to run first.
                '`/radio config`: every server setting, with **Set up** for the main ones · `/radio panel`: a control panel that stays',
                'Custom stations: `/radio add` · `/radio edit` · `/radio remove`',
                'Sources: `/radio source pin|prefer|auto|verify` · `/radio rescan`',
                '-# `/radio source`: `prefer` tries a source first · `pin` also lets only admins switch it · `auto` lets the bot choose · `verify` records if a source is the right station',
                'Station packs: `/radio packs library` finds and installs them · `/radio packs installed` updates or removes them, and has **Check all sources again** (bot owner) · `/radio packs sync` checks them against their official lists',
                'Settings file: `/radio export` · `/radio import`',
                '`/radio stats`: live stream and connection figures, shown only to you',
              ),
            }
          : {
              name: '🛠 Settings',
              value:
                'Server admins choose channels, DJ roles and the default station with `/radio config`, and add custom stations with `/radio add`.',
            },
        {
          name: '🔊 Sound',
          value: lines(
            'Audio reaches Discord as 48 kHz stereo Opus. The bitrate depends on the Quality setting:',
            `**Maximum** follows the station’s own bitrate (${this.#ctx.config.maxOpusBitrateKbps} kbps at most) · **Balanced** uses at most 128 kbps · **Manual** uses the bitrate an admin sets (${this.#ctx.config.maxOpusBitrateKbps} kbps at most), and follows the station until one is set`,
            '-# A higher bitrate can’t add detail the station’s stream doesn’t contain.',
          ),
        },
      )
      .setFooter({ text: DISCLAIMER });
    await i.reply({ embeds: [e], flags: EPHEMERAL });
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
            'Choosing automatically',
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
          'A review of a station-pack source applies to every server that uses this bot, so only the bot owner can record it.',
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
            'Source review recorded',
            `\`${source.id}\`: ${decision?.summary ?? `Verdict: ${verdict}.`} It is kept in the source’s evidence as a human review.`,
            COLOR.ok,
          ),
        ],
        flags: EPHEMERAL,
      });
      return;
    }
    const mode = sub === 'pin' ? 'pin' : 'prefer';
    const full = this.#preferencesFull(i.guildId, st.id);
    if (full) return this.#deny(i, full);
    this.#ctx.guilds.setPreference(i.guildId, st.id, mode, source.id, i.user.id);
    const selection = this.#ctx.sources.select(i.guildId, st.id);
    const warn =
      selection.selected?.id === source.id
        ? ''
        : `\n⚠️ That source can’t be used right now (${selection.eligibility.find((e) => e.sourceId === source.id)?.reasons.join('; ') ?? 'reason unknown'}).${mode === 'pin' ? ' Until it works again, another source plays and the station shows as degraded.' : ''}`;
    // Named as in the sources list (an ID only when it has no name); its format goes on its own line.
    const name = source.label ? `**${truncate(source.label, 60)}**` : `\`${source.id}\``;
    await i.reply({
      embeds: [
        infoEmbed(
          mode === 'pin' ? 'Source pinned' : 'Source tried first',
          `${
            mode === 'pin'
              ? `On this server, ${st.displayName} now plays from ${name} whenever it can be used, and only admins can switch it to another source.`
              : `On this server, ${st.displayName} now tries ${name} first. Whenever it can’t be used, the bot picks another source by itself.`
          }\n-# ${sourceFormat(source)}${warn}`,
          warn ? COLOR.warn : COLOR.ok,
        ),
      ],
      flags: EPHEMERAL,
    });
  }

  /**
   * Refusal text when a new source choice would take this server past the most it can keep (so
   * that /radio export always makes a file /radio import accepts), else null. Changing the choice
   * for a station that already has one is always allowed.
   */
  #preferencesFull(guildId: string, stationId: string): string | null {
    if (this.#ctx.guilds.getPreference(guildId, stationId)) return null;
    if (this.#ctx.guilds.listPreferences(guildId).length < MAX_SOURCE_PREFERENCES) return null;
    return `This server already has source choices for ${MAX_SOURCE_PREFERENCES} stations, the most it can keep. Use \`/radio source auto\` on a station that no longer needs one, then try again.`;
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
        case 'usesrc':
          return await this.#useSource(i, arg);
        case 'spref':
        case 'sauto': {
          const a = this.#auth(i, 'admin');
          if (!a.ok) return this.#deny(i, a.reason);
          const st = visibleStation(this.#ctx, i.guildId, arg);
          // Prefer whatever this station is playing from right now (worked out at click time).
          const session = this.#ctx.sessions.get(i.guildId);
          const playing =
            action === 'spref' && session?.stationId === arg ? (session.status()?.source?.id ?? null) : null;
          const source = playing ? this.#ctx.stations.getSource(playing) : null;
          if (!st) return this.#deny(i, GONE);
          if (action === 'spref' && source?.stationId !== st.id)
            return this.#deny(
              i,
              'That station isn’t playing from one of its sources right now, so there is no source to try first.',
            );
          const full = action === 'spref' ? this.#preferencesFull(i.guildId, st.id) : null;
          if (full) return this.#deny(i, full);
          this.#ctx.guilds.setPreference(
            i.guildId,
            st.id,
            action === 'spref' ? 'prefer' : 'auto',
            source?.id ?? null,
            i.user.id,
          );
          await i.reply({
            embeds: [
              infoEmbed(
                action === 'spref' ? 'Source tried first' : 'Choosing automatically',
                action === 'spref'
                  ? `On this server, ${st.displayName} now tries **${source!.label ?? 'that source'}** first. If it fails, the bot switches to another source.`
                  : `The bot chooses the source for ${st.displayName} again, based on its own checks.`,
                COLOR.ok,
              ),
            ],
            flags: EPHEMERAL,
          });
          return;
        }
        case 'pick': {
          if (!i.isStringSelectMenu()) return;
          const st = visibleStation(this.#ctx, i.guildId, i.values[0] ?? '');
          if (!st) return this.#deny(i, GONE);
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
          if (!st) return this.#deny(i, GONE);
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
          const state = this.#useBrowse(token ?? '');
          if (!state) return this.#deny(i, 'This station list has expired. Run /radio browse again.');
          await i.update(browseView(this.#ctx, i.guildId, state, token!, Number((p ?? 'p0').slice(1)) || 0));
          return;
        }
        case 'bsearch': {
          const a = this.#auth(i, 'read');
          if (!a.ok) return this.#deny(i, a.reason);
          const state = this.#useBrowse(arg);
          if (!state) return this.#deny(i, 'This station list has expired. Run /radio browse again.');
          if (!i.isButton()) return;
          await i.showModal(browseSearchModal(this.#ctx, i.guildId, arg, state.search));
          return;
        }
        case 'bfav': {
          const a = this.#auth(i, 'read');
          if (!a.ok) return this.#deny(i, a.reason);
          const state = this.#useBrowse(arg);
          if (!state) return this.#deny(i, 'This station list has expired. Run /radio browse again.');
          if (state.category === 'favourites') state.category = state.before ?? null;
          else {
            state.before = state.category;
            state.category = 'favourites';
          }
          await i.update(browseView(this.#ctx, i.guildId, state, arg, 0));
          return;
        }
        case 'obrowse': {
          const a = this.#auth(i, 'read');
          if (!a.ok) return this.#deny(i, a.reason);
          const token = randomBytes(6).toString('base64url');
          const state: OpenBrowse = {
            pack: null,
            category: null,
            search: null,
            expires: Date.now() + 15 * 60_000,
          };
          this.#browse.set(token, state);
          this.#sweep();
          await i.reply({ ...browseView(this.#ctx, i.guildId, state, token, 0), flags: EPHEMERAL });
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
        case 'pkchk':
        case 'pkchkok':
        case 'pkchkx':
          return await this.#fullCheckComponent(i, action);
        case 'pksel':
        case 'pkinst':
        case 'pkrm':
        case 'pkrmok':
          return await this.#packComponent(i, action, arg);
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
        case 'now': {
          if (!this.#isPanel(i)) return await this.#cmdNow(i, true);
          const a = this.#auth(i, 'read');
          if (!a.ok) return this.#deny(i, a.reason);
          // Refresh on the panel redraws the panel itself: everyone sees it, and no reply is posted.
          const view = this.#panelView(i.guildId);
          await i.update(view);
          // This is the panel (its message ID is the saved one), so the timer needn't send it again.
          const channelId = this.#ctx.guilds.getSettings(i.guildId).panelChannelId ?? '';
          this.#panelShown.set(i.guildId, this.#panelShows(channelId, i.message.id, view));
          return;
        }
        case 'next':
        case 'prev':
          return await this.#step(i, action === 'next' ? 1 : -1);
        case 'fav':
        case 'unfav': {
          const a = this.#auth(i, 'control');
          if (!a.ok) return this.#deny(i, a.reason);
          const st = visibleStation(this.#ctx, i.guildId, arg);
          if (!st) return this.#deny(i, GONE);
          // Each button sets one state, so a double click or an old card never undoes the other.
          const want = action === 'fav';
          const was = this.#ctx.guilds.isFavourite(i.guildId, st.id);
          // Capped, so that /radio export always makes a file /radio import accepts.
          if (want && !was && this.#ctx.guilds.listFavourites(i.guildId).length >= MAX_FAVOURITES)
            return this.#deny(
              i,
              `This server already has ${MAX_FAVOURITES} favourites, the most it can keep. Remove one it no longer needs first: play it and press **Unfavourite**.`,
            );
          if (was !== want) this.#ctx.guilds.toggleFavourite(i.guildId, st.id);
          const text =
            was === want
              ? want
                ? `${st.displayName} is already one of this server’s favourites.`
                : `${st.displayName} isn’t one of this server’s favourites, so nothing changed.`
              : want
                ? `${st.displayName} is now one of this server’s favourites. They come first in \`/radio play\`, and **Show favourites** in Browse lists them.`
                : `${st.displayName} is no longer one of this server’s favourites.`;
          const title =
            was === want
              ? want
                ? 'Already a favourite'
                : 'Not a favourite'
              : want
                ? 'Added to favourites'
                : 'Removed from favourites';
          await i.reply({
            // Grey when nothing changed, green when it did.
            embeds: [infoEmbed(title, text, was === want ? COLOR.neutral : COLOR.ok)],
            flags: EPHEMERAL,
          });
          // The control panel shows Favourite or Unfavourite for the playing station: redraw it.
          if (was !== want) await this.refreshPanel(i.guildId);
          return;
        }
        case 'srcs':
        case 'insp': {
          const a = this.#auth(i, 'read');
          if (!a.ok) return this.#deny(i, a.reason);
          const st = visibleStation(this.#ctx, i.guildId, arg);
          if (!st) return this.#deny(i, GONE);
          await i.reply({
            ...this.#sourcesView(i.guildId, st, action === 'insp', this.#who(i)),
            flags: EPHEMERAL,
          });
          return;
        }
        case 'rescan': {
          const a = this.#auth(i, 'admin');
          if (!a.ok) return this.#deny(i, a.reason);
          const st = visibleStation(this.#ctx, i.guildId, arg);
          if (!st) return this.#deny(i, GONE);
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

  // ------------------------------------------------------------------ forms

  /** A submitted form (modal). Its custom ID is signed like a button's and checked the same way. */
  async #modal(i: Modal): Promise<void> {
    const parsed = this.#ctx.ids.parse(i.guildId, i.customId);
    if (parsed?.expired) {
      await i.reply({
        embeds: [errorEmbed('This form has expired. Run the command again.')],
        flags: EPHEMERAL,
      });
      return;
    }
    if (parsed?.action !== 'bsearch' && parsed?.action !== 'cfgm') {
      await i.reply({ embeds: [errorEmbed('This form is not valid here.')], flags: EPHEMERAL });
      return;
    }
    this.#rate(this.#ctx.limits.componentUser, i.user.id, 'clicks');
    if (parsed.action === 'cfgm') return this.#configForm(i, parsed.arg);
    const a = this.#auth(i, 'read');
    if (!a.ok) return this.#deny(i, a.reason);
    const state = this.#useBrowse(parsed.arg);
    if (!state) return this.#deny(i, 'This station list has expired. Run /radio browse again.');
    state.search = i.fields.getTextInputValue(SEARCH_INPUT).trim().slice(0, 60) || null;
    const view = browseView(this.#ctx, i.guildId, state, parsed.arg, 0);
    // The form was opened from the browse list, so the list itself changes to the results.
    if (i.isFromMessage()) await i.update(view);
    else await i.reply({ ...view, flags: EPHEMERAL });
  }

  /**
   * An open browse list, kept for another 15 minutes from now (its redrawn buttons last as long),
   * and moved to the newest end so the count limit drops lists nobody is using first.
   */
  #useBrowse(token: string): OpenBrowse | null {
    const state = this.#browse.get(token);
    if (!state || state.expires < Date.now()) return null;
    state.expires = Date.now() + 15 * 60_000;
    this.#browse.delete(token);
    this.#browse.set(token, state);
    return state;
  }

  #isPanel(i: Comp): boolean {
    return this.#ctx.guilds.getSettings(i.guildId).panelMessageId === i.message.id;
  }

  /** Next/Previous station within the current station's pack (or favourites order if favourites exist). Skips unplayable entries. */
  async #step(i: Comp, dir: 1 | -1): Promise<void> {
    const ctx = this.#ctx;
    // Access first, exactly as #play checks it (which it does again): a refused click costs no
    // walk through the catalogue.
    const settings = ctx.guilds.getSettings(i.guildId);
    const auth = authContext(ctx, i);
    const target = chooseVoiceChannel(ctx, i.guildId, settings, null, auth.userVoiceChannelId);
    const a = authorize(auth, settings, 'control', target);
    if (!a.ok) return this.#deny(i, a.reason);
    const current =
      ctx.sessions.get(i.guildId)?.stationId ?? ctx.guilds.getIntent(i.guildId)?.desiredStationId ?? null;
    const fav = ctx.guilds.listFavourites(i.guildId);
    let ring: readonly Station[];
    if (fav.length >= 2 && current && fav.includes(current)) {
      // Each favourite looked up by ID: no table of the whole catalogue.
      ring = fav.map((id) => listedStation(ctx, i.guildId, id)).filter((s): s is Station => Boolean(s));
    } else {
      const all = visibleStations(ctx, i.guildId);
      const provider = current ? (ctx.stations.getStation(current)?.provider ?? null) : all[0]?.provider;
      ring = all.filter((s) => s.provider === provider);
    }
    // Walk from the current station and check only until a playable one turns up: checking
    // every station of a big pack first would hold up voice packets.
    const idx = current ? ring.findIndex((s) => s.id === current) : -1;
    const n = ring.length;
    // From outside the ring, Next starts at the first station and Previous at the last.
    const from = idx === -1 ? (dir === 1 ? 0 : n - 1) : idx + dir;
    let next: Station | null = null;
    for (let k = 0; k < (idx === -1 ? n : n - 1) && !next; k++) {
      const s = ring[(((from + k * dir) % n) + n) % n]!;
      if (PLAYABLE.has(ctx.sources.availability(s))) next = s;
    }
    if (!next) return this.#deny(i, 'There is no other playable station to move to.');
    await this.#play(
      i,
      next,
      null,
      (o) => i.editReply(o),
      () => i.deferReply({ flags: EPHEMERAL }),
    );
  }

  /**
   * A button or menu on the settings card. Its argument is "<field>:<screen>": what it changes and
   * the screen to show afterwards (for "go", the screen to open). Cards sent before 1.3 carry the
   * field alone, so it falls back to the page each field used to be on.
   */
  async #configComponent(i: Comp, arg: string): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    const g = i.guildId;
    const cur = this.#ctx.guilds.getSettings(g);
    const [field = '', at] = arg.split(':');
    let screen: SettingsScreen = isSettingsScreen(at) ? at : (LEGACY_SETTINGS_SCREEN[field] ?? 'home');
    let patch: SettingsPatch = {};
    let note = '';
    if ((field === 'station' || field === 'bitrate') && i.isButton()) {
      await i.showModal(
        field === 'station'
          ? this.#stationForm(g, cur, screen)
          : bitrateModal(this.#ctx, g, screen, cur.manualBitrateKbps),
      );
      return;
    }
    if (field === 'panel' && i.isChannelSelectMenu()) return this.#movePanel(i, i.values[0] ?? '');
    if (field === 'unpanel' && i.isButton()) return this.#removePanel(i);
    if (field === 'reset' && i.isButton()) {
      patch = this.#ctx.guilds.defaultSettings();
      note = 'Every setting is back to its default.';
    } else if (i.isChannelSelectMenu()) {
      const ids = [...i.values];
      if (field === 'text') patch = { allowedTextChannelIds: ids };
      else if (field === 'voice') patch = { allowedVoiceChannelIds: ids };
      else if (field === 'pvoice') patch = { preferredVoiceChannelId: ids[0] ?? null };
      else if (field === 'notify') patch = { notificationChannelId: ids[0] ?? null };
    } else if (i.isRoleSelectMenu()) {
      // @everyone is a role too, but making everyone a DJ is what "Anyone" is for.
      if (field === 'djs') patch = { djRoleIds: [...i.values].filter((id) => id !== g) };
    } else if (i.isStringSelectMenu()) {
      const v = i.values[0];
      if (field === 'idle' && (v === '24x7' || v === 'pause_when_empty' || v === 'leave_when_empty'))
        patch = { idleMode: v };
      if (field === 'member' && (v === 'none' || v === 'same_channel' || v === 'any'))
        patch = { memberControlMode: v };
      if (field === 'quality' && (v === 'maximum' || v === 'balanced' || v === 'manual'))
        patch = { qualityMode: v };
      // The one menu that held all three switches, on cards sent before 1.3: ticked is on.
      if (field === 'switches')
        patch = {
          autostart: i.values.includes('autostart'),
          resumeOnRestart: i.values.includes('resume'),
          voiceLock: i.values.includes('lock'),
        };
    } else if (i.isButton()) {
      if (field === 'go') screen = isSettingsScreen(at) ? at : 'home';
      else if (field === 'vstatus') patch = { voiceChannelStatus: !cur.voiceChannelStatus };
      else if (field === 'resume') patch = { resumeOnRestart: !cur.resumeOnRestart };
      else if (field === 'autostart' || field === 'lock') {
        // The card greys these out until they can work; an old card or a stale one may not have.
        const on = field === 'autostart' ? cur.autostart : cur.voiceLock;
        const station = cur.defaultStationId ? listedStation(this.#ctx, g, cur.defaultStationId) : null;
        const missing =
          field === 'autostart' && (!station || !cur.preferredVoiceChannelId)
            ? 'Autostart needs a default station and a preferred voice channel first.'
            : field === 'lock' && !cur.preferredVoiceChannelId
              ? 'Channel lock needs a preferred voice channel first.'
              : null;
        if (!on && missing) note = `⚠️ ${missing}`;
        else patch = field === 'autostart' ? { autostart: !on } : { voiceLock: !on };
      }
    }
    const settings: GuildSettings = Object.keys(patch).length
      ? this.#ctx.guilds.updateSettings(g, patch)
      : cur;
    const restarted =
      ('qualityMode' in patch || 'manualBitrateKbps' in patch) && this.#ctx.sessions.get(g)?.refreshEncoder();
    if ('idleMode' in patch) this.#recheckIdle(i.guild);
    // Manual with no bitrate yet follows the station, so ask for one straight away. The form
    // answers this click, and sending it redraws the card.
    if (field === 'quality' && settings.qualityMode === 'manual' && settings.manualBitrateKbps === null) {
      await i.showModal(bitrateModal(this.#ctx, g, screen, null));
      return;
    }
    // A notice channel the bot can't post in would fail quietly later, so say so when it is chosen.
    // Only when that menu is used, and from the cached channel and member: no request to Discord.
    const me = i.guild.members.me;
    const noticeCh =
      field === 'notify' && settings.notificationChannelId
        ? i.guild.channels.cache.get(settings.notificationChannelId)
        : null;
    const cantPost =
      me &&
      noticeCh &&
      'permissionsFor' in noticeCh &&
      !noticeCh.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
    if (cantPost)
      note = `⚠️ I can’t post in <#${noticeCh.id}> yet. Give me View Channel and Send Messages there.`;
    // The note shows only with the change that caused it; the next change clears it.
    if (restarted) note = note ? `${note} ${REENCODE_NOTE}` : REENCODE_NOTE;
    await this.#showCard(i, settings, screen, note);
  }

  /** A form opened from the settings card: the default station or the manual bitrate. */
  async #configForm(i: Modal, arg: string): Promise<void> {
    const a = this.#auth(i, 'admin');
    if (!a.ok) return this.#deny(i, a.reason);
    const g = i.guildId;
    const [field, at] = arg.split(':');
    const screen: SettingsScreen = isSettingsScreen(at) ? at : 'home';
    const patch: SettingsPatch = {};
    let note = '';
    if (field === 'station') {
      const typed = i.fields.getTextInputValue(STATION_NAME).trim();
      const picked = i.fields.getStringSelectValues(STATION_PICK)[0] ?? null;
      if (typed) {
        // A typed name never guesses (FR-001): several matches are listed, and nothing changes.
        const direct = visibleStation(this.#ctx, g, typed);
        const r = direct
          ? ({ kind: 'match', station: direct } as const)
          : resolveStation(visibleStations(this.#ctx, g), typed);
        const shown = escapeMarkdown(truncate(typed, 60));
        if (r.kind === 'match') patch.defaultStationId = r.station.id;
        else if (r.kind === 'ambiguous') {
          const names = r.candidates.slice(0, 5).map((s) => s.displayName);
          const more = r.candidates.length - names.length;
          note = `⚠️ Several stations match “${shown}”: ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}. Type more of the name, or pick one from the menu.`;
        } else note = `⚠️ No station matches “${shown}”, so the default station is unchanged.`;
      } else if (picked === NO_DEFAULT_STATION) patch.defaultStationId = null;
      else if (picked) {
        const st = visibleStation(this.#ctx, g, picked);
        if (st) patch.defaultStationId = st.id;
        else note = `⚠️ ${GONE}`;
      }
    } else if (field === 'bitrate') {
      const raw = i.fields.getTextInputValue(BITRATE_INPUT).trim();
      const kbps = /^\d{1,3}$/.test(raw) ? Number(raw) : Number.NaN;
      if (kbps >= MANUAL_KBPS_MIN && kbps <= MANUAL_KBPS_MAX) patch.manualBitrateKbps = kbps;
      else
        note = `⚠️ “${escapeMarkdown(truncate(raw, 10))}” isn’t a whole number from ${MANUAL_KBPS_MIN} to ${MANUAL_KBPS_MAX}, so the bitrate is unchanged.`;
    }
    const settings = Object.keys(patch).length
      ? this.#ctx.guilds.updateSettings(g, patch)
      : this.#ctx.guilds.getSettings(g);
    if ('manualBitrateKbps' in patch && this.#ctx.sessions.get(g)?.refreshEncoder()) note = REENCODE_NOTE;
    await this.#showCard(i, settings, screen, note);
  }

  /** The default-station form, its menu led by the current default, what is playing and the favourites. */
  #stationForm(guildId: string, s: GuildSettings, back: SettingsScreen) {
    const ctx = this.#ctx;
    const playing = ctx.sessions.get(guildId)?.stationId ?? null;
    const favourites = ctx.guilds.listFavourites(guildId);
    const fav = new Set(favourites);
    // 24 stations and "No default station": Discord's limit of 25 options.
    const choices = defaultSuggestions(
      ctx,
      guildId,
      visibleStations(ctx, guildId),
      [s.defaultStationId, playing],
      favourites,
      false,
      24,
    );
    return stationModal(ctx, guildId, back, choices, s.defaultStationId, (st) =>
      [
        st.id === s.defaultStationId ? 'the default now' : null,
        st.id === playing ? 'playing now' : null,
        fav.has(st.id) ? 'favourite' : null,
        st.provider === 'custom' ? 'custom' : null,
      ]
        .filter(Boolean)
        .join(' · '),
    );
  }

  /**
   * Shows a settings screen in place of the card that was used. A card from before 1.3 is an
   * embed, and Discord doesn't say that one can become the newer layout, so it gets a new card.
   */
  async #showCard(i: Comp | Modal, s: GuildSettings, screen: SettingsScreen, note = ''): Promise<void> {
    const card = settingsCard(this.#ctx, i.guildId, s, screen, note);
    if (isCard(i.message)) {
      if (i.isMessageComponent()) return void (await i.update(card));
      if (i.isFromMessage()) return void (await i.update(card));
    }
    await i.reply({ ...card, flags: [EPHEMERAL, card.flags] });
  }

  /** "Post it in…" or "Move it to…" on the card's Control panel page. */
  async #movePanel(i: Comp, channelId: string): Promise<void> {
    const channel = i.guild.channels.cache.get(channelId);
    let note: string | null = null;
    if (!channel?.isSendable() || channel.type === ChannelType.GuildVoice)
      note = '⚠️ Pick a text channel for the control panel.';
    else note = this.#panelRefusal(i.guild, channel);
    if (note) return this.#showCard(i, this.#ctx.guilds.getSettings(i.guildId), 'panel', note);
    // Posting takes a request to Discord, so the click is answered first.
    const card = isCard(i.message);
    if (card) await i.deferUpdate();
    else await i.deferReply({ flags: EPHEMERAL });
    const removedOld = await this.#postPanel(i.guild, channel as SendableChannels);
    await i.editReply({
      ...settingsCard(
        this.#ctx,
        i.guildId,
        this.#ctx.guilds.getSettings(i.guildId),
        'panel',
        `Posted in <#${channelId}>.${removedOld ? ' The old panel was deleted.' : ''}`,
      ),
    });
  }

  /** "Remove it" on the card: deletes the control panel message and stops keeping it up to date. */
  async #removePanel(i: Comp): Promise<void> {
    const s = this.#ctx.guilds.getSettings(i.guildId);
    if (!s.panelChannelId || !s.panelMessageId)
      return this.#showCard(i, s, 'panel', 'There is no control panel to remove.');
    if (isCard(i.message)) await i.deferUpdate();
    else await i.deferReply({ flags: EPHEMERAL });
    const ch = i.guild.channels.cache.get(s.panelChannelId);
    // A message that is already gone counts as removed.
    const deleted = ch?.isTextBased()
      ? await ch.messages.delete(s.panelMessageId).then(
          () => true,
          (err: { code?: number }) => err.code === RESTJSONErrorCodes.UnknownMessage,
        )
      : false;
    const settings = this.#ctx.guilds.updateSettings(i.guildId, {
      panelChannelId: null,
      panelMessageId: null,
    });
    this.#panelShown.delete(i.guildId);
    await i.editReply({
      ...settingsCard(
        this.#ctx,
        i.guildId,
        settings,
        'panel',
        deleted
          ? 'The control panel was removed.'
          : `⚠️ The control panel is no longer kept up to date, but I couldn’t delete its message in <#${s.panelChannelId}>. Delete it by hand.`,
      ),
    });
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
    const pending = this.#imports.get(i.guildId);
    if (!pending || pending.token !== token || pending.expires < Date.now()) {
      return this.#deny(i, 'This import preview expired. Run /radio import again.');
    }
    this.#imports.delete(i.guildId);
    if (!apply) {
      await i.update({
        embeds: [infoEmbed('Import cancelled', 'Nothing was changed.', COLOR.neutral)],
        components: [],
      });
      return;
    }
    // Progress at once, and the buttons go: each custom station is checked, which takes a while,
    // and a second click would only find the preview already used.
    await i.update({
      embeds: [
        infoEmbed(
          'Applying import…',
          pending.data.customStations.some((c) => !c.urlRedacted)
            ? 'Settings first, then each custom station is checked before it is added. This can take a minute.'
            : 'Applying the settings.',
          COLOR.neutral,
        ),
      ],
      components: [],
    });
    const channels = new Set(i.guild.channels.cache.keys());
    const roles = new Set(i.guild.roles.cache.keys());
    applyImport(i.guildId, pending.data, this.#ctx.guilds, this.#ctx.stations, channels, roles, (fn) =>
      this.#ctx.db.transaction(fn),
    );
    // Imported quality and idle settings apply to the station already playing, as menu changes do.
    const restarted = this.#ctx.sessions.get(i.guildId)?.refreshEncoder() ?? false;
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
              restarted ? REENCODE_NOTE : '',
              added.length ? `Custom stations added: ${added.join(', ')}` : '',
              failed.length ? `Custom stations not added: ${failed.join(', ')}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
            4000,
          ),
          // Some stations not added: it worked, but needs a look.
          failed.length ? COLOR.warn : COLOR.ok,
        ),
      ],
      components: [],
    });
  }

  #sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.#browse) if (v.expires < now) this.#browse.delete(k);
    for (const [k, v] of this.#imports) if (v.expires < now) this.#imports.delete(k);
    // Bounded by count as well as time: a burst of /radio browse keeps only the newest lists
    // (a Map iterates oldest first). An older list's buttons then say it has expired.
    for (const k of this.#browse.keys()) {
      if (this.#browse.size <= MAX_BROWSE_LISTS) break;
      this.#browse.delete(k);
    }
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
