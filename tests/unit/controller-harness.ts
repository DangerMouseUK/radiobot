/**
 * A fake Discord and a fake set of voice sessions for driving RadioController in tests. Shared by
 * tests/unit/controller*.test.ts and tests/integration/main-thread-budget.test.ts. Nothing here touches the network, Discord or real stations.
 */
import { createHmac } from 'node:crypto';
import {
  type APIEmbed,
  ChannelType,
  GuildMember,
  type Interaction,
  MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import { ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import type { LibraryIndex } from '../../src/catalogue/pack-library.ts';
import { discoverPackDirs, loadPack, seedPacks } from '../../src/catalogue/packs.ts';
import type { SyncReport } from '../../src/catalogue/sync.ts';
import type { Station } from '../../src/catalogue/types.ts';
import { loadConfig } from '../../src/config/env.ts';
import { ComponentIds } from '../../src/discord/components/custom-id.ts';
import { type AppContext, RateLimits } from '../../src/discord/context.ts';
import { RadioController } from '../../src/discord/controller.ts';
import { EventLoopMonitor } from '../../src/observability/event-loop.ts';
import { Metrics } from '../../src/observability/metrics.ts';
import { RadioError } from '../../src/shared/errors.ts';
import { FullSourceCheck } from '../../src/streams/full-check.ts';
import type { probeSource } from '../../src/streams/probe.ts';
import { SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import { SourceService } from '../../src/streams/source-service.ts';
import { UrlPolicy } from '../../src/streams/url-policy.ts';
import type { SessionStatus } from '../../src/voice/session.ts';
import { demoRegistry, memoryDb, silentLogger } from '../helpers.ts';

export const GUILD = '123456789012345678';
export const OTHER_GUILD = '223456789012345678';
export const OWNER = '900000000000000001';
export const ADMIN = '900000000000000002';
export const MEMBER = '900000000000000003';
export const DJ = '900000000000000004';
export const TEXT = '800000000000000001';
export const OTHER_TEXT = '800000000000000002';
export const V1 = '700000000000000001';
export const V2 = '700000000000000002';
export const DJ_ROLE = '600000000000000001';

// ------------------------------------------------------------------ fakes

export interface Actor {
  id: string;
  admin?: boolean;
  voice?: string | null;
  /** Role IDs the member has (makes the interaction's member a GuildMember). */
  roles?: string[];
}

/** Stands in for one guild's voice session: records what the controller asks of it. */
export class FakeSession {
  connected = false;
  channelId: string | null = null;
  stationId: string | null = null;
  readonly joins: string[] = [];
  readonly leaves: string[] = [];
  readonly listenerCounts: number[] = [];
  stops = 0;
  encoderRefreshes = 0;
  /** The source playing now, and every source a listener switched to. */
  playingSourceId: string | null = null;
  readonly usedSources: string[] = [];
  desiredState = 'playing';
  /** When set, status() returns this full status instead of the minimal one. */
  fullStatus: Partial<SessionStatus> | null = null;
  /** What liveStats() returns. */
  live: unknown = null;
  /** What useSource() answers. */
  useSourceResult = { ok: true, code: null as string | null, message: 'Playing.' };
  status() {
    if (this.fullStatus) {
      return {
        state: 'PLAYING',
        desiredState: this.desiredState,
        stationId: this.stationId,
        channelId: this.channelId,
        source: null,
        selection: null,
        plan: null,
        nowPlaying: null,
        lastError: null,
        failovers: 0,
        reconnects: 0,
        encoderPid: null,
        ffmpegWarnings: [],
        manualSourceId: null,
        observedInputKbps: null,
        observedOutputKbps: null,
        encryption: null,
        inputTransport: null,
        hls: null,
        ...this.fullStatus,
      };
    }
    return this.playingSourceId
      ? {
          source: { id: this.playingSourceId },
          manualSourceId: this.usedSources.at(-1) ?? null,
          desiredState: this.desiredState,
        }
      : null;
  }
  async useSource(_stationId: string, id: string) {
    this.usedSources.push(id);
    if (this.useSourceResult.ok) this.playingSourceId = id;
    return this.useSourceResult;
  }
  liveStats() {
    return this.live;
  }
  /** Admins who opened `/radio stats` (each open or Refresh), and who pressed its Close. */
  readonly reportOpens: string[] = [];
  readonly reportCloses: string[] = [];
  /** What receiverReport() answers. */
  report: unknown = { state: 'waiting' };
  openReports(viewer: string) {
    this.reportOpens.push(viewer);
  }
  closeReports(viewer: string) {
    this.reportCloses.push(viewer);
  }
  async receiverReport() {
    return this.report;
  }
  stop() {
    this.stops++;
  }
  leave(reason: string) {
    this.leaves.push(reason);
  }
  async join(channelId: string) {
    this.joins.push(channelId);
    this.connected = true;
    this.channelId = channelId;
  }
  /** Whether a quality change re-encodes (and so briefly restarts) the stream. */
  reencodes = true;
  refreshEncoder() {
    this.encoderRefreshes++;
    return this.reencodes;
  }
  onListenersChanged(n: number) {
    this.listenerCounts.push(n);
  }
}

export interface PlayResult {
  ok: boolean;
  code: string | null;
  message: string;
  retrying?: boolean;
  selection: { eligibility: Array<{ sourceId: string; eligible: boolean; reasons: string[] }> } | null;
  plan: null;
}

export class FakeSessions {
  readonly map = new Map<string, FakeSession>();
  readonly plays: Array<{ guildId: string; stationId: string; channelId: string }> = [];
  /** Who asked for each play, in the same order. */
  readonly requestedBy: Array<string | undefined> = [];
  /** What the next play() answers; null means success. */
  nextResult: Partial<PlayResult> | null = null;
  #requests = 0;
  readonly #onPlay: (guildId: string, stationId: string, channelId: string, at: string) => void;
  constructor(onPlay: (guildId: string, stationId: string, channelId: string, at: string) => void) {
    this.#onPlay = onPlay;
  }
  get(guildId: string) {
    return this.map.get(guildId) ?? null;
  }
  ensure(guildId: string) {
    let s = this.map.get(guildId);
    if (!s) {
      s = new FakeSession();
      this.map.set(guildId, s);
    }
    return s;
  }
  async play(guildId: string, stationId: string, channelId: string, userId?: string): Promise<PlayResult> {
    this.plays.push({ guildId, stationId, channelId });
    this.requestedBy.push(userId);
    const result = {
      ok: true,
      code: null,
      message: 'Playing.',
      selection: null,
      plan: null,
      ...this.nextResult,
    };
    this.nextResult = null;
    // Like the real session manager, a play request records the server's intent.
    this.#onPlay(
      guildId,
      stationId,
      channelId,
      new Date(Date.UTC(2026, 0, 1) + ++this.#requests).toISOString(),
    );
    const s = this.ensure(guildId);
    Object.assign(s, { connected: true, channelId, stationId });
    return result;
  }
  activeStreams() {
    return 0;
  }
}

/** A text channel the bot can post to, as discord.js shows it. */
export class FakeTextChannel {
  readonly type: ChannelType;
  readonly sent: unknown[] = [];
  readonly edits: Array<{ id: string; view: unknown }> = [];
  readonly deleted: string[] = [];
  /** Whether the bot has View Channel and Send Messages here. */
  canSend = true;
  /** Other permissions the bot lacks here (Embed Links, say). */
  readonly lacks = new Set<bigint>();
  /** An error code to throw from messages.edit (10008 = unknown message). */
  editError: number | null = null;
  /** An error code to throw from messages.delete (10008 = unknown message, 50013 = missing access). */
  deleteError: number | null = null;
  readonly id: string;
  readonly messages = {
    edit: async (id: string, view: unknown) => {
      if (this.editError !== null) throw Object.assign(new Error('edit failed'), { code: this.editError });
      this.edits.push({ id, view });
    },
    delete: async (id: string) => {
      if (this.deleteError !== null)
        throw Object.assign(new Error('delete failed'), { code: this.deleteError });
      this.deleted.push(id);
    },
  };
  constructor(id: string, type: ChannelType = ChannelType.GuildText) {
    this.id = id;
    this.type = type;
  }
  isSendable() {
    return true;
  }
  isTextBased() {
    return true;
  }
  permissionsFor() {
    return {
      has: (p: bigint | bigint[]) => this.canSend && ![p].flat().some((x) => this.lacks.has(x)),
    };
  }
  async send(p: unknown) {
    this.sent.push(p);
    return { id: `5000000000000000${String(this.sent.length).padStart(2, '0')}` };
  }
}

export interface FakeGuild {
  id: string;
  ownerId: string;
  voiceStates: { cache: Map<string, { channelId: string | null; member?: { user: { bot: boolean } } }> };
  channels: { cache: Map<string, unknown> };
  roles: { cache: Map<string, unknown> };
  members: { me: unknown };
}

type Payload = Record<string, unknown> & { embeds?: Array<{ toJSON(): APIEmbed }>; components?: unknown[] };

/** A GuildMember with the given roles, without a real client behind it. */
function memberWithRoles(roles: string[]): GuildMember {
  const m = Object.create(GuildMember.prototype) as GuildMember;
  Object.defineProperty(m, 'roles', { value: { cache: new Map(roles.map((r) => [r, { id: r }])) } });
  return m;
}

/**
 * The parts of a discord.js interaction the controller uses. Acknowledging twice is recorded as a
 * violation (and throws, as discord.js does), because the controller's error handler would
 * otherwise swallow it.
 */
export class FakeInteraction {
  replied = false;
  deferred = false;
  readonly calls: Array<{ method: string; payload: Payload }> = [];
  readonly violations: string[] = [];
  readonly guildId = GUILD;
  readonly user: { id: string; bot: boolean };
  readonly member: unknown;
  readonly memberPermissions: { has(p: bigint): boolean };
  readonly guild: FakeGuild;
  /** The message a button or form belongs to; `card`: sent in Discord's newer layout (Components V2). */
  readonly message: { id: string; flags: { has(flag: number): boolean } } | null;
  readonly type = 2;
  readonly channelId: string;

  constructor(
    actor: Actor,
    guild: FakeGuild,
    channelId: string = TEXT,
    messageId: string | null = 'message-1',
    card = true,
  ) {
    this.channelId = channelId;
    this.message =
      messageId === null
        ? null
        : { id: messageId, flags: { has: (f: number) => card && f === MessageFlags.IsComponentsV2 } };
    this.user = { id: actor.id, bot: false };
    this.member = actor.roles ? memberWithRoles(actor.roles) : {};
    this.memberPermissions = { has: (p) => Boolean(actor.admin) && p === PermissionFlagsBits.Administrator };
    this.guild = guild;
  }

  get channel(): unknown {
    return this.guild.channels.cache.get(this.channelId) ?? null;
  }

  inCachedGuild() {
    return true;
  }
  isRepliable() {
    return true;
  }
  isAutocomplete() {
    return false;
  }

  #ack(method: string, payload: Payload = {}, kind: 'reply' | 'defer') {
    if (this.replied || this.deferred) {
      this.violations.push(`${method} after the interaction was already acknowledged`);
      throw new Error('InteractionAlreadyReplied');
    }
    if (kind === 'reply') this.replied = true;
    else this.deferred = true;
    this.calls.push({ method, payload });
  }
  #follow(method: string, payload: Payload = {}) {
    if (!this.replied && !this.deferred) {
      this.violations.push(`${method} before the interaction was acknowledged`);
      throw new Error('InteractionNotReplied');
    }
    this.calls.push({ method, payload });
  }
  async reply(p: Payload) {
    this.#ack('reply', p, 'reply');
  }
  async deferReply(p: Payload = {}) {
    this.#ack('deferReply', p, 'defer');
  }
  async update(p: Payload) {
    this.#ack('update', p, 'reply');
  }
  async deferUpdate() {
    this.#ack('deferUpdate', {}, 'defer');
  }
  async editReply(p: Payload) {
    this.#follow('editReply', p);
  }
  async followUp(p: Payload) {
    this.#follow('followUp', p);
  }
  async deleteReply() {
    this.#follow('deleteReply');
  }
  /** Opening a form answers a button, so it counts as the acknowledgement. */
  async showModal(m: { toJSON(): unknown }) {
    this.#ack('showModal', { modal: m.toJSON() } as Payload, 'reply');
  }
  isModalSubmit() {
    return false;
  }

  /** Number of acknowledgements (reply, deferReply, update, deferUpdate, showModal). */
  get acks(): number {
    return this.calls.filter((c) =>
      ['reply', 'deferReply', 'update', 'deferUpdate', 'showModal'].includes(c.method),
    ).length;
  }
  /** Was the first acknowledgement private? */
  get ephemeral(): boolean {
    const first = this.calls[0]?.payload.flags;
    // A card is sent with two flags: private, and the newer layout.
    return Array.isArray(first) ? first.includes(MessageFlags.Ephemeral) : first === MessageFlags.Ephemeral;
  }
  /** Titles, descriptions and fields of every embed sent, and the text of every card, as one string. */
  get text(): string {
    return this.calls
      .flatMap((c) => [
        String(c.payload.content ?? ''),
        ...(c.payload.embeds ?? []).map((e) => embedText(e.toJSON())),
        ...cardTexts(c.payload),
      ])
      .join('\n');
  }
  /** The text of the last payload that had embeds or was a card. */
  get lastText(): string {
    const last = [...this.calls]
      .reverse()
      .find((c) => (c.payload.embeds ?? []).length > 0 || cardTexts(c.payload).length > 0);
    if (!last) return '';
    return [
      ...(last.payload.embeds ?? []).map((e) => embedText(e.toJSON())),
      ...cardTexts(last.payload),
    ].join('\n');
  }
  /** Every button and menu of the last card sent (Components V2), however deeply it is nested. */
  get cardControls(): CardControl[] {
    const last = [...this.calls].reverse().find((c) => cardTexts(c.payload).length > 0);
    return last ? cardControls(last.payload) : [];
  }
  /** The rows of the last payload that had components, as Discord receives them (style, label…). */
  get componentRows(): Array<Array<{ custom_id?: string; style?: number; label?: string; type: number }>> {
    const last = [...this.calls].reverse().find((c) => (c.payload.components ?? []).length > 0);
    return (last?.payload.components ?? []).map(
      (row) =>
        (
          row as {
            toJSON(): {
              components: Array<{ custom_id?: string; style?: number; label?: string; type: number }>;
            };
          }
        ).toJSON().components ?? [],
    );
  }
  /** custom_id of every component in the last payload that had components. */
  get componentIds(): string[] {
    const last = [...this.calls].reverse().find((c) => (c.payload.components ?? []).length > 0);
    return (last?.payload.components ?? []).flatMap((row) =>
      ((row as { toJSON(): { components: Array<{ custom_id?: string }> } }).toJSON().components ?? []).map(
        (c) => String(c.custom_id),
      ),
    );
  }
}

/** A button or menu on a card, as Discord receives it. */
export interface CardControl {
  type: number;
  custom_id?: string;
  style?: number;
  label?: string;
  disabled?: boolean;
  placeholder?: string;
  options?: Array<{ value: string; label: string; description?: string; default?: boolean }>;
}

/** A payload's components as Discord receives them. */
function componentJson(p: Payload): unknown[] {
  return (p.components ?? []).map((c) =>
    typeof (c as { toJSON?: unknown }).toJSON === 'function' ? (c as { toJSON(): unknown }).toJSON() : c,
  );
}

/** Calls `visit` on every component of a payload, nested ones included. */
function walk(nodes: unknown[], visit: (n: Record<string, unknown>) => void): void {
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    const node = n as Record<string, unknown>;
    visit(node);
    if (Array.isArray(node.components)) walk(node.components, visit);
    if (node.accessory) walk([node.accessory], visit);
  }
}

