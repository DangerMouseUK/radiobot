import { DiscordAPIError, type Interaction, MessageFlags } from 'discord.js';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { ComponentIds } from '../../src/discord/components/custom-id.ts';
import { describeInteraction, RadioController } from '../../src/discord/controller.ts';
import { COLOR } from '../../src/discord/ui/format.ts';
import { exportGuild } from '../../src/import-export/config-io.ts';
import {
  ADMIN,
  type CommandSpec,
  decode,
  embedText,
  GUILD,
  internalIncidents,
  OTHER_GUILD,
  OTHER_TEXT,
  OWNER,
  setup,
  suggest,
  TEXT,
  V1,
  V2,
} from './controller-harness.ts';

// ------------------------------------------------------------------ tests

const STATION = 'Demo Radio';
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
  { group: 'packs', sub: 'sync' },
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
      ['rescan', 'demo:demo-radio'],
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
    const i = await t.click(t.people.member, t.ids.make(GUILD, 'play', 'demo:demo-radio'));
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
    const pick = await t.click(t.people.admin, pickId!, 'string', ['demo:demo-dance']);
    expect(pick.violations).toEqual([]);
    expect(pick.calls[0]?.method).toBe('deferUpdate');
    expect(t.sessions.plays).toEqual([{ guildId: GUILD, stationId: 'demo:demo-dance', channelId: V2 }]);
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
    Object.assign(s, { connected: true, channelId: V1, stationId: 'demo:demo-radio' });
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

  it('plays the default station when it is still in the channel after a stop', async () => {
    const t = setup();
    t.putInVoice(t.people.admin, V1);
    const station = t.stations.listStations(GUILD)[0]!;
    const s = t.sessions.ensure(GUILD);
    Object.assign(s, { connected: true, channelId: V1, stationId: station.id });
    t.guilds.setIntent(GUILD, { desiredState: 'stopped' });
    // Without a default station there is nothing to start.
    const bare = await t.command(t.people.admin, { sub: 'join' });
    expect(bare.text).toMatch(/Already here/);
    expect(t.sessions.plays).toEqual([]);
    t.guilds.updateSettings(GUILD, { defaultStationId: station.id });
    const i = await t.command(t.people.admin, { sub: 'join' });
    expect(i.violations).toEqual([]);
    expect(t.sessions.plays).toEqual([{ guildId: GUILD, stationId: station.id, channelId: V1 }]);
    // While it plays, joining again leaves the station alone.
    t.guilds.setIntent(GUILD, { desiredState: 'playing' });
    const again = await t.command(t.people.admin, { sub: 'join' });
    expect(again.text).toMatch(/Already here/);
    expect(t.sessions.plays).toHaveLength(1);
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
    // The preview turns into a progress message at once and loses its buttons, so a second click
    // can't land on a preview that is already being applied.
    expect(applied.calls.map((c) => c.method)).toEqual(['update', 'editReply']);
    expect(applied.calls[0]!.payload.components).toEqual([]);
    expect(embedText(applied.calls[0]!.payload.embeds![0]!.toJSON())).toMatch(
      /^Applying import…\nSettings first, then each custom station is checked/,
    );
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

  it('keeps one preview per server: a newer one replaces the older', async () => {
    const t = setup();
    t.setImport(JSON.stringify(exportGuild(GUILD, t.guilds, t.stations)));
    const older = await preview(t);
    const newer = await preview(t);
    expect((await t.click(t.people.admin, older)).text).toMatch(/import preview expired/);
    expect((await t.click(t.people.admin, newer)).text).toMatch(/Import applied/);
  });

  it('allows five imports per server in ten minutes, refused before the file is read', async () => {
    const t = setup();
    const text = JSON.stringify(exportGuild(GUILD, t.guilds, t.stations));
    let reads = 0;
    (t.ctx.http as unknown as { fetchText: () => Promise<{ text: string }> }).fetchText = async () => {
      reads++;
      return { text };
    };
    for (let n = 0; n < 5; n++) await preview(t);
    const sixth = await t.command(t.people.admin, { sub: 'import', attachment: ATTACHMENT });
    expect(sixth.violations).toEqual([]);
    expect(sixth.ephemeral).toBe(true);
    expect(sixth.text).toMatch(/Too many imports/);
    expect(reads).toBe(5);
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
    isModalSubmit: () => false,
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
        fake({ isMessageComponent: () => true, customId: 'rb1:set-idle:x:0:sig' }) as never,
      ),
    ).toBe('menu set-idle');
    expect(
      describeInteraction(
        fake({
          isMessageComponent: () => true,
          isButton: () => true,
          customId: `rb1:${'a'.repeat(40)}:x`,
        }) as never,
      ),
    ).toBe(`button ${'a'.repeat(16)}`);
    // A submitted form logs its action, never what was typed into it.
    expect(
      describeInteraction(
        fake({ isModalSubmit: () => true, customId: 'rb2:bsearch:tok:0:sig', fields: 'secret' }) as never,
      ),
    ).toBe('form bsearch');
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
    expect(fav.text).toMatch(
      /come first in `\/radio play`, and \*\*Show favourites\*\* in Browse lists them/,
    );
    const browse = await t.command(t.people.member, { sub: 'browse' });
    const toggle = browse.componentIds.find((id) => decode(t.ids, id)?.action === 'bfav')!;
    const filtered = await t.click(t.people.member, toggle);
    expect(filtered.violations).toEqual([]);
    const embed = filtered.calls[0]!.payload.embeds![0]!.toJSON();
    expect(embed.footer?.text).toMatch(/· 1 station · favourites only\./);
    expect(embed.description).toContain(station.displayName);
    // The title says what happened, and it is green because something changed.
    expect(fav.calls[0]!.payload.embeds![0]!.toJSON()).toMatchObject({
      title: 'Added to favourites',
      color: COLOR.ok,
    });
  });

  it('never undoes itself: Favourite only adds and Unfavourite only removes', async () => {
    const t = setup();
    t.putInVoice(t.people.admin, V1);
    const station = t.stations.listStations(GUILD)[0]!;
    // Two clicks on the same card (a double click, or a card drawn before the first click).
    const add = t.ids.make(GUILD, 'fav', station.id);
    await t.click(t.people.admin, add);
    const again = await t.click(t.people.admin, add);
    expect(again.violations).toEqual([]);
    expect(again.text).toMatch(/already one of this server’s favourites/);
    // Nothing changed, so grey, with a title that says so.
    expect(again.calls[0]!.payload.embeds![0]!.toJSON()).toMatchObject({
      title: 'Already a favourite',
      color: COLOR.neutral,
    });
    expect(t.guilds.isFavourite(GUILD, station.id)).toBe(true);
    const remove = t.ids.make(GUILD, 'unfav', station.id);
    const removed = await t.click(t.people.admin, remove);
    expect(removed.text).toMatch(/no longer one of this server’s favourites/);
    expect(removed.calls[0]!.payload.embeds![0]!.toJSON()).toMatchObject({
      title: 'Removed from favourites',
      color: COLOR.ok,
    });
    const twice = await t.click(t.people.admin, remove);
    expect(twice.text).toMatch(/isn’t one of this server’s favourites/);
    expect(twice.calls[0]!.payload.embeds![0]!.toJSON()).toMatchObject({
      title: 'Not a favourite',
      color: COLOR.neutral,
    });
    expect(t.guilds.isFavourite(GUILD, station.id)).toBe(false);
  });
});

