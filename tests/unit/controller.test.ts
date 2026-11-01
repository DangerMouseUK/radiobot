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
  status() {
    return null;
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
    now += 61_000;
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
    expect(off.text).toMatch(/Voice channel status:\*\* off/);
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
    expect(admin.text).toMatch(/\*\*Admin\*\*/);
    expect(member.text).not.toMatch(/\*\*Admin\*\*/);
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
});