/** The text displays of a card (Components V2), in order; none for an embed message. */
export function cardTexts(p: Payload): string[] {
  const out: string[] = [];
  walk(componentJson(p), (n) => {
    if (n.type === 10 && typeof n.content === 'string') out.push(n.content);
  });
  return out;
}

/** Every button (type 2) and menu (3, 5–8) of a card. */
export function cardControls(p: Payload): CardControl[] {
  const out: CardControl[] = [];
  walk(componentJson(p), (n) => {
    if (n.type === 2 || n.type === 3 || (typeof n.type === 'number' && n.type >= 5 && n.type <= 8))
      out.push(n as unknown as CardControl);
  });
  return out;
}

/** Title, description, fields and footer of an embed, as one string. */
export function embedText(j: APIEmbed): string {
  return [j.title, j.description, ...(j.fields ?? []).flatMap((f) => [f.name, f.value]), j.footer?.text]
    .filter((x) => x !== undefined)
    .join('\n');
}

export interface CommandSpec {
  sub: string;
  group?: string | null;
  strings?: Record<string, string | null>;
  channel?: string | null;
  ints?: Record<string, number | null>;
  bools?: Record<string, boolean | null>;
  attachment?: { size: number; url: string };
}

export class FakeCommand extends FakeInteraction {
  readonly commandName = 'radio';
  readonly options: Record<string, unknown>;
  constructor(actor: Actor, guild: FakeGuild, spec: CommandSpec, channelId?: string) {
    super(actor, guild, channelId);
    const str = (n: string, required = false) => {
      const v = spec.strings?.[n] ?? null;
      if (required && v === null) throw new Error(`missing required option ${n}`);
      return v;
    };
    this.options = {
      getSubcommand: () => spec.sub,
      getSubcommandGroup: () => spec.group ?? null,
      getString: str,
      getChannel: (n: string) =>
        n === 'channel' && spec.channel
          ? (guild.channels.cache.get(spec.channel) ?? { id: spec.channel })
          : null,
      getInteger: (n: string) => spec.ints?.[n] ?? null,
      getBoolean: (n: string) => spec.bools?.[n] ?? null,
      getAttachment: () => spec.attachment ?? null,
    };
  }
  isChatInputCommand() {
    return true;
  }
  isMessageComponent() {
    return false;
  }
}