describe('suggestions that expire before they are sent', () => {
  const suggest = async (t: ReturnType<typeof setup>, err: Error) => {
    const i = {
      guildId: GUILD,
      user: { id: OWNER, bot: false },
      type: 4,
      inCachedGuild: () => true,
      isRepliable: () => false,
      isAutocomplete: () => true,
      isChatInputCommand: () => false,
      isMessageComponent: () => false,
      isButton: () => false,
      commandName: 'radio',
      options: {
        getFocused: () => ({ name: 'station', value: '' }),
        getSubcommand: () => 'play',
        getSubcommandGroup: () => null,
        getString: () => null,
      },
      respond: async () => {
        throw err;
      },
    };
    await new RadioController(t.ctx).handle(i as unknown as Interaction);
  };

  it('are logged at debug level, not as an internal fault', async () => {
    const t = setup();
    const lines: Array<Record<string, unknown>> = [];
    (t.ctx as { logger: unknown }).logger = pino(
      { level: 'debug' },
      { write: (s: string) => lines.push(JSON.parse(s)) },
    );
    const unknown = { code: 10062, message: 'Unknown interaction' };
    await suggest(t, new DiscordAPIError(unknown, 10062, 404, 'POST', '/interactions/x/callback', {}));
    expect(lines.filter((l) => Number(l.level) >= 50)).toEqual([]);
    expect(internalIncidents(t.metrics)).toEqual([]);
    expect(lines.some((l) => l.level === 20 && /expired/.test(String(l.msg)))).toBe(true);
    // Any other failure is still a fault.
    await suggest(t, new Error('boom'));
    expect(internalIncidents(t.metrics)).toHaveLength(1);
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
    expect(pick.text).toMatch(/now plays from \*\*.+\*\* until the station changes\. If it fails/);
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

  it('stay open for 15 minutes after their last use, not after they were opened', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const t = setup();
      const pageButton = (i: { componentIds: string[] }) =>
        i.componentIds.find((id) => decode(t.ids, id)?.action === 'browse')!;
      const first = await t.command(t.people.member, { sub: 'browse' });
      vi.setSystemTime(Date.now() + 10 * 60_000);
      const second = await t.click(t.people.member, pageButton(first));
      expect(second.text).not.toMatch(/expired/);
      // 20 minutes after it was opened, 10 after it was last used.
      vi.setSystemTime(Date.now() + 10 * 60_000);
      const third = await t.click(t.people.member, pageButton(second));
      expect(third.violations).toEqual([]);
      expect(third.text).not.toMatch(/expired/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the Favourites filter in Browse', () => {
  it('goes back to the category the list was opened with', async () => {
    const t = setup();
    const { id: category, name } = t.ctx.packs.categories()[0]!;
    t.guilds.toggleFavourite(GUILD, t.stations.listStations(GUILD)[0]!.id);
    const browse = await t.command(t.people.member, { sub: 'browse', strings: { category } });
    const toggle = browse.componentIds.find((id) => decode(t.ids, id)?.action === 'bfav')!;
    const footer = (i: {
      calls: Array<{ payload: { embeds?: Array<{ toJSON(): { footer?: { text: string } } }> } }>;
    }) => i.calls[0]!.payload.embeds![0]!.toJSON().footer?.text ?? '';
    expect(footer(await t.click(t.people.member, toggle))).toMatch(/· favourites only\./);
    // Named as the category suggestions name it, not by its ID.
    expect(footer(await t.click(t.people.member, toggle))).toContain(`category: ${name}`);
  });
});
