import type { Interaction } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  DJ_ROLE,
  GUILD,
  type Harness,
  internalIncidents,
  OWNER,
  setup,
  suggest,
  TEXT,
  V1,
  V2,
} from './controller-harness.ts';

/** Suggestions for an option of `/radio source …`. */
const SOURCE = { group: 'source' };

/** A server with only custom stations, and one playable station called My Station. */
function customServer() {
  const t = setup({ customOnly: true });
  const st = t.addCustomStation('My Station');
  return { t, st };
}

/** Puts the bot in a voice channel, playing a station. */
function playingIn(t: Harness, channelId: string, stationId: string) {
  const s = t.sessions.ensure(GUILD);
  Object.assign(s, { connected: true, channelId, stationId });
  t.guilds.setIntent(GUILD, { desiredState: 'playing', desiredStationId: stationId });
  return s;
}

describe('who may control the radio', () => {
  it('DJs may control it when listeners may not, but are not administrators', async () => {
    const { t, st } = customServer();
    t.guilds.updateSettings(GUILD, { memberControlMode: 'none', djRoleIds: [DJ_ROLE] });
    const s = playingIn(t, V1, st.id);
    const member = await t.command(t.people.member, { sub: 'stop' });
    expect(member.text).toMatch(/Only DJs and administrators can control the radio on this server\./);
    expect(s.stops).toBe(0);
    // A DJ needn't even be in the channel.
    const dj = await t.command(t.people.dj, { sub: 'stop' });
    expect(dj.text).toMatch(/stopped the radio/);
    expect(s.stops).toBe(1);
    const stats = await t.command(t.people.dj, { sub: 'stats' });
    expect(stats.text).toMatch(/Only the server owner and members with the Administrator permission/);
  });

  it('a role that is not a DJ role grants nothing', async () => {
    const { t, st } = customServer();
    t.guilds.updateSettings(GUILD, { memberControlMode: 'none', djRoleIds: ['600000000000000099'] });
    const s = playingIn(t, V1, st.id);
    const i = await t.command(t.people.dj, { sub: 'stop' });
    expect(i.text).toMatch(/Only DJs and administrators/);
    expect(s.stops).toBe(0);
  });

  it('with "any", a listener may control it from outside voice', async () => {
    const { t, st } = customServer();
    t.guilds.updateSettings(GUILD, { memberControlMode: 'any' });
    const s = playingIn(t, V1, st.id);
    await t.command(t.people.member, { sub: 'stop' });
    expect(s.stops).toBe(1);
  });

  it('with "same channel", a listener elsewhere is sent to the bot’s channel', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    t.putInVoice(t.people.member, V2);
    const stop = await t.command(t.people.member, { sub: 'stop' });
    expect(stop.text).toMatch(
      /The radio is in use in <#700000000000000001>\. Join that channel to control it/,
    );
    expect(s.stops).toBe(0);
    const skip = await t.command(t.people.member, { group: 'queue', sub: 'clear' });
    expect(skip.text).toMatch(/in use in <#700000000000000001>/);
  });

  it('a listener can only bring the radio to their own channel', async () => {
    const { t } = customServer();
    t.putInVoice(t.people.member, V1);
    const i = await t.command(t.people.member, {
      sub: 'play',
      strings: { station: 'My Station' },
      channel: V2,
    });
    expect(i.text).toMatch(/Listeners can only bring the radio to the voice channel they are in\./);
    expect(t.sessions.plays).toEqual([]);
  });

  it('the voice lock sends every play to the locked channel, which listeners elsewhere cannot use', async () => {
    const { t, st } = customServer();
    t.guilds.updateSettings(GUILD, { voiceLock: true, preferredVoiceChannelId: V1 });
    t.putInVoice(t.people.member, V2);
    const member = await t.command(t.people.member, { sub: 'play', strings: { station: st.id } });
    expect(member.text).toMatch(/Listeners can only bring the radio to the voice channel they are in/);
    t.putInVoice(t.people.admin, V2);
    await t.command(t.people.admin, { sub: 'play', strings: { station: st.id } });
    expect(t.sessions.plays).toEqual([{ guildId: GUILD, stationId: st.id, channelId: V1 }]);
  });

  it('the text chat of an allowed voice channel counts as a command channel', async () => {
    const t = setup();
    t.guilds.updateSettings(GUILD, { allowedTextChannelIds: [TEXT], allowedVoiceChannelIds: [V1] });
    const inVoiceChat = await t.command(t.people.member, { sub: 'now' }, V1);
    expect(inVoiceChat.text).not.toMatch(/only allowed in/);
    const elsewhere = await t.command(t.people.member, { sub: 'now' }, V2);
    expect(elsewhere.text).toMatch(/Radio commands are only allowed in <#800000000000000001>/);
  });

  it('read commands refuse members outside the command channels', async () => {
    const t = setup();
    t.guilds.updateSettings(GUILD, { allowedTextChannelIds: [TEXT] });
    for (const spec of [
      { sub: 'browse' },
      { sub: 'list' },
      { sub: 'quality' },
      { sub: 'status' },
      { sub: 'sources', strings: { station: 'x' } },
      { group: 'queue', sub: 'list' },
    ]) {
      const i = await t.command(t.people.member, spec, V2);
      expect(i.ephemeral).toBe(true);
      expect(i.text).toMatch(/Radio commands are only allowed in/);
    }
  });
});

describe('suggestions while typing', () => {
  it('for a source: the sources of the chosen station, filtered by what is typed', async () => {
    const { t, st } = customServer();
    t.stations.insertSource({
      id: 'custom-my-station-2',
      stationId: st.id,
      url: 'https://backup.example.org/my-station',
      label: 'Backup stream',
      priority: 20,
      transportHint: 'http-continuous',
      codecHint: 'mp3',
      provenance: 'curated',
      provenanceDetail: null,
      rightsStatus: 'unreviewed',
    });
    const all = await suggest(t, 'pin', 'source', '', { station: st.id }, SOURCE);
    expect(all.map((c) => c.value).sort()).toEqual(['custom-my-station-1', 'custom-my-station-2']);
    expect(all.find((c) => c.value === 'custom-my-station-2')?.name).toBe(
      'Backup stream · custom-my-station-2 · unverified',
    );
    const byLabel = await suggest(t, 'pin', 'source', 'BACKUP', { station: st.id }, SOURCE);
    expect(byLabel.map((c) => c.value)).toEqual(['custom-my-station-2']);
    const byId = await suggest(t, 'pin', 'source', 'station-1', { station: st.id }, SOURCE);
    expect(byId.map((c) => c.value)).toEqual(['custom-my-station-1']);
    expect(await suggest(t, 'pin', 'source', '', { station: 'Nothing Like It' }, SOURCE)).toEqual([]);
  });

  it('are authorised like the command: nothing outside the command channels, sources only for admins', async () => {
    const { t, st } = customServer();
    const member = t.people.member;
    // Anyone who may read gets stations.
    expect((await suggest(t, 'play', 'station', '', {}, { actor: member })).map((c) => c.value)).toEqual([
      st.id,
    ]);
    // `/radio source` is for admins, so its sources and their review status are too.
    const sourcesFor = (from: Parameters<typeof suggest>[5]) =>
      suggest(t, 'pin', 'source', '', { station: st.id }, { ...SOURCE, ...from });
    expect(await sourcesFor({ actor: member })).toEqual([]);
    t.guilds.updateSettings(GUILD, { djRoleIds: [DJ_ROLE] });
    expect(await sourcesFor({ actor: t.people.dj })).toEqual([]);
    expect((await sourcesFor({ actor: t.people.admin })).map((c) => c.value)).toEqual([
      'custom-my-station-1',
    ]);
    // The station option of `/radio source` reveals no more than browse does, but is still the admins'.
    expect(await suggest(t, 'pin', 'station', '', {}, { ...SOURCE, actor: member })).toEqual([]);
    // Outside the command channels a member gets nothing at all; an admin still gets suggestions.
    t.guilds.updateSettings(GUILD, { allowedTextChannelIds: [TEXT] });
    const elsewhere = { actor: member, channelId: '800000000000000099' };
    expect(await suggest(t, 'play', 'station', '', {}, elsewhere)).toEqual([]);
    expect(await suggest(t, 'browse', 'pack', '', {}, elsewhere)).toEqual([]);
    expect(await suggest(t, 'browse', 'category', '', {}, elsewhere)).toEqual([]);
    expect(await suggest(t, 'play', 'station', '', {}, { actor: member })).not.toEqual([]);
    expect(
      await suggest(t, 'play', 'station', '', {}, { actor: t.people.admin, channelId: '800000000000000099' }),
    ).not.toEqual([]);
  });

  it('for a pack: every enabled pack and the custom stations, but only syncable packs for sync', async () => {
    const t = setup();
    const pack = t.ctx.packs.packs[0]!;
    const browse = await suggest(t, 'browse', 'pack');
    expect(browse.map((c) => c.value)).toEqual([pack.meta.id, 'custom']);
    expect(browse[0]!.name).toBe(`${pack.meta.name} (${pack.stations.length} stations)`);
    expect((await suggest(t, 'browse', 'pack', 'CUST')).map((c) => c.value)).toEqual(['custom']);
    expect((await suggest(t, 'browse', 'pack', 'zzz')).map((c) => c.value)).toEqual([]);
    expect((await suggest(t, 'sync', 'pack')).map((c) => c.value)).toEqual([pack.meta.id]);
  });

  it('for a category: the pack’s categories, then Favourites and Custom, filtered by name', async () => {
    const t = setup();
    const cats = t.ctx.packs.categories();
    const all = await suggest(t, 'browse', 'category');
    expect(all.map((c) => c.value)).toEqual([...cats.map((c) => c.id), 'favourites', 'custom']);
    expect(all[0]!.name).toMatch(new RegExp(`^${cats[0]!.name} — `));
    const ofOtherPack = await suggest(t, 'browse', 'category', '', { pack: 'mypack' });
    expect(ofOtherPack.map((c) => c.value)).toEqual(['favourites', 'custom']);
    expect((await suggest(t, 'browse', 'category', 'FAV')).map((c) => c.value)).toEqual(['favourites']);
  });

  it('for edit and remove: only custom stations, marked as custom', async () => {
    const t = setup();
    const own = t.addCustomStation('My Station');
    for (const sub of ['edit', 'remove']) {
      const choices = await suggest(t, sub, 'station');
      expect(choices.map((c) => c.value)).toEqual([own.id]);
      expect(choices[0]!.name).toMatch(/^My Station \(custom\) — /);
    }
  });

  it('for a station: matches for what is typed', async () => {
    const { t, st } = customServer();
    t.addCustomStation('Another Station');
    const hits = await suggest(t, 'play', 'station', 'my stat');
    expect(hits[0]!.value).toBe(st.id);
  });

  it('for the default station: offers to clear it only when what is typed fits', async () => {
    const { t } = customServer();
    expect((await suggest(t, 'config', 'default_station', 'no'))[0]!.value).toBe('none');
    const named = await suggest(t, 'config', 'default_station', 'my');
    expect(named.map((c) => c.value)).not.toContain('none');
  });

  it('a failure while suggesting is recorded, and nothing is sent', async () => {
    const t = setup();
    const i = {
      guildId: GUILD,
      user: { id: OWNER, bot: false },
      type: 4,
      inCachedGuild: () => true,
      isRepliable: () => false,
      isAutocomplete: () => true,
      isChatInputCommand: () => false,
      isMessageComponent: () => false,
      options: {
        getFocused: () => {
          throw new Error('broken option');
        },
      },
    };
    await t.controller.handle(i as unknown as Interaction);
    expect(internalIncidents(t.metrics)).toHaveLength(1);
  });
});