export type ComponentKind = 'button' | 'string' | 'channel' | 'role';

export class FakeComponent extends FakeInteraction {
  readonly customId: string;
  readonly kind: ComponentKind;
  readonly values: string[];
  constructor(
    actor: Actor,
    guild: FakeGuild,
    customId: string,
    kind: ComponentKind = 'button',
    values: string[] = [],
    messageId?: string,
    card = true,
  ) {
    super(actor, guild, TEXT, messageId, card);
    this.customId = customId;
    this.kind = kind;
    this.values = values;
  }
  isChatInputCommand() {
    return false;
  }
  isMessageComponent() {
    return true;
  }
  isButton() {
    return this.kind === 'button';
  }
  isStringSelectMenu() {
    return this.kind === 'string';
  }
  isChannelSelectMenu() {
    return this.kind === 'channel';
  }
  isRoleSelectMenu() {
    return this.kind === 'role';
  }
}

/** A submitted form (modal), with what was typed into each text box and chosen in each menu. */
export class FakeModal extends FakeInteraction {
  readonly customId: string;
  readonly fields: {
    getTextInputValue(id: string): string;
    getStringSelectValues(id: string): readonly string[];
  };
  readonly #fromMessage: boolean;
  constructor(
    actor: Actor,
    guild: FakeGuild,
    customId: string,
    values: Record<string, string>,
    fromMessage = true,
    selects: Record<string, string[]> = {},
  ) {
    super(actor, guild, TEXT, fromMessage ? 'message-1' : null);
    this.customId = customId;
    this.#fromMessage = fromMessage;
    this.fields = {
      getTextInputValue: (id: string) => {
        const v = values[id];
        if (v === undefined) throw new Error(`no text box ${id}`);
        return v;
      },
      getStringSelectValues: (id: string) => {
        const v = selects[id];
        if (v === undefined) throw new Error(`no menu ${id}`);
        return v;
      },
    };
  }
  isChatInputCommand() {
    return false;
  }
  isMessageComponent() {
    return false;
  }
  override isModalSubmit() {
    return true;
  }
  isFromMessage() {
    return this.#fromMessage;
  }
}

