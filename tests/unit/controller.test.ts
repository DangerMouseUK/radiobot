import { type APIEmbed, type Interaction, MessageFlags, PermissionFlagsBits } from 'discord.js';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import { PackRegistry, seedPacks } from '../../src/catalogue/packs.ts';
import type { Station } from '../../src/catalogue/types.ts';
import { loadConfig } from '../../src/config/env.ts';
import { ComponentIds } from '../../src/discord/components/custom-id.ts';
import { type AppContext, RateLimits } from '../../src/discord/context.ts';
import { describeInteraction, RadioController } from '../../src/discord/controller.ts';
import { exportGuild } from '../../src/import-export/config-io.ts';
import { EventLoopMonitor } from '../../src/observability/event-loop.ts';
import { Metrics } from '../../src/observability/metrics.ts';
import { SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import { SourceService } from '../../src/streams/source-service.ts';
import { UrlPolicy } from '../../src/streams/url-policy.ts';
import { memoryDb, silentLogger } from '../helpers.ts';

const GUILD = '123456789012345678';
const OTHER_GUILD = '223456789012345678';
const OWNER = '900000000000000001';
const ADMIN = '900000000000000002';
const MEMBER = '900000000000000003';
const TEXT = '800000000000000001';
const OTHER_TEXT = '800000000000000002';
const V1 = '700000000000000001';
const V2 = '700000000000000002';

// ------------------------------------------------------------------ fakes

interface Actor {
  id: string;
  admin?: boolean;
  voice?: string | null;
}

/** Stands in for one guild's voice session: records what the controller asks of it. */
class FakeSession {
  connected = false;
  channelId: string | null = null;
  stationId: string | null = null;
  readonly joins: string[] = [];
  stops = 0;
  /** The source playing now, and every source a listener switched to. */
  playingSourceId: string | null = null;
  readonly usedSources: string[] = [];
  desiredState = 'playing';
  status() {
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
    this.playingSourceId = id;
    return { ok: true, code: null, message: 'Playing.' };
  }
  liveStats() {
    return null;
  }
  stop() {
    this.stops++;
  }
  leave() {}
  async join(channelId: string) {
    this.joins.push(channelId);
    this.connected = true;
    this.channelId = channelId;
  }
  refreshEncoder() {}
  onListenersChanged() {}
}

class FakeSessions {
  readonly map = new Map<string, FakeSession>();
  readonly plays: Array<{ guildId: string; stationId: string; channelId: string }> = [];
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
  async play(guildId: string, stationId: string, channelId: string) {
    this.plays.push({ guildId, stationId, channelId });
    const s = this.ensure(guildId);
    Object.assign(s, { connected: true, channelId, stationId });
    return { ok: true, code: null, message: 'Playing.', selection: null, plan: null };
  }
  activeStreams() {
    return 0;
  }
}

type Payload = Record<string, unknown> & { embeds?: Array<{ toJSON(): APIEmbed }>; components?: unknown[] };

/**
 * The parts of a discord.js interaction the controller uses. Acknowledging twice is recorded as a
 * violation (and throws, as discord.js does), because the controller's error handler would
 * otherwise swallow it.
 */
class FakeInteraction {
  replied = false;
  deferred = false;
  readonly calls: Array<{ method: string; payload: Payload }> = [];
  readonly violations: string[] = [];
  readonly guildId = GUILD;
  readonly user: { id: string; bot: boolean };
  readonly member = {};
  readonly memberPermissions: { has(p: bigint): boolean };
  readonly guild: unknown;
  readonly message = { id: 'message-1' };
  readonly type = 2;
  readonly channelId: string;

  constructor(actor: Actor, voice: Map<string, { channelId: string | null }>, channelId: string = TEXT) {
    this.channelId = channelId;
    this.user = { id: actor.id, bot: false };
    this.memberPermissions = { has: (p) => Boolean(actor.admin) && p === PermissionFlagsBits.Administrator };
    this.guild = {
      id: GUILD,
      ownerId: OWNER,
      voiceStates: { cache: voice },
      channels: { cache: new Map() },
      roles: { cache: new Map() },
      members: { me: null },
    };
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

  /** Number of acknowledgements (reply, deferReply, update, deferUpdate). */
  get acks(): number {
    return this.calls.filter((c) => ['reply', 'deferReply', 'update', 'deferUpdate'].includes(c.method))
      .length;
  }
  /** Was the first acknowledgement private? */
  get ephemeral(): boolean {
    const first = this.calls[0]?.payload.flags;
    return first === MessageFlags.Ephemeral;
  }
  /** Titles, descriptions and fields of every embed sent, as one string. */
  get text(): string {
    return this.calls
      .flatMap((c) => [
        String(c.payload.content ?? ''),
        ...(c.payload.embeds ?? []).map((e) => {
          const j = e.toJSON();
          return [j.title, j.description, ...(j.fields ?? []).flatMap((f) => [f.name, f.value])].join('\n');
        }),
      ])
      .join('\n');
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

interface CommandSpec {
  sub: string;
  group?: string | null;
  strings?: Record<string, string | null>;
  channel?: string | null;
  ints?: Record<string, number | null>;
  bools?: Record<string, boolean | null>;
  attachment?: { size: number; url: string };
}

class FakeCommand extends FakeInteraction {
  readonly commandName = 'radio';
  readonly options: Record<string, unknown>;
  constructor(
    actor: Actor,
    voice: Map<string, { channelId: string | null }>,
    spec: CommandSpec,
    channelId?: string,
  ) {
    super(actor, voice, channelId);
    const str = (n: string, required = false) => {
      const v = spec.strings?.[n] ?? null;
      if (required && v === null) throw new Error(`missing required option ${n}`);
      return v;
    };
    this.options = {
      getSubcommand: () => spec.sub,
      getSubcommandGroup: () => spec.group ?? null,
      getString: str,
      getChannel: (n: string) => (n === 'channel' && spec.channel ? { id: spec.channel } : null),
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

class FakeComponent extends FakeInteraction {
  readonly customId: string;
  readonly kind: 'button' | 'string';
  readonly values: string[];
  constructor(
    actor: Actor,
    voice: Map<string, { channelId: string | null }>,
    customId: string,
    kind: 'button' | 'string' = 'button',
    values: string[] = [],
  ) {
    super(actor, voice);
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
    return false;
  }
  isRoleSelectMenu() {
    return false;
  }
}

// ------------------------------------------------------------------ context

function setup() {
  const repos = memoryDb();
  const packs = PackRegistry.load(null);
  seedPacks(repos.stations, packs);
  const metrics = new Metrics();
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
  });
  const probes: string[] = [];
  // Any path that would really probe a stream records it instead.
  (sources as unknown as { rescanStation(id: string): Promise<unknown[]> }).rescanStation = async (id) => {
    probes.push(id);
    return [];
  };
  const sessions = new FakeSessions();
  const customAdds: string[] = [];
  let importText = '';
  const ids = new ComponentIds('test-secret');
  const ctx = {
    config: loadConfig({ DISCORD_TOKEN: 'x'.repeat(30), DISCORD_APPLICATION_ID: GUILD }),
    client: { channels: { cache: new Map(), fetch: async () => null }, ws: { ping: -1 }, application: null },
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
    sessions,
    packs,
    catalogueSync: {
      syncablePacks: () => [],
      lastSync: () => ({ at: null, ok: true }),
      isStale: () => false,
    },
    custom: {
      // Stands in for CustomStationService.add (which would probe the URL).
      add: async (guildId: string, userId: string, c: { name: string }) => {
        customAdds.push(c.name);
        const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        repos.stations.insertCustomStation({
          id: `custom:${slug}`,
          guildId,
          slug,
          displayName: c.name,
          description: null,
          category: null,
          websiteUrl: null,
          language: null,
          createdById: userId,
        });
        return { station: repos.stations.getStation(`custom:${slug}`) as Station, report: null };
      },
      remove: () => true,
    },
    ids,
    notifier: {},
    limits: new RateLimits(),
    eventLoop: new EventLoopMonitor(),
    startedAt: new Date(),
    ffmpegInfo: null,
  } as unknown as AppContext;
  const controller = new RadioController(ctx);
  const voice = new Map<string, { channelId: string | null }>();
  const people = {
    owner: { id: OWNER } as Actor,
    admin: { id: ADMIN, admin: true } as Actor,
    member: { id: MEMBER } as Actor,
  };
  const putInVoice = (actor: Actor, channelId: string | null) => voice.set(actor.id, { channelId });

  const run = async <T extends FakeInteraction>(i: T): Promise<T> => {
    await controller.handle(i as unknown as Interaction);
    return i;
  };
  return {
    ...repos,
    ctx,
    ids,
    sessions,
    probes,
    customAdds,
    people,
    putInVoice,
    metrics,
    setImport: (text: string) => {
      importText = text;
    },
    command: (actor: Actor, spec: CommandSpec, channelId?: string) =>
      run(new FakeCommand(actor, voice, spec, channelId)),
    click: (actor: Actor, customId: string, kind: 'button' | 'string' = 'button', values: string[] = []) =>
      run(new FakeComponent(actor, voice, customId, kind, values)),
  };
}

/** The action and argument a signed custom ID carries, or null if it is invalid or expired. */
function decode(ids: ComponentIds, customId: string): { action: string; arg: string } | null {
  const p = ids.parse(GUILD, customId);
  return p && !p.expired ? { action: p.action, arg: p.arg } : null;
}

const internalIncidents = (metrics: Metrics) =>
  metrics.recentIncidents(GUILD, 50).filter((x) => x.code === 'INTERNAL');

// ------------------------------------------------------------------ tests

const STATION = 'FG DJ RADIO';
const AMBIGUOUS = 'dance';

/** One invocation of every slash command and group subcommand, with valid options. */
const EVERY_COMMAND: CommandSpec[] = [
  { sub: 'browse' },
  { sub: 'play', strings: { station: STATION } },
  { sub: 'stop' },
  { sub: 'join' },
  { sub: 'leave' },
  { sub: 'now' },
  { sub: 'list' },
  { sub: 'inspect', strings: { station: STATION } },
  { sub: 'sources', strings: { station: STATION } },
  { sub: 'quality' },
  { sub: 'status' },
  { sub: 'stats' },
  { sub: 'skip' },
  { sub: 'add', strings: { name: 'My Station', url: 'https://radio.example.org/live' } },
  { sub: 'edit', strings: { station: STATION, name: 'Renamed' } },
  { sub: 'remove', strings: { station: STATION } },
  { sub: 'rescan', strings: { station: STATION } },
  { sub: 'sync' },
  { sub: 'config' },
  { sub: 'export' },
  { sub: 'import', attachment: { size: 100, url: 'https://cdn.discordapp.com/attachments/1/2/radio.json' } },
  { sub: 'panel' },
  { sub: 'help' },
  { group: 'queue', sub: 'add', strings: { station: STATION } },
  { group: 'queue', sub: 'list' },
  { group: 'queue', sub: 'remove', ints: { position: 1 } },
  { group: 'queue', sub: 'clear' },
  { group: 'source', sub: 'pin', strings: { station: STATION, source: 'x' } },
  { group: 'source', sub: 'prefer', strings: { station: STATION, source: 'x' } },
  { group: 'source', sub: 'auto', strings: { station: STATION } },
  { group: 'source', sub: 'verify', strings: { station: STATION, source: 'x', verdict: 'verified' } },
];

const ADMIN_ONLY = new Set([
  'stats',
  'add',
  'edit',
  'remove',
  'rescan',
  'sync',
  'config',
  'export',
  'import',
  'panel',
  'source',
]);

describe('every slash command is acknowledged exactly once', () => {
  it.each(EVERY_COMMAND.map((c) => [`${c.group ? `${c.group} ` : ''}${c.sub}`, c] as const))(
    '%s, run by a member who is not in a voice channel',
    async (_name, spec) => {
      const t = setup();
      const i = await t.command(t.people.member, spec);
      expect(i.violations).toEqual([]);
      expect(i.acks).toBe(1);
      expect(i.text).not.toMatch(/Something went wrong/);
      expect(internalIncidents(t.metrics)).toEqual([]);
      if (ADMIN_ONLY.has(spec.group ?? spec.sub)) {
        expect(i.text).toMatch(/Only the server owner and members with the Administrator permission/);
        expect(i.ephemeral).toBe(true);
      }
      expect(t.sessions.plays).toEqual([]);
      expect(t.probes).toEqual([]);
    },
  );

  it.each(['help', 'stats', 'config', 'export', 'list', 'status', 'quality', 'now', 'browse'])(
    '%s, run by an administrator',
    async (sub) => {
      const t = setup();
      const i = await t.command(t.people.admin, { sub });
      expect(i.violations).toEqual([]);
      expect(i.acks).toBe(1);
      expect(i.text).not.toMatch(/Something went wrong|Only the server owner/);
      expect(internalIncidents(t.metrics)).toEqual([]);
    },
  );

  it('refuses members outside the allowed command channels, but not administrators', async () => {
    const t = setup();
    t.guilds.updateSettings(GUILD, { allowedTextChannelIds: [TEXT] });
    const member = await t.command(t.people.member, { sub: 'now' }, OTHER_TEXT);
    expect(member.acks).toBe(1);
    expect(member.ephemeral).toBe(true);
    expect(member.text).toMatch(/only allowed in <#800000000000000001>/);
    const admin = await t.command(t.people.admin, { sub: 'now' }, OTHER_TEXT);
    expect(admin.text).not.toMatch(/only allowed in/);
  });

  it('treats the server owner as an administrator without the Administrator permission', async () => {
    const t = setup();
    const i = await t.command(t.people.owner, { sub: 'stats' });
    expect(i.violations).toEqual([]);
    expect(i.text).not.toMatch(/Only the server owner/);
  });
});

describe('buttons and menus are authorised again on every click', () => {
  it('denies a member the admin-only re-probe, stats refresh, settings and import buttons', async () => {
    const t = setup();
    for (const [action, arg] of [
      ['rescan', 'fg:fg-dj-radio'],
      ['stats', ''],
      ['cfg', 'page-playback'],
      ['imp', 'token'],
    ] as const) {
      const i = await t.click(t.people.member, t.ids.make(GUILD, action, arg));
      expect(i.violations).toEqual([]);
      expect(i.acks).toBe(1);
      expect(i.ephemeral).toBe(true);
      expect(i.text).toMatch(/Only the server owner and members with the Administrator permission/);
    }
    expect(t.probes).toEqual([]);
  });

  it('authorises the Close button too', async () => {
    const t = setup();
    t.ctx.guilds.updateSettings(GUILD, { allowedTextChannelIds: ['888888888888888888'] });
    const i = await t.click(t.people.member, t.ids.make(GUILD, 'close'));
    expect(i.text).toMatch(/Radio commands are only allowed in/);
    expect(i.violations).toEqual([]);
  });

  it('denies a member a play button when they are not in the voice channel', async () => {
    const t = setup();
    const i = await t.click(t.people.member, t.ids.make(GUILD, 'play', 'fg:fg-dj-radio'));
    expect(i.text).toMatch(/Join a voice channel first/);
    expect(t.sessions.plays).toEqual([]);
  });

  it('rejects forged, other-server and expired controls', async () => {
    const t = setup();
    const forged = await t.click(t.people.admin, 'not-a-signed-id');
    expect(forged.text).toMatch(/not valid here/);
    const otherGuild = await t.click(t.people.admin, t.ids.make(OTHER_GUILD, 'stats'));
    expect(otherGuild.text).toMatch(/not valid here/);
    let now = Date.now();
    const clocked = new ComponentIds('test-secret', () => now);
    const id = clocked.make(GUILD, 'stats', '', 60_000);
    // Expiry is rounded up to the next whole minute.
    now += 121_000;
    (t.ctx as { ids: ComponentIds }).ids = clocked;
    const expired = await t.click(t.people.admin, id);
    expect(expired.text).toMatch(/expired/);
    for (const i of [forged, otherGuild, expired]) {
      expect(i.acks).toBe(1);
      expect(i.ephemeral).toBe(true);
    }
  });

  it('lets an administrator switch the voice channel status off and on', async () => {
    const t = setup();
    expect(t.ctx.guilds.getSettings(GUILD).voiceChannelStatus).toBe(true);
    const off = await t.click(t.people.admin, t.ids.make(GUILD, 'cfg', 'vstatus'));
    expect(off.violations).toEqual([]);
    expect(t.ctx.guilds.getSettings(GUILD).voiceChannelStatus).toBe(false);
    expect(off.text).toMatch(/Voice channel status: off/);
    await t.click(t.people.admin, t.ids.make(GUILD, 'cfg', 'vstatus'));
    expect(t.ctx.guilds.getSettings(GUILD).voiceChannelStatus).toBe(true);
    const denied = await t.click(t.people.member, t.ids.make(GUILD, 'cfg', 'vstatus'));
    expect(denied.text).toMatch(/Only the server owner/);
    expect(t.ctx.guilds.getSettings(GUILD).voiceChannelStatus).toBe(true);
  });

  it('lets an administrator refresh stats in place', async () => {
    const t = setup();
    const i = await t.click(t.people.admin, t.ids.make(GUILD, 'stats', '', 30 * 60_000));
    expect(i.violations).toEqual([]);
    expect(i.calls.map((c) => c.method)).toEqual(['deferUpdate', 'editReply']);
  });
});

describe('ambiguous station names', () => {
  it('/radio play offers a picker that plays in the channel the command named', async () => {
    const t = setup();
    t.putInVoice(t.people.admin, V1);
    const i = await t.command(t.people.admin, { sub: 'play', strings: { station: AMBIGUOUS }, channel: V2 });
    expect(i.violations).toEqual([]);
    expect(i.text).toMatch(/Which station did you mean\?/);
    expect(t.sessions.plays).toEqual([]);
    const [pickId] = i.componentIds;
    expect(decode(t.ids, pickId!)).toEqual({ action: 'pick', arg: V2 });
    const pick = await t.click(t.people.admin, pickId!, 'string', ['fg:fg-dance']);
    expect(pick.violations).toEqual([]);
    expect(pick.calls[0]?.method).toBe('deferUpdate');
    expect(t.sessions.plays).toEqual([{ guildId: GUILD, stationId: 'fg:fg-dance', channelId: V2 }]);
  });

  it.each([
    ['sources', null],
    ['remove', null],
    ['add', 'queue'],
    ['pin', 'source'],
    ['rescan', null],
  ] as const)('/radio %s lists the matches without a picker and does nothing', async (sub, group) => {
    const t = setup();
    t.putInVoice(t.people.admin, V1);
    const i = await t.command(t.people.admin, {
      sub,
      group,
      strings: { station: AMBIGUOUS, source: 'x' },
    });
    expect(i.violations).toEqual([]);
    expect(i.acks).toBe(1);
    expect(i.ephemeral).toBe(true);
    expect(i.text).toMatch(/Run the command again and choose the station/);
    expect(i.componentIds).toEqual([]);
    expect(t.sessions.plays).toEqual([]);
    expect(t.probes).toEqual([]);
    expect(internalIncidents(t.metrics)).toEqual([]);
  });
});

describe('/radio join', () => {
  it('says it is already there instead of touching the session', async () => {
    const t = setup();
    const s = t.sessions.ensure(GUILD);
    Object.assign(s, { connected: true, channelId: V1, stationId: 'fg:fg-dj-radio' });
    t.putInVoice(t.people.admin, V1);
    const i = await t.command(t.people.admin, { sub: 'join' });
    expect(i.violations).toEqual([]);
    expect(i.text).toMatch(/Already here[\s\S]*already in <#700000000000000001>/);
    expect(i.ephemeral).toBe(true);
    expect(s.joins).toEqual([]);
    expect(t.sessions.plays).toEqual([]);
  });

  it('refuses a channel other than the locked one', async () => {
    const t = setup();
    t.guilds.updateSettings(GUILD, { voiceLock: true, preferredVoiceChannelId: V1 });
    t.putInVoice(t.people.admin, V1);
    const i = await t.command(t.people.admin, { sub: 'join', channel: V2 });
    expect(i.text).toMatch(/locked to <#700000000000000001>/);
    expect(t.sessions.get(GUILD)).toBeNull();
  });

  it('joins the requested channel when nothing stands in the way', async () => {
    const t = setup();
    t.putInVoice(t.people.admin, V1);
    const i = await t.command(t.people.admin, { sub: 'join' });
    expect(i.violations).toEqual([]);
    expect(i.calls.map((c) => c.method)).toEqual(['deferReply', 'editReply']);
    expect(t.sessions.get(GUILD)?.joins).toEqual([V1]);
  });

  it('takes one play token, not two, when it plays the default station', async () => {
    const t = setup();
    t.putInVoice(t.people.admin, V1);
    const station = t.stations.listStations(GUILD)[0]!;
    t.guilds.updateSettings(GUILD, { defaultStationId: station.id });
    await t.command(t.people.admin, { sub: 'join' });
    expect(t.sessions.plays.at(-1)?.stationId).toBe(station.id);
    // Six per 30 s: one went on the join, so five are left.
    const left = Array.from({ length: 6 }, () => t.ctx.limits.playUser.take(ADMIN));
    expect(left.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(left[5]).toBeGreaterThan(0);
  });
});

describe('/radio import', () => {
  const ATTACHMENT = { size: 1000, url: 'https://cdn.discordapp.com/attachments/1/2/radio.json' };

  async function preview(t: ReturnType<typeof setup>) {
    const i = await t.command(t.people.admin, { sub: 'import', attachment: ATTACHMENT });
    expect(i.violations).toEqual([]);
    expect(i.text).toMatch(/Import preview/);
    const [apply, cancel] = i.componentIds;
    expect(decode(t.ids, apply!)?.action).toBe('imp');
    expect(decode(t.ids, cancel!)?.action).toBe('impx');
    return apply!;
  }

  it('uses each preview once, and never duplicates custom stations when applied again', async () => {
    const t = setup();
    const data = exportGuild(GUILD, t.guilds, t.stations);
    data.customStations.push({
      name: 'Imported Radio',
      url: 'https://radio.example.org/live',
      urlRedacted: false,
      website: null,
      description: null,
      category: null,
      language: null,
    });
    t.setImport(JSON.stringify(data));

    const first = await preview(t);
    const applied = await t.click(t.people.admin, first);
    expect(applied.violations).toEqual([]);
    expect(applied.calls.map((c) => c.method)).toEqual(['deferUpdate', 'editReply']);
    expect(applied.text).toMatch(/Custom stations added: Imported Radio/);

    const replayed = await t.click(t.people.admin, first);
    expect(replayed.text).toMatch(/import preview expired/);

    const second = await preview(t);
    const again = await t.click(t.people.admin, second);
    expect(again.text).toMatch(/Imported Radio \(already exists\)/);
    expect(t.customAdds).toEqual(['Imported Radio']);
    expect(t.stations.listStations(GUILD).filter((s) => s.provider === 'custom')).toHaveLength(1);
  });

  it('lets an administrator cancel, after which the preview is gone', async () => {
    const t = setup();
    t.setImport(JSON.stringify(exportGuild(GUILD, t.guilds, t.stations)));
    const apply = await preview(t);
    const token = decode(t.ids, apply)!.arg;
    const cancel = await t.click(t.people.admin, t.ids.make(GUILD, 'impx', token, 10 * 60_000));
    expect(cancel.text).toMatch(/Import cancelled/);
    const late = await t.click(t.people.admin, apply);
    expect(late.text).toMatch(/import preview expired/);
  });
});

describe('/radio stats', () => {
  it('is private and administrator-only, with Refresh and Close', async () => {
    const t = setup();
    const member = await t.command(t.people.member, { sub: 'stats' });
    expect(member.ephemeral).toBe(true);
    expect(member.text).toMatch(/Only the server owner and members with the Administrator permission/);

    const admin = await t.command(t.people.admin, { sub: 'stats' });
    expect(admin.violations).toEqual([]);
    expect(admin.calls[0]).toMatchObject({
      method: 'deferReply',
      payload: { flags: MessageFlags.Ephemeral },
    });
    expect(admin.text).toMatch(/Bot health/);
    expect(admin.componentIds.map((id) => decode(t.ids, id)?.action)).toEqual(['stats', 'close']);
  });
});

describe('/radio help', () => {
  it('shows administrators the admin commands and tells members how custom stations are added', async () => {
    const t = setup();
    const admin = await t.command(t.people.admin, { sub: 'help' });
    const member = await t.command(t.people.member, { sub: 'help' });
    expect(admin.text).toMatch(/🛠 Admin\n`\/radio config`/);
    expect(member.text).not.toMatch(/🛠 Admin/);
    // One section per topic, not one long description.
    const fields = admin.calls[0]!.payload.embeds![0]!.toJSON().fields!.map((f) => f.name);
    expect(fields).toEqual([
      '🎧 Listen',
      '⭐ Favourites and the default station',
      '📋 Queue',
      '📡 Sources',
      '🛠 Admin',
      '🔊 Sound',
    ]);
    expect(member.text).toMatch(/`\/radio add`/);
    expect(member.ephemeral).toBe(true);
  });
});

describe('interaction log', () => {
  it('logs what each interaction was and how long it took, at debug level only', async () => {
    const t = setup();
    const lines: Array<Record<string, unknown>> = [];
    const capture = { write: (s: string) => lines.push(JSON.parse(s)) };
    (t.ctx as { logger: unknown }).logger = pino({ level: 'debug' }, capture);
    await t.command(t.people.owner, { sub: 'status' });
    await t.command(t.people.owner, { group: 'queue', sub: 'list' });
    await t.click(t.people.owner, t.ids.make(GUILD, 'stop'));
    const handled = lines.filter((l) => l.msg === 'interaction handled');
    expect(handled.map((l) => l.interaction)).toEqual([
      'command status',
      'command queue list',
      'button stop',
    ]);
    for (const l of handled) {
      expect(l.guildId).toBe(GUILD);
      expect(typeof l.ms).toBe('number');
      expect(typeof l.cpuMs).toBe('number');
    }
    lines.length = 0;
    (t.ctx as { logger: unknown }).logger = pino({ level: 'info' }, capture);
    await t.command(t.people.owner, { sub: 'status' });
    expect(lines.filter((l) => l.msg === 'interaction handled')).toEqual([]);
  });
});

describe('describeInteraction', () => {
  const fake = (o: Record<string, unknown>) => ({
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isMessageComponent: () => false,
    isButton: () => false,
    ...o,
  });
  const options = (group: string | null, sub: string | null) => ({
    getSubcommandGroup: () => group,
    getSubcommand: () => sub,
  });

  it('names commands, suggestions, buttons and menus without logging what was typed', () => {
    expect(
      describeInteraction(fake({ isAutocomplete: () => true, options: options(null, 'play') }) as never),
    ).toBe('autocomplete play');
    expect(
      describeInteraction(
        fake({ isChatInputCommand: () => true, commandName: 'radio', options: options(null, null) }) as never,
      ),
    ).toBe('command radio');
    expect(
      describeInteraction(
        fake({ isMessageComponent: () => true, customId: 'rb1:cfg-idle:x:0:sig' }) as never,
      ),
    ).toBe('menu cfg-idle');
    expect(
      describeInteraction(
        fake({
          isMessageComponent: () => true,
          isButton: () => true,
          customId: `rb1:${'a'.repeat(40)}:x`,
        }) as never,
      ),
    ).toBe(`button ${'a'.repeat(16)}`);
    expect(describeInteraction(fake({ type: 1 }) as never)).toBe('type 1');
  });
});

describe('Next and Previous station buttons', () => {
  it('move to another playable station of the same pack, and back again', async () => {
    const t = setup();
    t.putInVoice(t.people.admin, V1);
    const all = t.stations.listStations(GUILD);
    const playable = ['available', 'degraded', 'unverified'];
    const start = all.find((s) => playable.includes(t.ctx.sources.availability(s)))!;
    Object.assign(t.sessions.ensure(GUILD), { connected: true, channelId: V1, stationId: start.id });
    const next = await t.click(t.people.admin, t.ids.make(GUILD, 'next'));
    expect(next.violations).toEqual([]);
    const moved = t.sessions.plays.at(-1)!.stationId;
    expect(moved).not.toBe(start.id);
    expect(t.stations.getStation(moved)?.provider).toBe(start.provider);
    await t.click(t.people.admin, t.ids.make(GUILD, 'prev'));
    expect(t.sessions.plays.at(-1)!.stationId).toBe(start.id);
  });

  it('start from the first station (Next) or the last (Previous) when nothing is playing', async () => {
    const t = setup();
    t.putInVoice(t.people.admin, V1);
    const all = t.stations.listStations(GUILD);
    const playable = ['available', 'degraded', 'unverified'];
    const ring = all.filter(
      (s) => s.provider === all[0]!.provider && playable.includes(t.ctx.sources.availability(s)),
    );
    await t.click(t.people.admin, t.ids.make(GUILD, 'prev'));
    expect(t.sessions.plays.at(-1)!.stationId).toBe(ring.at(-1)!.id);
    t.sessions.plays.length = 0;
    await t.click(t.people.admin, t.ids.make(GUILD, 'next'));
    expect(t.sessions.plays.at(-1)!.stationId).toBe(ring[0]!.id);
  });

  it('refuses instead of restarting the station when it is the only one to move to', async () => {
    const t = setup();
    t.putInVoice(t.people.admin, V1);
    const playable = ['available', 'degraded', 'unverified'];
    const [start, other] = t.stations
      .listStations(GUILD)
      .filter((s) => playable.includes(t.ctx.sources.availability(s)));
    Object.assign(t.sessions.ensure(GUILD), { connected: true, channelId: V1, stationId: start!.id });
    t.guilds.setFavourites(GUILD, [start!.id, other!.id]);
    const availability = t.ctx.sources.availability.bind(t.ctx.sources);
    t.ctx.sources.availability = (s) => (s.id === other!.id ? 'no_source' : availability(s));
    const next = await t.click(t.people.admin, t.ids.make(GUILD, 'next'));
    expect(next.text).toMatch(/no other playable station/);
    expect(t.sessions.plays).toEqual([]);
  });
});

describe('favourites and the default station', () => {
  /** A suggestion request, as Discord sends one while someone types in an option. */
  const suggest = async (t: ReturnType<typeof setup>, sub: string, option: string, value = '') => {
    let answer: Array<{ name: string; value: string }> = [];
    const i = {
      guildId: GUILD,
      user: { id: OWNER, bot: false },
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
        getSubcommandGroup: () => null,
        getString: () => null,
      },
      respond: async (choices: typeof answer) => {
        answer = choices;
      },
    };
    await new RadioController(t.ctx).handle(i as unknown as Interaction);
    return answer;
  };

  it('suggests the default station first, then the favourites, and labels them', async () => {
    const t = setup();
    const [a, b, c] = t.stations.listStations(GUILD).slice(-3);
    t.guilds.updateSettings(GUILD, { defaultStationId: c!.id });
    t.guilds.toggleFavourite(GUILD, a!.id);
    t.guilds.toggleFavourite(GUILD, b!.id);
    const choices = await suggest(t, 'play', 'station');
    expect(choices.slice(0, 3).map((x) => x.value)).toEqual([c!.id, a!.id, b!.id]);
    expect(choices[0]!.name).toMatch(/\(default\)/);
    expect(choices[1]!.name).toMatch(/\(favourite\)/);
    expect(choices.filter((x) => x.value === a!.id)).toHaveLength(1);
  });

  it('lets an admin clear the default station', async () => {
    const t = setup();
    const station = t.stations.listStations(GUILD)[0]!;
    await t.command(t.people.owner, { sub: 'config', strings: { default_station: station.id } });
    expect(t.guilds.getSettings(GUILD).defaultStationId).toBe(station.id);
    expect((await suggest(t, 'config', 'default_station'))[0]).toEqual({
      name: 'No default station (clear it)',
      value: 'none',
    });
    await t.command(t.people.owner, { sub: 'config', strings: { default_station: 'none' } });
    expect(t.guilds.getSettings(GUILD).defaultStationId).toBeNull();
  });

  it('says where favourites show up, and the browse list filters to them in one click', async () => {
    const t = setup();
    t.putInVoice(t.people.admin, V1);
    const station = t.stations.listStations(GUILD)[0]!;
    const fav = await t.click(t.people.admin, t.ids.make(GUILD, 'fav', station.id));
    expect(fav.text).toMatch(/come first in the `\/radio play` suggestions/);
    const browse = await t.command(t.people.member, { sub: 'browse' });
    const toggle = browse.componentIds.find((id) => decode(t.ids, id)?.action === 'bfav')!;
    const filtered = await t.click(t.people.member, toggle);
    expect(filtered.violations).toEqual([]);
    const embed = filtered.calls[0]!.payload.embeds![0]!.toJSON();
    expect(embed.footer?.text).toMatch(/· 1 station\./);
    expect(embed.description).toContain(station.displayName);
  });
});

describe('choosing another source while a station plays', () => {
  /** A station with two usable sources (and possibly more that aren't), playing in V1 from the first. */
  const playing = () => {
    const t = setup();
    const st = t.stations.listStations(GUILD).find((x) => t.stations.listSources(x.id).length >= 2)!;
    const all = t.stations.listSources(st.id);
    for (const src of all.slice(0, 2)) {
      t.stations.applyProbePatch(src.id, {
        lastProbeAt: new Date().toISOString(),
        verificationState: 'eligible',
        identityStatus: 'verified',
        codec: 'mp3',
      });
    }
    const usable = t.ctx.sources.select(GUILD, st.id).ordered.map((x) => x.id);
    const unusable = all.find((x) => !usable.includes(x.id));
    Object.assign(t.sessions.ensure(GUILD), {
      connected: true,
      channelId: V1,
      stationId: st.id,
      playingSourceId: usable[0],
    });
    return { t, st, usable, unusable, session: t.sessions.get(GUILD)! };
  };
  const pickerId = (i: { componentIds: string[] }, ids: ComponentIds) =>
    i.componentIds.find((id) => decode(ids, id)?.action === 'usesrc');

  it('lets a listener in the channel switch to another usable source', async () => {
    const { t, st, usable, session } = playing();
    t.putInVoice(t.people.member, V1);
    const view = await t.command(t.people.member, { sub: 'sources', strings: { station: st.id } });
    const picker = pickerId(view, t.ids);
    expect(picker).toBeDefined();
    const pick = await t.click(t.people.member, picker!, 'string', [usable[1]!]);
    expect(pick.violations).toEqual([]);
    expect(session.usedSources).toEqual([usable[1]]);
    expect(pick.text).toMatch(/lasts until the station changes/);
  });

  it('refuses a source that is not usable, or belongs to another station', async () => {
    const { t, st, unusable, session } = playing();
    t.putInVoice(t.people.member, V1);
    const picker = t.ids.make(GUILD, 'usesrc', st.id);
    const other = t.stations.listAllSources().find((x) => x.stationId !== st.id)!;
    for (const id of [unusable?.id ?? 'missing', other.id, 'made-up-source']) {
      const pick = await t.click(t.people.member, picker, 'string', [id]);
      expect(pick.text).toMatch(/can’t be used right now/);
    }
    expect(session.usedSources).toEqual([]);
  });

  it('refuses listeners outside the channel, and stations that are not playing', async () => {
    const { t, st, usable, session } = playing();
    t.putInVoice(t.people.member, V2);
    const outside = await t.click(t.people.member, t.ids.make(GUILD, 'usesrc', st.id), 'string', [
      usable[1]!,
    ]);
    expect(outside.text).toMatch(/Join that channel to control it/);
    // Someone outside the channel isn't offered the picker at all.
    const view = await t.command(t.people.member, { sub: 'sources', strings: { station: st.id } });
    expect(pickerId(view, t.ids)).toBeUndefined();
    t.putInVoice(t.people.member, V1);
    const otherStation = t.stations.listStations(GUILD).find((x) => x.id !== st.id)!;
    const stale = await t.click(t.people.member, t.ids.make(GUILD, 'usesrc', otherStation.id), 'string', [
      usable[1]!,
    ]);
    expect(stale.text).toMatch(/isn’t playing any more/);
    expect(session.usedSources).toEqual([]);
  });

  it('lets only admins make a source the server preference, and go back to automatic', async () => {
    const { t, st, usable } = playing();
    t.putInVoice(t.people.member, V1);
    // The button names the station; the source it prefers is the one playing when it is pressed.
    const denied = await t.click(t.people.member, t.ids.make(GUILD, 'spref', st.id));
    expect(denied.text).toMatch(/Only the server owner/);
    expect(t.guilds.getPreference(GUILD, st.id)).toBeNull();
    await t.click(t.people.admin, t.ids.make(GUILD, 'spref', st.id));
    expect(t.guilds.getPreference(GUILD, st.id)).toMatchObject({ mode: 'prefer', sourceId: usable[0] });
    await t.click(t.people.admin, t.ids.make(GUILD, 'sauto', st.id));
    expect(t.guilds.getPreference(GUILD, st.id)?.mode ?? 'auto').toBe('auto');
  });

  it('never undoes a stop: the picker refuses once the station is stopped', async () => {
    const { t, st, usable, session } = playing();
    t.putInVoice(t.people.member, V1);
    session.desiredState = 'stopped';
    const pick = await t.click(t.people.member, t.ids.make(GUILD, 'usesrc', st.id), 'string', [usable[1]!]);
    expect(pick.text).toMatch(/isn’t playing any more/);
    expect(session.usedSources).toEqual([]);
  });

  it("keeps an admin's pin: listeners can't switch a pinned station, admins still can", async () => {
    const { t, st, usable, session } = playing();
    t.guilds.setPreference(GUILD, st.id, 'pin', usable[0]!, OWNER);
    t.putInVoice(t.people.member, V1);
    const view = await t.command(t.people.member, { sub: 'sources', strings: { station: st.id } });
    expect(view.componentIds.some((id) => decode(t.ids, id)?.action === 'usesrc')).toBe(false);
    const pick = await t.click(t.people.member, t.ids.make(GUILD, 'usesrc', st.id), 'string', [usable[1]!]);
    expect(pick.text).toMatch(/pinned/);
    expect(session.usedSources).toEqual([]);
    t.putInVoice(t.people.admin, V1);
    await t.click(t.people.admin, t.ids.make(GUILD, 'usesrc', st.id), 'string', [usable[1]!]);
    expect(session.usedSources).toEqual([usable[1]]);
  });
});

describe('settings with long channel and role lists', () => {
  it('stays within Discord’s field limit however many are chosen', async () => {
    const t = setup();
    const ids = (start: number) =>
      Array.from({ length: 25 }, (_, n) => `7${String(start + n).padStart(17, '0')}`);
    t.guilds.updateSettings(GUILD, {
      allowedTextChannelIds: ids(100),
      allowedVoiceChannelIds: ids(200),
      djRoleIds: ids(300),
    });
    const view = await t.command(t.people.owner, { sub: 'config' });
    expect(view.violations).toEqual([]);
    const fields = view.calls[0]!.payload.embeds![0]!.toJSON().fields!;
    for (const f of fields) expect(f.value.length).toBeLessThanOrEqual(1024);
    expect(fields[0]!.value).toMatch(/and 19 more/);
  });
});

describe('open browse lists', () => {
  it('keeps at most 500, dropping the oldest first', async () => {
    const t = setup();
    const first = await t.command(t.people.member, { sub: 'browse' });
    const next = first.componentIds.find((id) => decode(t.ids, id)?.action === 'browse')!;
    for (let n = 0; n < 500; n++) await t.command(t.people.member, { sub: 'browse' });
    const old = await t.click(t.people.member, next);
    expect(old.text).toMatch(/This station list has expired/);
    const latest = await t.command(t.people.member, { sub: 'browse' });
    const fresh = latest.componentIds.find((id) => decode(t.ids, id)?.action === 'browse')!;
    expect((await t.click(t.people.member, fresh)).text).not.toMatch(/expired/);
  });
});

describe('the Favourites filter in Browse', () => {
  it('goes back to the category the list was opened with', async () => {
    const t = setup();
    const category = t.ctx.packs.categories()[0]!.id;
    t.guilds.toggleFavourite(GUILD, t.stations.listStations(GUILD)[0]!.id);
    const browse = await t.command(t.people.member, { sub: 'browse', strings: { category } });
    const toggle = browse.componentIds.find((id) => decode(t.ids, id)?.action === 'bfav')!;
    const footer = (i: {
      calls: Array<{ payload: { embeds?: Array<{ toJSON(): { footer?: { text: string } } }> } }>;
    }) => i.calls[0]!.payload.embeds![0]!.toJSON().footer?.text ?? '';
    expect(footer(await t.click(t.people.member, toggle))).toMatch(/category: favourites/);
    expect(footer(await t.click(t.people.member, toggle))).toContain(`category: ${category}`);
  });
});