/** A successful stream check, as CustomStationService.add reports it. */
export const CHECKED = {
  success: true,
  codec: 'mp3',
  profile: null,
  measuredBitrateKbps: 128,
  codecBitrateKbps: 128,
  sampleRateHz: 44_100,
  channels: 2,
  transport: 'http-continuous',
};

// ------------------------------------------------------------------ context

export interface SetupOptions {
  /** Switch the demo fixture pack off, leaving only custom stations visible. */
  customOnly?: boolean;
  /** OPERATOR_USER_IDS for the installation. */
  operators?: string[];
  /** A folder of extra station packs (EXTRA_PACKS_DIR), loaded and switched on alongside the demo pack. */
  extraPacksDir?: string;
}

export function setup(opts: SetupOptions = {}) {
  const repos = memoryDb();
  const extra = opts.extraPacksDir ?? null;
  const extraIds = extra ? discoverPackDirs(extra).map((d) => loadPack(d, 'extra').meta.id) : [];
  const packs = demoRegistry(extra, {
    enabled: new Set(extraIds),
    disabled: new Set(opts.customOnly ? ['demo'] : []),
  });
  seedPacks(repos.stations, packs);
  const metrics = new Metrics();
  const probe = {
    impl: (async () => {
      throw new Error('no probing in controller tests');
    }) as typeof probeSource,
  };
  const sources = new SourceService({
    stations: repos.stations,
    guilds: repos.guilds,
    client: new SafeHttpClient(new UrlPolicy({ allowInsecureHttp: true })),
    registry: new ProcessRegistry(),
    ffmpegPath: 'ffmpeg',
    ffprobePath: 'ffprobe',
    maxConcurrentProbes: 1,
    logger: silentLogger(),
    metrics,
    // A probe must never reach a stream host from a test, not even a made-up one. Tests that
    // need a check's result (the full re-check) put a fake one in `probe.impl`.
    probeImpl: (...args) => probe.impl(...args),
  });
  const probes: string[] = [];
  /** What a re-probe reports, and the progress it announces on the way. */
  const rescan = {
    reports: [] as unknown[],
    progress: [] as Array<[number, number]>,
  };
  // Any path that would really probe a stream records it instead.
  (
    sources as unknown as {
      rescanStation(
        id: string,
        signal?: AbortSignal,
        onProgress?: (done: number, total: number) => void,
      ): Promise<unknown[]>;
    }
  ).rescanStation = async (id, _signal, onProgress) => {
    probes.push(id);
    for (const [done, total] of rescan.progress) onProgress?.(done, total);
    return rescan.reports;
  };
  /** What the audio comparison answers: results, or an error to throw. */
  const compare = { results: [] as unknown[], error: null as unknown, calls: [] as string[] };
  (sources as unknown as { deepVerify(g: string, id: string): Promise<unknown[]> }).deepVerify = async (
    _g,
    id,
  ) => {
    compare.calls.push(id);
    if (compare.error) throw compare.error;
    return compare.results;
  };
  const sessions = new FakeSessions((guildId, stationId, channelId, at) =>
    repos.guilds.setIntent(guildId, {
      desiredState: 'playing',
      desiredStationId: stationId,
      desiredVoiceChannelId: channelId,
      lastRequestedAt: at,
    }),
  );
  const fullCheck = new FullSourceCheck({
    stations: repos.stations,
    sources,
    packEnabled: (provider) => packs.isEnabled(provider),
    playing: (id) => [...sessions.map.values()].some((s) => s.playingSourceId === id),
    logger: silentLogger(),
  });
  const customAdds: string[] = [];
  const customEdits: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const customRemoves: string[] = [];
  /** Names whose add fails with this error. */
  const customFailures = new Map<string, Error>();
  const custom = {
    report: { outcome: CHECKED } as unknown,
    removeResult: true,
  };
  let importText = '';
  const sync = {
    syncable: [] as string[],
    reports: new Map<string, Partial<SyncReport>>(),
    calls: [] as string[],
  };
  // Stands in for PackManager: the official library's index, and what was installed or removed.
  const packLibrary = {
    index: null as LibraryIndex | null,
    installs: [] as string[],
    removes: [] as string[],
    failure: null as Error | null,
    updates: new Map<string, string>(),
    notices: [] as string[],
    canInstall: true,
  };
  const packManager = {
    get canInstall() {
      return packLibrary.canInstall;
    },
    updates: packLibrary.updates,
    notices: packLibrary.notices,
    cachedIndex: () => packLibrary.index,
    index: async () => {
      if (!packLibrary.index)
        throw new RadioError('HTTP_TIMEOUT', 'The pack library took too long to answer.');
      return packLibrary.index;
    },
    install: async (id: string) => {
      if (packLibrary.failure) throw packLibrary.failure;
      packLibrary.installs.push(id);
      const entry = packLibrary.index?.packs.find((p) => p.id === id);
      return {
        id,
        name: entry?.name ?? id,
        version: entry?.version ?? null,
        previousVersion: null,
        stations: entry?.stations ?? 0,
      };
    },
    remove: async (id: string) => {
      packLibrary.removes.push(id);
      return true;
    },
  };
  const clientChannels = new Map<string, unknown>();
  const ids = new ComponentIds('test-secret');
  const voice = new Map<string, { channelId: string | null; member?: { user: { bot: boolean } } }>();
  const guild: FakeGuild = {
    id: GUILD,
    ownerId: OWNER,
    voiceStates: { cache: voice },
    channels: { cache: new Map() },
    roles: { cache: new Map() },
    members: { me: null },
  };
  const syncReport = (packId: string): SyncReport => ({
    packId,
    packName: packs.get(packId)?.meta.name ?? packId,
    ok: true,
    checkedAt: new Date().toISOString(),
    error: null,
    officialCount: 0,
    added: [],
    renamed: [],
    missing: [],
    returned: [],
    unchanged: 0,
    needsSourceMapping: [],
    unreachable: [],
    ...sync.reports.get(packId),
  });
  const ctx = {
    config: loadConfig({
      DISCORD_TOKEN: 'x'.repeat(30),
      DISCORD_APPLICATION_ID: GUILD,
      OPERATOR_USER_IDS: (opts.operators ?? []).join(','),
    }),
    client: {
      channels: {
        cache: clientChannels,
        fetch: async (id: string) => {
          const ch = clientChannels.get(id);
          if (ch instanceof Error) throw ch;
          return ch ?? null;
        },
      },
      ws: { ping: -1 },
      application: null,
    },
    logger: silentLogger(),
    metrics,
    db: repos.db,
    stations: repos.stations,
    guilds: repos.guilds,
    meta: repos.meta,
    http: {
      userAgent: 'Lavf/61.7.100',
      fetchText: async () => ({ text: importText }),
    },
    policy: new UrlPolicy({ allowInsecureHttp: true }),
    registry: new ProcessRegistry(),
    sources,
    fullCheck,
    sessions,
    packs,
    packManager,
    catalogueSync: {
      syncablePacks: () => sync.syncable.map((id) => packs.get(id)!),
      lastSync: () => ({ at: null, ok: true }),
      isStale: () => false,
      sync: async (packId: string) => {
        sync.calls.push(packId);
        return syncReport(packId);
      },
      syncAll: async () => {
        sync.calls.push('*');
        return sync.syncable.map(syncReport);
      },
    },
    custom: {
      // Stands in for CustomStationService.add (which would probe the URL): it saves the station
      // with its stream, as the real one does once the check passes.
      add: async (_guildId: string, _userId: string, c: { name: string }) => {
        const failure = customFailures.get(c.name);
        if (failure) throw failure;
        customAdds.push(c.name);
        return { station: addCustomStation(c.name), report: custom.report };
      },
      edit: async (_guildId: string, id: string, patch: Record<string, unknown>) => {
        customEdits.push({ id, patch });
        const st = repos.stations.getStation(id) as Station;
        return { station: { ...st, displayName: (patch.name as string | undefined) ?? st.displayName } };
      },
      remove: (_guildId: string, id: string) => {
        customRemoves.push(id);
        return custom.removeResult;
      },
    },
    ids,
    notifier: {},
    limits: new RateLimits(),
    eventLoop: new EventLoopMonitor(),
    startedAt: new Date(),
    ffmpegInfo: null,
  } as unknown as AppContext;
  const controller = new RadioController(ctx);
  const people = {
    owner: { id: OWNER } as Actor,
    admin: { id: ADMIN, admin: true } as Actor,
    member: { id: MEMBER } as Actor,
    dj: { id: DJ, roles: [DJ_ROLE] } as Actor,
  };
  const putInVoice = (actor: Actor, channelId: string | null) => voice.set(actor.id, { channelId });

  const run = async <T extends FakeInteraction>(i: T): Promise<T> => {
    await controller.handle(i as unknown as Interaction);
    return i;
  };

  /** A custom station of this server, optionally with one (not yet checked) source. */
  const addCustomStation = (name: string, withSource = true): Station => {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    repos.stations.insertCustomStation({
      id: `custom:${slug}`,
      guildId: GUILD,
      slug,
      displayName: name,
      description: null,
      category: null,
      websiteUrl: null,
      language: null,
      createdById: OWNER,
    });
    if (withSource) {
      repos.stations.insertSource({
        id: `custom-${slug}-1`,
        stationId: `custom:${slug}`,
        url: `https://radio.example.org/${slug}`,
        label: 'Main stream',
        priority: 10,
        transportHint: 'http-continuous',
        codecHint: 'mp3',
        provenance: 'curated',
        provenanceDetail: null,
        rightsStatus: 'unreviewed',
      });
    }
    return repos.stations.getStation(`custom:${slug}`)!;
  };

  /** A text channel in this server that the bot can see (and fetch, for the control panel). */
  const textChannel = (id: string, type: ChannelType = ChannelType.GuildText) => {
    const ch = new FakeTextChannel(id, type);
    guild.channels.cache.set(id, ch);
    clientChannels.set(id, ch);
    return ch;
  };

  return {
    ...repos,
    ctx,
    controller,
    ids,
    sessions,
    probes,
    probe,
    fullCheck,
    rescan,
    compare,
    sync,
    packLibrary,
    custom,
    customAdds,
    customEdits,
    customRemoves,
    customFailures,
    clientChannels,
    guild,
    people,
    putInVoice,
    metrics,
    addCustomStation,
    textChannel,
    setImport: (text: string) => {
      importText = text;
    },
    command: (actor: Actor, spec: CommandSpec, channelId?: string) =>
      run(new FakeCommand(actor, guild, spec, channelId)),
    click: (
      actor: Actor,
      customId: string,
      kind: ComponentKind = 'button',
      values: string[] = [],
      messageId?: string,
      card = true,
    ) => run(new FakeComponent(actor, guild, customId, kind, values, messageId, card)),
    submit: (
      actor: Actor,
      customId: string,
      values: Record<string, string>,
      fromMessage = true,
      selects: Record<string, string[]> = {},
    ) => run(new FakeModal(actor, guild, customId, values, fromMessage, selects)),
    run,
  };
}

export type Harness = ReturnType<typeof setup>;

/** The action and argument a signed custom ID carries, or null if it is invalid or expired. */
export function decode(ids: ComponentIds, customId: string): { action: string; arg: string } | null {
  const p = ids.parse(GUILD, customId);
  return p && !p.expired ? { action: p.action, arg: p.arg } : null;
}

/**
 * A correctly signed custom ID for any action, even one this version no longer makes (as a button
 * posted by an older version would carry). Mirrors the format in custom-id.ts.
 */
export function signedId(guildId: string, action: string, arg = '', secret = 'test-secret'): string {
  const body = `rb2:${action}:${arg.replace(':', '.')}:0`;
  const sig = createHmac('sha256', secret).update(`${guildId}|${body}`).digest('base64url').slice(0, 16);
  return `${body}:${sig}`;
}

export const internalIncidents = (metrics: Metrics) =>
  metrics.recentIncidents(GUILD, 50).filter((x) => x.code === 'INTERNAL');

/** Who asks for suggestions, where, and in which subcommand group (the server owner, by default). */
export interface SuggestFrom {
  actor?: Actor;
  channelId?: string;
  group?: string | null;
}

/** A suggestion request, as Discord sends one while someone types in an option. */
export async function suggest(
  t: Harness,
  sub: string,
  option: string,
  value = '',
  strings: Record<string, string | null> = {},
  from: SuggestFrom = {},
): Promise<Array<{ name: string; value: string }>> {
  let answer: Array<{ name: string; value: string }> = [];
  const actor = from.actor ?? t.people.owner;
  const i = {
    guildId: GUILD,
    guild: t.guild,
    channelId: from.channelId ?? TEXT,
    user: { id: actor.id, bot: false },
    member: actor.roles ? memberWithRoles(actor.roles) : {},
    memberPermissions: {
      has: (p: bigint) => Boolean(actor.admin) && p === PermissionFlagsBits.Administrator,
    },
    inCachedGuild: () => true,
    isRepliable: () => false,
    isAutocomplete: () => true,
    isChatInputCommand: () => false,
    isMessageComponent: () => false,
    isButton: () => false,
    commandName: 'radio',
    options: {
      getFocused: () => ({ name: option, value }),
      getSubcommand: () => sub,
      getSubcommandGroup: () => from.group ?? null,
      getString: (n: string) => strings[n] ?? null,
    },
    respond: async (choices: typeof answer) => {
      answer = choices;
    },
  };
  await t.controller.handle(i as unknown as Interaction);
  return answer;
}
