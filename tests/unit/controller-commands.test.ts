import { type APIEmbed, AttachmentBuilder, ChannelType, type Interaction, MessageFlags } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COLOR } from '../../src/discord/ui/format.ts';
import { exportGuild } from '../../src/import-export/config-io.ts';
import { RadioError } from '../../src/shared/errors.ts';
import { STATE_LABEL } from '../../src/voice/state-machine.ts';
import { makeSource } from '../helpers.ts';
import {
  ADMIN,
  decode,
  embedText,
  FakeCommand,
  type FakeInteraction,
  GUILD,
  type Harness,
  internalIncidents,
  MEMBER,
  OWNER,
  setup,
  TEXT,
  V1,
  V2,
} from './controller-harness.ts';

const PANEL = '800000000000000010';
const OLD_PANEL = '800000000000000011';
const EPHEMERAL = MessageFlags.Ephemeral;

/** Every embed of one call, as one string. */
const callText = (i: FakeInteraction, n: number) =>
  (i.calls[n]?.payload.embeds ?? []).map((e) => embedText(e.toJSON())).join('\n');
/** The first embed of the last call that had one. */
const lastEmbed = (i: FakeInteraction): APIEmbed =>
  [...i.calls]
    .reverse()
    .find((c) => (c.payload.embeds ?? []).length > 0)!
    .payload.embeds![0]!.toJSON();
const methods = (i: FakeInteraction) => i.calls.map((c) => c.method);

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

afterEach(() => {
  vi.useRealTimers();
});

describe('the entry point', () => {
  it('answers outside a server that the bot only works in servers, and stays silent when it cannot answer', async () => {
    const t = setup();
    const replies: unknown[] = [];
    const dm = {
      inCachedGuild: () => false,
      isRepliable: () => true,
      reply: async (p: unknown) => {
        replies.push(p);
      },
    };
    await t.controller.handle(dm as unknown as Interaction);
    expect(replies).toEqual([{ content: 'Radio Bot only works inside servers.', flags: EPHEMERAL }]);
    const unanswerable = { ...dm, isRepliable: () => false };
    await t.controller.handle(unanswerable as unknown as Interaction);
    expect(replies).toHaveLength(1);
  });

  it('refuses a subcommand it does not know', async () => {
    const t = setup();
    const i = await t.command(t.people.admin, { sub: 'no-such-command' });
    expect(i.acks).toBe(1);
    expect(i.ephemeral).toBe(true);
    expect(i.text).toMatch(/That command is not recognised/);
  });

  it('says no station matches, without counting it as an internal problem', async () => {
    const { t } = customServer();
    t.putInVoice(t.people.admin, V1);
    const i = await t.command(t.people.admin, { sub: 'play', strings: { station: 'Nothing Like It' } });
    expect(i.text).toMatch(/No station matches "Nothing Like It"\. Use \/radio browse/);
    expect(i.ephemeral).toBe(true);
    expect(internalIncidents(t.metrics)).toEqual([]);
    expect(t.sessions.plays).toEqual([]);
  });

  it('reports an unexpected failure privately, without its details, and records it', async () => {
    const t = setup();
    t.customFailures.set('Broken Station', new Error('disk full at /var/lib/secret'));
    const i = await t.command(t.people.admin, {
      sub: 'add',
      strings: { name: 'Broken Station', url: 'https://radio.example.org/live' },
    });
    expect(i.violations).toEqual([]);
    expect(methods(i)).toEqual(['deferReply', 'editReply']);
    expect(i.text).toMatch(/Something went wrong\. The details were logged/);
    expect(i.text).not.toMatch(/disk full/);
    expect(internalIncidents(t.metrics)).toHaveLength(1);
  });

  it('passes on the message of an expected error, which is not an internal problem', async () => {
    const t = setup();
    t.customFailures.set('Refused', new RadioError('ACCESS_DENIED', 'The stream host refused the request.'));
    const i = await t.command(t.people.admin, {
      sub: 'add',
      strings: { name: 'Refused', url: 'https://radio.example.org/live' },
    });
    expect(i.text).toMatch(/The stream host refused the request\./);
    expect(internalIncidents(t.metrics)).toEqual([]);
  });

  it('gives up quietly when even the error reply fails', async () => {
    const t = setup();
    t.customFailures.set('Broken Station', new Error('boom'));
    const i = new FakeCommand(t.people.admin, t.guild, {
      sub: 'add',
      strings: { name: 'Broken Station', url: 'https://radio.example.org/live' },
    });
    // The interaction has expired by the time the error is reported: that must not escape.
    i.editReply = async () => {
      throw new Error('Unknown interaction');
    };
    await expect(t.run(i)).resolves.toBe(i);
    expect(methods(i)).toEqual(['deferReply']);
    expect(internalIncidents(t.metrics)).toHaveLength(1);
  });
});

describe('/radio play', () => {
  it('joins the listener’s channel, then shows the station with its controls', async () => {
    const { t, st } = customServer();
    t.putInVoice(t.people.member, V1);
    const i = await t.command(t.people.member, { sub: 'play', strings: { station: 'My Station' } });
    expect(i.violations).toEqual([]);
    expect(methods(i)).toEqual(['deferReply', 'editReply', 'editReply']);
    expect(i.ephemeral).toBe(false);
    expect(callText(i, 1)).toMatch(/Joining <#700000000000000001> for \*\*My Station\*\*/);
    expect(t.sessions.plays).toEqual([{ guildId: GUILD, stationId: st.id, channelId: V1 }]);
    expect(t.sessions.requestedBy).toEqual([MEMBER]);
    const actions = i.componentIds.map((id) => decode(t.ids, id)?.action);
    expect(actions).toEqual(['prev', 'next', 'stop', 'leave', 'obrowse', 'now', 'fav', 'srcs', 'insp']);
  });

  it('says it is switching when the bot is already playing', async () => {
    const { t } = customServer();
    const other = t.addCustomStation('Other Station');
    playingIn(t, V1, other.id);
    t.putInVoice(t.people.admin, V1);
    const i = await t.command(t.people.admin, { sub: 'play', strings: { station: 'My Station' } });
    expect(callText(i, 1)).toMatch(/Switching to \*\*My Station\*\*/);
  });

  it('lists the queue under the station that started, five at most', async () => {
    const { t, st } = customServer();
    for (let n = 1; n <= 6; n++) t.guilds.enqueue(GUILD, t.addCustomStation(`Queued ${n}`).id, null);
    t.putInVoice(t.people.admin, V1);
    const i = await t.command(t.people.admin, { sub: 'play', strings: { station: st.id } });
    const shown = lastEmbed(i).fields!.find((f) => f.name.startsWith('Up next'))!;
    expect(shown.name).toBe('Up next (6 in the queue)');
    expect(shown.value).toBe('1. Queued 1\n2. Queued 2\n3. Queued 3\n4. Queued 4\n5. Queued 5\n…and 1 more');
  });

  it('refuses a retired station and one with no known stream, and plays nothing else instead', async () => {
    const { t } = customServer();
    t.putInVoice(t.people.admin, V1);
    const retired = t.addCustomStation('Old Station');
    t.stations.setCatalogueStatus(retired.id, 'retired');
    const silent = t.addCustomStation('Silent Station', false);
    const a = await t.command(t.people.admin, { sub: 'play', strings: { station: retired.id } });
    expect(a.text).toMatch(/Old Station is no longer in the catalogue, so it can’t be played/);
    const b = await t.command(t.people.admin, { sub: 'play', strings: { station: silent.id } });
    expect(b.text).toMatch(/no stream is known for it yet, so it can’t be played\. Nothing else was played/);
    for (const i of [a, b]) expect(i.ephemeral).toBe(true);
    expect(t.sessions.plays).toEqual([]);
  });

  it('explains each way a start can go wrong', async () => {
    const { t } = customServer();
    t.putInVoice(t.people.admin, V1);
    const play = () => t.command(t.people.admin, { sub: 'play', strings: { station: 'My Station' } });

    t.sessions.nextResult = { ok: false, code: 'CANCELLED', message: 'Cancelled.' };
    expect((await play()).lastText).toMatch(/Request replaced[\s\S]*newer station request took over/);

    t.sessions.nextResult = {
      ok: false,
      code: 'STREAM_STALLED',
      retrying: true,
      message: 'The stream stalled.',
    };
    expect((await play()).lastText).toMatch(
      /Starting My Station\nThe stream stalled\.\nCheck progress with \/radio now\./,
    );

    t.sessions.nextResult = {
      ok: false,
      code: 'NO_ELIGIBLE_SOURCE',
      message: 'No source of My Station can play right now.',
      selection: {
        eligibility: [
          { sourceId: 'custom-my-station-1', eligible: false, reasons: ['not verified', 'in cooldown'] },
          { sourceId: 'custom-my-station-2', eligible: true, reasons: [] },
        ],
      },
    };
    const none = await play();
    expect(none.lastText).toMatch(
      /\*\*Why each source was skipped:\*\*\n• `custom-my-station-1`: not verified; in cooldown/,
    );
    expect(none.lastText).not.toMatch(/custom-my-station-2/);
    expect(none.lastText).toMatch(/I will try again automatically/);

    t.sessions.nextResult = { ok: false, code: 'ACCESS_DENIED', message: 'The host refused the stream.' };
    const denied = await play();
    expect(denied.lastText).toMatch(/The host refused the stream\./);
    expect(denied.lastText).not.toMatch(/Why each source|try again automatically/);
  });

  it('asks for a voice channel when there is nowhere to play', async () => {
    const { t } = customServer();
    const i = await t.command(t.people.admin, { sub: 'play', strings: { station: 'My Station' } });
    expect(i.text).toMatch(/Join a voice channel first, or ask an admin to set a preferred voice channel/);
    expect(t.sessions.plays).toEqual([]);
  });

  it('plays in the preferred voice channel when the person asking is not in one', async () => {
    const { t, st } = customServer();
    t.guilds.updateSettings(GUILD, { preferredVoiceChannelId: V2 });
    await t.command(t.people.admin, { sub: 'play', strings: { station: 'My Station' } });
    expect(t.sessions.plays).toEqual([{ guildId: GUILD, stationId: st.id, channelId: V2 }]);
  });

  it('refuses an explicit channel other than the locked one', async () => {
    const { t } = customServer();
    t.guilds.updateSettings(GUILD, { voiceLock: true, preferredVoiceChannelId: V1 });
    t.putInVoice(t.people.admin, V1);
    const i = await t.command(t.people.admin, {
      sub: 'play',
      strings: { station: 'My Station' },
      channel: V2,
    });
    expect(i.text).toMatch(/locked to <#700000000000000001>/);
    expect(t.sessions.plays).toEqual([]);
  });

  it('is rate-limited per person and per server', async () => {
    const { t } = customServer();
    t.putInVoice(t.people.admin, V1);
    for (let n = 0; n < 6; n++) t.ctx.limits.playUser.take(ADMIN);
    const user = await t.command(t.people.admin, { sub: 'play', strings: { station: 'My Station' } });
    expect(user.text).toMatch(/Too many station changes in a short time\. Try again in \d+ s\./);
    expect(user.ephemeral).toBe(true);

    t.putInVoice(t.people.owner, V1);
    for (let n = 0; n < 12; n++) t.ctx.limits.playGuild.take(GUILD);
    const guild = await t.command(t.people.owner, { sub: 'play', strings: { station: 'My Station' } });
    expect(guild.text).toMatch(/Too many station changes/);
    expect(t.sessions.plays).toEqual([]);
    expect(internalIncidents(t.metrics)).toEqual([]);
  });
});

describe('the control panel', () => {
  it('is posted in the chosen text channel, remembered, and replaces the old one', async () => {
    const t = setup();
    const old = t.textChannel(OLD_PANEL);
    const panel = t.textChannel(PANEL);
    t.guilds.updateSettings(GUILD, { panelChannelId: OLD_PANEL, panelMessageId: '500000000000000099' });
    const i = await t.command(t.people.admin, { sub: 'panel', channel: PANEL });
    expect(i.violations).toEqual([]);
    expect(methods(i)).toEqual(['deferReply', 'editReply']);
    expect(i.text).toMatch(/Control panel posted[\s\S]*Posted in <#800000000000000010>/);
    expect(panel.sent).toHaveLength(1);
    const posted = panel.sent[0] as { allowedMentions: unknown; embeds: Array<{ toJSON(): APIEmbed }> };
    expect(posted.allowedMentions).toEqual({ parse: [] });
    expect(posted.embeds[0]!.toJSON().author?.name).toBe('Radio Bot control panel');
    const settings = t.guilds.getSettings(GUILD);
    expect(settings.panelChannelId).toBe(PANEL);
    expect(settings.panelMessageId).toBe('500000000000000001');
    expect(old.deleted).toEqual(['500000000000000099']);
  });

  it('goes in the current channel when no channel is named', async () => {
    const t = setup();
    const here = t.textChannel(TEXT);
    await t.command(t.people.admin, { sub: 'panel' });
    expect(here.sent).toHaveLength(1);
    expect(t.guilds.getSettings(GUILD).panelChannelId).toBe(TEXT);
  });

  it('refuses a voice channel, a channel it cannot see, and one it may not post in', async () => {
    const t = setup();
    const unseen = await t.command(t.people.admin, { sub: 'panel' });
    expect(unseen.text).toMatch(/Pick a text channel for the control panel/);
    t.textChannel(V2, ChannelType.GuildVoice);
    const voice = await t.command(t.people.admin, { sub: 'panel', channel: V2 });
    expect(voice.text).toMatch(/Pick a text channel for the control panel/);
    const muted = t.textChannel(PANEL);
    muted.canSend = false;
    t.guild.members.me = { id: '900000000000000099' };
    const denied = await t.command(t.people.admin, { sub: 'panel', channel: PANEL });
    expect(denied.text).toMatch(/I need View Channel and Send Messages in <#800000000000000010>/);
    expect(muted.sent).toEqual([]);
    expect(t.guilds.getSettings(GUILD).panelChannelId).toBeNull();
  });

  it('is updated when a station starts, and forgotten once its message is gone', async () => {
    const { t } = customServer();
    const panel = t.textChannel(PANEL);
    t.guilds.updateSettings(GUILD, { panelChannelId: PANEL, panelMessageId: '500000000000000001' });
    t.putInVoice(t.people.admin, V1);
    await t.command(t.people.admin, { sub: 'play', strings: { station: 'My Station' } });
    expect(panel.edits.map((e) => e.id)).toEqual(['500000000000000001']);

    // Any other failure (missing access, say) keeps the panel for next time.
    panel.editError = 50013;
    await t.command(t.people.admin, { sub: 'stop' });
    expect(t.guilds.getSettings(GUILD).panelMessageId).toBe('500000000000000001');

    panel.editError = 10008;
    await t.command(t.people.admin, { sub: 'leave' });
    expect(t.guilds.getSettings(GUILD)).toMatchObject({ panelChannelId: null, panelMessageId: null });
  });

  it('is left alone when its channel is no longer a text channel', async () => {
    const t = setup();
    t.guilds.updateSettings(GUILD, { panelChannelId: PANEL, panelMessageId: '500000000000000001' });
    t.clientChannels.set(PANEL, { isTextBased: () => false });
    await t.controller.refreshPanel(GUILD);
    expect(t.guilds.getSettings(GUILD).panelChannelId).toBe(PANEL);
  });
});

describe('/radio stop and /radio leave', () => {
  it('stop names who stopped the radio, in public, without pinging them', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    t.putInVoice(t.people.member, V1);
    const i = await t.command(t.people.member, { sub: 'stop' });
    expect(s.stops).toBe(1);
    expect(i.ephemeral).toBe(false);
    expect(i.text).toMatch(/<@900000000000000003> stopped the radio\. It won’t start again by itself/);
    expect(i.calls[0]!.payload.allowedMentions).toEqual({ parse: [] });
  });

  it('stop records the wish to stay stopped when nothing was playing', async () => {
    const t = setup();
    const i = await t.command(t.people.admin, { sub: 'stop' });
    expect(i.text).toMatch(/Nothing was playing/);
    expect(i.ephemeral).toBe(true);
    expect(t.guilds.getIntent(GUILD)?.desiredState).toBe('stopped');
  });

  it('leave disconnects the session, or records the wish to stay out', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    const i = await t.command(t.people.admin, { sub: 'leave' });
    expect(s.leaves).toEqual(['left']);
    expect(i.text).toMatch(/<@900000000000000002> disconnected the radio/);

    const fresh = setup();
    await fresh.command(fresh.people.admin, { sub: 'leave' });
    expect(fresh.guilds.getIntent(GUILD)?.desiredState).toBe('left');
  });
});

describe('/radio join', () => {
  it('asks for a channel when it cannot choose one', async () => {
    const t = setup();
    const i = await t.command(t.people.admin, { sub: 'join' });
    expect(i.text).toMatch(/Join a voice channel first, or pick one with the channel option/);
    expect(t.sessions.get(GUILD)).toBeNull();
  });

  it('is rate-limited like playing a station', async () => {
    const t = setup();
    t.putInVoice(t.people.admin, V1);
    for (let n = 0; n < 6; n++) t.ctx.limits.playUser.take(ADMIN);
    const i = await t.command(t.people.admin, { sub: 'join' });
    expect(i.text).toMatch(/Too many join requests in a short time/);
    expect(t.sessions.get(GUILD)).toBeNull();
  });
});

describe('/radio now, quality and status', () => {
  const plan = {
    targetKbps: 128,
    qualityMode: 'maximum',
    channelBitrateKbps: 64,
    sampleRateHz: 48_000,
    channels: 2,
    frameMs: 20,
    resampled: true,
    notes: ['Follows the source bitrate.'],
  };

  it('now shows the playing station, the queue, and the controls', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    s.fullStatus = { state: 'PLAYING', stationId: st.id, channelId: V1 };
    t.guilds.enqueue(GUILD, t.addCustomStation('Next Up').id, MEMBER);
    const i = await t.command(t.people.member, { sub: 'now' });
    expect(i.ephemeral).toBe(true);
    expect(i.text).toMatch(/▶ My Station/);
    expect(i.text).toMatch(/Up next \(1 in the queue\)\n1\. Next Up/);
    // A queue adds the Skip button.
    expect(i.componentIds.map((id) => decode(t.ids, id)?.action)).toContain('skip');
  });

  it('quality reports the whole audio path of the playing station', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    s.fullStatus = {
      stationId: st.id,
      channelId: V1,
      source: makeSource({ id: 'custom-my-station-1', stationId: st.id }),
      plan: plan as never,
      observedOutputKbps: 131,
    };
    const i = await t.command(t.people.member, { sub: 'quality' });
    expect(i.ephemeral).toBe(true);
    expect(i.text).toMatch(/Audio quality report/);
    expect(i.text).toMatch(/Station: \*\*My Station\*\* · source `custom-my-station-1`/);
    expect(i.text).toMatch(/Encoder target: \*\*128 kbps\*\* \(maximum quality\)/);
    expect(i.text).toMatch(/Voice channel bitrate setting: 64 kbps \(it does not limit the bot’s stream\)/);
  });

  it('quality says when nothing is playing', async () => {
    const t = setup();
    const i = await t.command(t.people.member, { sub: 'quality' });
    expect(i.text).toMatch(/Nothing is playing, so there is no active audio path to report/);
  });

  it('status says the radio is idle and was asked to do nothing', async () => {
    const t = setup();
    const i = await t.command(t.people.member, { sub: 'status' });
    const e = lastEmbed(i);
    expect(e.fields!.map((f) => [f.name, f.value])).toEqual([
      ['Right now', 'Idle'],
      ['Asked to', 'nothing'],
    ]);
    expect(e.color).toBe(COLOR.neutral);
    expect(e.description).toBeUndefined();
  });

  it('status shows the state, the source, the last problem and why playback was not resumed', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    t.guilds.setIntent(GUILD, {
      desiredState: 'playing',
      desiredStationId: st.id,
      lastErrorCode: 'RESUME_DISABLED',
    });
    s.fullStatus = {
      state: 'ERROR',
      channelId: V1,
      source: makeSource({ id: 'custom-my-station-1', stationId: st.id }),
      lastError: {
        code: 'STREAM_STALLED',
        message: 'The stream stopped sending audio.',
        at: new Date().toISOString(),
      },
    };
    const i = await t.command(t.people.member, { sub: 'status' });
    const e = lastEmbed(i);
    expect(e.color).toBe(COLOR.error);
    expect(e.fields![0]).toMatchObject({ name: 'Right now', value: `${STATE_LABEL.ERROR} in <#${V1}>` });
    expect(e.fields![1]).toMatchObject({ name: 'Asked to', value: 'play: My Station' });
    expect(e.fields![2]).toMatchObject({ name: 'Source' });
    expect(e.description).toBe(
      '⚠️ The stream stopped sending audio.\nPlayback wasn’t resumed after the last restart, because **Resume after restart** is off.',
    );
  });

  it('status is green while playing', async () => {
    const { t, st } = customServer();
    playingIn(t, V1, st.id).fullStatus = { state: 'PLAYING', channelId: V1 };
    expect(lastEmbed(await t.command(t.people.member, { sub: 'status' })).color).toBe(COLOR.ok);
  });
});

describe('/radio stats', () => {
  const ws = { lastMs: 20, avgMs: 21, minMs: 19, maxMs: 25, jitterMs: 2, samples: 5 };

  it('shows live figures for a direct stream, without contacting a blocked address', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    s.fullStatus = {
      state: 'PLAYING',
      stationId: st.id,
      channelId: V1,
      source: makeSource({ id: 'custom-my-station-1', stationId: st.id, label: 'Main stream' }),
      plan: { qualityMode: 'maximum' } as never,
      failovers: 2,
      reconnects: 1,
      encoderPid: 4321,
      ffmpegWarnings: ['first', 'second', 'third', 'fourth'],
    };
    s.live = {
      connectedSince: Date.now() - 60_000,
      input: {
        requestedHost: 'radio.example.org',
        finalHost: 'cdn.example.org',
        // Loopback is never contacted: the policy refuses it, so no round trip is measured.
        remoteAddress: '127.0.0.1',
        remotePort: 443,
        redirects: ['https://cdn.example.org/live'],
        transport: 'http-continuous',
        segmentHost: null,
        segmentsFetched: 0,
        segmentFailures: 0,
        skippedSegments: 0,
        kbps10s: 128.4,
        kbps60s: null,
        bytes: 2 * 1048576,
      },
      output: { targetKbps: 128, channelBitrateKbps: 64, kbps10s: 130, kbps60s: 129, bytes: 1 },
      voice: {
        // An address, not a host name, so the lookup never leaves the machine.
        endpoint: '192.0.2.10:443',
        status: 'ready',
        encryption: 'aead_aes256_gcm_rtpsize',
        encryptionMode: 'dave',
        packetsPlayed: 3000,
        packetsPerSecond: 50,
        latePackets: 0,
        worstPacketGapMs: 21,
        ws,
      },
    };
    t.clientChannels.set(V1, { rtcRegion: null });
    (t.ctx.client as unknown as { ws: { ping: number } }).ws.ping = 42;
    const i = await t.command(t.people.admin, { sub: 'stats' });
    expect(i.violations).toEqual([]);
    const live = i.calls[1]!.payload.embeds![0]!.toJSON();
    expect(live.title).toBe('Live stats: My Station');
    expect(live.color).toBe(COLOR.ok);
    expect(live.description).toMatch(
      /\*\*State:\*\* Playing · source `custom-my-station-1` \(Main stream\) · voice connected <t:\d+:R>/,
    );
    const text = embedText(live);
    for (const line of [
      'Requested: `radio.example.org` → redirected to `cdn.example.org`',
      'Connected to: `127.0.0.1:443`',
      'Transport: direct HTTP stream',
      'Live input rate: 128 kbps (10 s) · — (60 s) · 2.0 MB received',
      'Round trip to the stream server (TCP): not measured yet',
      'Opus target: 128 kbps (maximum) · voice channel setting 64 kbps (not a cap)',
      'Sent to Discord: 130 kbps (10 s) · 129 kbps (60 s)',
      'Packets to Discord: 50 per second (expect ~50) · 3000 sent on this connection',
      'Voice server: `192.0.2.10` · `192.0.2.10` · channel region: automatic',
      'Voice WebSocket ping: 20 ms (avg 21, min 19, max 25, jitter 2 ms, 5 samples)',
      'Gateway ping: 42 ms',
      'Encryption: aead_aes256_gcm_rtpsize · dave',
      'Source switches after a failure: 2 · voice reconnects: 1 · encoder PID: 4321',
    ]) {
      expect(text).toContain(line);
    }
    // Only the last three FFmpeg warnings are shown.
    expect(live.fields!.find((f) => f.name === 'FFmpeg warnings')?.value).toBe('second\nthird\nfourth');
  });

  it('shows segment figures for an HLS stream, and dashes for what is not known', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    s.fullStatus = { state: 'BUFFERING', stationId: st.id, channelId: V1 };
    s.live = {
      connectedSince: null,
      input: {
        requestedHost: 'radio.example.org',
        finalHost: 'radio.example.org',
        remoteAddress: null,
        remotePort: null,
        redirects: [],
        transport: 'hls',
        segmentHost: 'segments.example.org',
        segmentsFetched: 10,
        segmentFailures: 1,
        skippedSegments: 2,
        kbps10s: null,
        kbps60s: null,
        bytes: 0,
      },
      output: null,
      voice: null,
    };
    const i = await t.command(t.people.admin, { sub: 'stats' });
    const live = i.calls[1]!.payload.embeds![0]!.toJSON();
    expect(live.color).toBe(COLOR.neutral);
    expect(live.description).toBe('**State:** Starting the stream · source `—`');
    const text = embedText(live);
    for (const line of [
      'Requested: `radio.example.org`\n',
      'Connected to: `unknown`',
      'HLS segments: 10 fetched, 1 failed, 2 skipped · last from `segments.example.org`',
      'Codec: unknown',
      'Opus target: — · voice channel setting — (not a cap)',
      'Packets to Discord: — per second (expect ~50) · — sent on this connection',
      'Voice server: `unknown` · channel region: unknown',
      'Voice WebSocket ping: not measured yet',
      'Gateway ping: not measured yet',
      'Encryption: —',
    ]) {
      expect(text).toContain(line);
    }
    expect(live.fields!.some((f) => f.name === 'FFmpeg warnings')).toBe(false);
  });

  it('says no stream is running while the bot is connected but not streaming', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    s.fullStatus = { state: 'CONNECTED', stationId: st.id, channelId: V1 };
    s.live = { connectedSince: null, input: null, output: null, voice: null };
    const i = await t.command(t.people.admin, { sub: 'stats' });
    expect(i.calls[1]!.payload.embeds![0]!.toJSON().description).toBe(
      `State: ${STATE_LABEL.CONNECTED}. No stream is running, so there are no live figures yet.`,
    );
  });

  it('lists each station pack with its last sync, and the recent problems', async () => {
    const t = setup();
    const pack = t.ctx.packs.packs[0]!;
    const before = await t.command(t.people.admin, { sub: 'stats' });
    expect(callText(before, 1)).toMatch(/list never synced/);
    expect(callText(before, 1)).toMatch(/Recent problems \(repeats grouped\)\nNone\./);
    t.stations.insertSyncReport({
      provider: pack.meta.id,
      startedAt: '2026-10-30T09:59:00.000Z',
      finishedAt: '2026-10-30T10:00:00.000Z',
      success: false,
      trigger: 'scheduled',
      summary: {},
    });
    t.metrics.incident(GUILD, 'STREAM_STALLED', 'upstream', 'the stream dropped');
    const after = await t.command(t.people.admin, { sub: 'stats' });
    const text = callText(after, 1);
    expect(text).toContain(`**${pack.meta.name}** (\`${pack.meta.id}\`): `);
    expect(text).toMatch(/list synced 2026-10-30 10:00 UTC \(failed\)/);
    expect(text).toMatch(/STREAM_STALLED \[upstream\] ×1: the stream dropped/);
    expect(text).toMatch(/libopus: missing/);
  });

  it('marks a switched-off pack as disabled', async () => {
    const t = setup({ customOnly: true });
    const pack = t.ctx.packs.packs[0]!;
    const i = await t.command(t.people.admin, { sub: 'stats' });
    expect(callText(i, 1)).toContain(`**${pack.meta.name}** (\`${pack.meta.id}\`): disabled`);
  });
});

describe('/radio queue', () => {
  it('list says when the queue is empty', async () => {
    const t = setup();
    const i = await t.command(t.people.member, { group: 'queue', sub: 'list' });
    const e = lastEmbed(i);
    expect(e.title).toBe('Queue · 0 stations');
    expect(e.description).toBe('The queue is empty. Add stations with `/radio queue add`.');
    expect(i.ephemeral).toBe(true);
  });

  it('list shows each entry, who added it, and what is playing, without pinging anyone', async () => {
    const { t, st } = customServer();
    const a = t.addCustomStation('First Up');
    const b = t.addCustomStation('Second Up');
    t.guilds.enqueue(GUILD, a.id, MEMBER);
    t.guilds.enqueue(GUILD, b.id, null);
    playingIn(t, V1, st.id);
    const i = await t.command(t.people.member, { group: 'queue', sub: 'list' });
    const e = lastEmbed(i);
    expect(e.title).toBe('Queue · 2 stations');
    expect(e.description).toMatch(
      /^1\. \*\*First Up\*\* — .* — added by <@900000000000000003>\n2\. \*\*Second Up\*\* — [^\n]*$/,
    );
    expect(e.description).not.toMatch(/2\..*added by/);
    expect(e.fields).toEqual([{ name: 'Playing now', value: 'My Station' }]);
    expect(i.calls[0]!.payload.allowedMentions).toEqual({ parse: [] });
  });

  it('list says "station" for one entry', async () => {
    const { t, st } = customServer();
    t.guilds.enqueue(GUILD, st.id, null);
    expect(lastEmbed(await t.command(t.people.member, { group: 'queue', sub: 'list' })).title).toBe(
      'Queue · 1 station',
    );
  });

  it('clear empties the queue and says how many went', async () => {
    const { t, st } = customServer();
    t.guilds.enqueue(GUILD, st.id, null);
    const once = await t.command(t.people.admin, { group: 'queue', sub: 'clear' });
    expect(once.text).toMatch(/Removed 1 station\./);
    const twice = await t.command(t.people.admin, { group: 'queue', sub: 'clear' });
    expect(twice.text).toMatch(/Removed 0 stations\./);
    expect(t.guilds.listQueue(GUILD)).toEqual([]);
  });

  it('remove takes out one position, and says when there is nothing there', async () => {
    const { t, st } = customServer();
    const other = t.addCustomStation('Other Station');
    t.guilds.enqueue(GUILD, st.id, null);
    t.guilds.enqueue(GUILD, other.id, null);
    const ok = await t.command(t.people.admin, { group: 'queue', sub: 'remove', ints: { position: 2 } });
    expect(ok.text).toMatch(/Removed from queue\nOther Station was number 2 in the queue\./);
    expect(t.guilds.listQueue(GUILD).map((e) => e.stationId)).toEqual([st.id]);
    const missing = await t.command(t.people.admin, { group: 'queue', sub: 'remove', ints: { position: 5 } });
    expect(missing.text).toMatch(/There is no station at position 5\./);
    expect(missing.ephemeral).toBe(true);
  });

  it('add starts the station straight away when nothing is playing', async () => {
    const { t, st } = customServer();
    t.putInVoice(t.people.admin, V1);
    const i = await t.command(t.people.admin, { group: 'queue', sub: 'add', strings: { station: st.id } });
    expect(methods(i)).toEqual(['deferReply', 'editReply', 'editReply']);
    expect(t.sessions.plays).toEqual([{ guildId: GUILD, stationId: st.id, channelId: V1 }]);
    expect(t.guilds.listQueue(GUILD)).toEqual([]);
  });

  it('add lines a station up behind the playing one, and says how to skip to it', async () => {
    const { t, st } = customServer();
    const a = t.addCustomStation('First Up');
    const b = t.addCustomStation('Second Up');
    playingIn(t, V1, st.id);
    const first = await t.command(t.people.admin, { group: 'queue', sub: 'add', strings: { station: a.id } });
    expect(first.text).toMatch(
      /\*\*First Up\*\* is number 1 in the queue\. Use \/radio skip to play it now\./,
    );
    expect(first.ephemeral).toBe(false);
    expect(first.calls[0]!.payload.allowedMentions).toEqual({ parse: [] });
    const second = await t.command(t.people.admin, {
      group: 'queue',
      sub: 'add',
      strings: { station: b.id },
    });
    expect(second.text).toMatch(/\*\*Second Up\*\* is number 2 in the queue\.$/m);
    expect(t.guilds.listQueue(GUILD).map((e) => [e.stationId, e.addedById])).toEqual([
      [a.id, ADMIN],
      [b.id, ADMIN],
    ]);
    expect(t.sessions.plays).toEqual([]);
  });

  it('add refuses when the queue is full', async () => {
    const { t, st } = customServer();
    playingIn(t, V1, st.id);
    for (let n = 0; n < 25; n++) t.guilds.enqueue(GUILD, st.id, null);
    const i = await t.command(t.people.admin, { group: 'queue', sub: 'add', strings: { station: st.id } });
    expect(i.text).toMatch(/The queue is full \(25 stations\)\./);
    expect(t.guilds.listQueue(GUILD)).toHaveLength(25);
  });

  it('add refuses stations that cannot be played', async () => {
    const { t } = customServer();
    const retired = t.addCustomStation('Old Station');
    t.stations.setCatalogueStatus(retired.id, 'retired');
    const silent = t.addCustomStation('Silent Station', false);
    const a = await t.command(t.people.admin, {
      group: 'queue',
      sub: 'add',
      strings: { station: retired.id },
    });
    expect(a.text).toMatch(/Old Station is no longer in the catalogue/);
    const b = await t.command(t.people.admin, {
      group: 'queue',
      sub: 'add',
      strings: { station: silent.id },
    });
    expect(b.text).toMatch(/Silent Station can’t be played because no stream is known for it yet/);
    expect(t.guilds.listQueue(GUILD)).toEqual([]);
    expect(t.sessions.plays).toEqual([]);
  });
});

describe('/radio skip', () => {
  it('says when the queue is empty', async () => {
    const t = setup();
    const i = await t.command(t.people.admin, { sub: 'skip' });
    expect(i.text).toMatch(/The queue is empty\. Add stations with \/radio queue add\./);
  });

  it('drops entries that can no longer play, starts the next one, and takes it off the queue', async () => {
    const { t, st } = customServer();
    const silent = t.addCustomStation('Silent Station', false);
    t.guilds.enqueue(GUILD, silent.id, null);
    t.guilds.enqueue(GUILD, st.id, null);
    t.putInVoice(t.people.admin, V1);
    const i = await t.command(t.people.admin, { sub: 'skip' });
    expect(i.violations).toEqual([]);
    expect(i.ephemeral).toBe(false);
    expect(t.sessions.plays.map((p) => p.stationId)).toEqual([st.id]);
    expect(t.guilds.listQueue(GUILD)).toEqual([]);
  });

  it('keeps the station queued when the skip is refused', async () => {
    const { t, st } = customServer();
    t.guilds.enqueue(GUILD, st.id, null);
    t.putInVoice(t.people.admin, V1);
    for (let n = 0; n < 6; n++) t.ctx.limits.playUser.take(ADMIN);
    const i = await t.command(t.people.admin, { sub: 'skip' });
    expect(i.text).toMatch(/Too many station changes/);
    expect(t.guilds.listQueue(GUILD).map((e) => e.stationId)).toEqual([st.id]);
  });

  it('answers the Skip button privately', async () => {
    const { t, st } = customServer();
    t.guilds.enqueue(GUILD, st.id, null);
    t.putInVoice(t.people.admin, V1);
    const i = await t.click(t.people.admin, t.ids.make(GUILD, 'skip'));
    expect(i.calls[0]).toMatchObject({ method: 'deferReply', payload: { flags: EPHEMERAL } });
    expect(t.sessions.plays.map((p) => p.stationId)).toEqual([st.id]);
  });
});

describe('custom stations', () => {
  it('add checks the stream, gives the ID, and warns about plain HTTP', async () => {
    const t = setup();
    const i = await t.command(t.people.admin, {
      sub: 'add',
      strings: { name: 'My Station', url: 'http://radio.example.org/live', website: null },
    });
    expect(i.violations).toEqual([]);
    expect(i.calls[0]).toMatchObject({ method: 'deferReply', payload: { flags: EPHEMERAL } });
    expect(i.text).toMatch(/Added: My Station/);
    expect(i.text).toMatch(/Stream checked: .* · 128 kbps · 44100 Hz · 2 channel\(s\) · Direct HTTP stream/);
    expect(i.text).toMatch(/Station ID: `custom:my-station` \(custom, this server only\)\./);
    expect(i.text).toMatch(/⚠ This stream uses plain HTTP, so it is not encrypted/);
    expect(t.customAdds).toEqual(['My Station']);
  });

  it('add says what it could not measure, and does not warn about HTTPS', async () => {
    const t = setup();
    t.custom.report = {
      outcome: {
        codec: null,
        profile: null,
        measuredBitrateKbps: null,
        codecBitrateKbps: null,
        sampleRateHz: null,
        channels: null,
        transport: 'hls',
      },
    };
    const i = await t.command(t.people.admin, {
      sub: 'add',
      strings: { name: 'My Station', url: 'https://radio.example.org/live.m3u8' },
    });
    expect(i.text).toMatch(/ · \? kbps · \? Hz · \? channel\(s\) · HLS/);
    expect(i.text).not.toMatch(/plain HTTP/);
  });

  it('add is limited to five stations an hour per server', async () => {
    const t = setup();
    for (let n = 1; n <= 5; n++) {
      await t.command(t.people.admin, {
        sub: 'add',
        strings: { name: `Station ${n}`, url: 'https://radio.example.org/live' },
      });
    }
    const sixth = await t.command(t.people.admin, {
      sub: 'add',
      strings: { name: 'Station 6', url: 'https://radio.example.org/live' },
    });
    expect(sixth.text).toMatch(/Too many stations added in a short time/);
    expect(sixth.acks).toBe(1);
    expect(t.customAdds).toHaveLength(5);
  });

  it('edit refuses pack stations', async () => {
    const t = setup();
    const packStation = t.stations.listStations(GUILD).find((s) => s.provider !== 'custom')!;
    const i = await t.command(t.people.admin, {
      sub: 'edit',
      strings: { station: packStation.id, name: 'Renamed' },
    });
    expect(i.text).toMatch(/Only custom stations can be edited\./);
    expect(t.customEdits).toEqual([]);
  });

  it('edit passes on only the options that were given, without a stream check', async () => {
    const { t, st } = customServer();
    const i = await t.command(t.people.admin, {
      sub: 'edit',
      strings: { station: st.id, name: 'Renamed Station', description: 'Late-night music' },
    });
    expect(i.calls[0]).toMatchObject({ method: 'deferReply', payload: { flags: EPHEMERAL } });
    expect(i.text).toMatch(/Updated\nRenamed Station was updated\./);
    expect(t.customEdits).toEqual([
      { id: st.id, patch: { name: 'Renamed Station', description: 'Late-night music' } },
    ]);
    // No new URL, so none of the three stream checks was used.
    expect([0, 1, 2].map(() => t.ctx.limits.probeGuild.take(GUILD))).toEqual([0, 0, 0]);
  });

  it('edit with a new URL and website counts as a stream check, and is rate-limited', async () => {
    const { t, st } = customServer();
    const edit = () =>
      t.command(t.people.admin, {
        sub: 'edit',
        strings: { station: st.id, url: 'https://radio.example.org/new', website: 'https://example.org' },
      });
    await edit();
    expect(t.customEdits[0]!.patch).toEqual({
      url: 'https://radio.example.org/new',
      website: 'https://example.org',
    });
    await edit();
    await edit();
    const fourth = await edit();
    expect(fourth.text).toMatch(/Too many stream checks in a short time/);
    expect(t.customEdits).toHaveLength(3);
  });

  it('remove refuses pack stations', async () => {
    const t = setup();
    const packStation = t.stations.listStations(GUILD).find((s) => s.provider !== 'custom')!;
    const i = await t.command(t.people.admin, { sub: 'remove', strings: { station: packStation.id } });
    expect(i.text).toMatch(/Only custom stations can be removed, not stations from a station pack\./);
    expect(t.customRemoves).toEqual([]);
  });

  it('remove stops the station if it plays, and clears it as the default', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    t.guilds.updateSettings(GUILD, { defaultStationId: st.id });
    const i = await t.command(t.people.admin, { sub: 'remove', strings: { station: st.id } });
    expect(i.text).toMatch(/Removed\nMy Station was removed\./);
    expect(i.ephemeral).toBe(true);
    expect(s.stops).toBe(1);
    expect(t.customRemoves).toEqual([st.id]);
    expect(t.guilds.getSettings(GUILD).defaultStationId).toBeNull();
  });

  it('remove leaves another playing station and default alone, and says when nothing was removed', async () => {
    const { t, st } = customServer();
    const other = t.addCustomStation('Other Station');
    const s = playingIn(t, V1, other.id);
    t.guilds.updateSettings(GUILD, { defaultStationId: other.id });
    t.custom.removeResult = false;
    const i = await t.command(t.people.admin, { sub: 'remove', strings: { station: st.id } });
    expect(i.text).toMatch(/Not found\nNothing was removed\./);
    expect(s.stops).toBe(0);
    expect(t.guilds.getSettings(GUILD).defaultStationId).toBe(other.id);
  });
});

describe('/radio rescan', () => {
  const report = (id: string, ok: boolean) => ({
    source: { id },
    outcome: ok
      ? { success: true, codec: 'mp3', profile: null, measuredBitrateKbps: 128 }
      : { success: false, failureCode: 'TIMEOUT' },
    identity: { status: ok ? 'verified' : 'unverified' },
  });

  it('checks every source again, shows progress, and summarises each one', async () => {
    const { t, st } = customServer();
    t.rescan.progress = [
      [1, 2],
      [2, 2],
    ];
    t.rescan.reports = [report('custom-my-station-1', true), report('custom-my-station-2', false)];
    const i = await t.command(t.people.admin, { sub: 'rescan', strings: { station: st.id } });
    expect(i.violations).toEqual([]);
    expect(t.probes).toEqual([st.id]);
    // Progress is shown until the last source; then the result replaces it.
    expect(methods(i)).toEqual(['deferReply', 'editReply', 'editReply']);
    expect(callText(i, 1)).toBe('Checking sources\nChecked 1 of 2…');
    const summary = i.calls[2]!.payload.embeds![0]!.toJSON();
    expect(summary.title).toBe('Checked 2 sources again');
    expect(summary.description).toMatch(
      /^• `custom-my-station-1`: .* 128 kbps · identity verified\n• `custom-my-station-2`: check failed \(TIMEOUT\)$/,
    );
    expect(i.calls[2]!.payload.embeds!.length).toBe(2);
  });

  it('adds the audio comparison when asked', async () => {
    const { t, st } = customServer();
    t.rescan.reports = [report('custom-my-station-1', true)];
    t.compare.results = [
      {
        sourceId: 'custom-my-station-2',
        evidence: { detail: 'Same audio as the verified source.' },
        error: null,
      },
      { sourceId: 'custom-my-station-3', evidence: null, error: 'timed out' },
    ];
    const i = await t.command(t.people.admin, {
      sub: 'rescan',
      strings: { station: st.id },
      bools: { compare: true },
    });
    const summary = i.calls.at(-1)!.payload.embeds![0]!.toJSON();
    expect(summary.title).toBe('Checked 1 source again');
    expect(summary.description).toMatch(
      /\*\*Audio comparison:\*\*\n• `custom-my-station-2`: Same audio as the verified source\.\n• `custom-my-station-3`: timed out/,
    );
    expect(t.compare.calls).toEqual([st.id]);
  });

  it('says when there was nothing to compare, or the comparison could not run', async () => {
    const { t, st } = customServer();
    const rescan = () =>
      t.command(t.people.admin, { sub: 'rescan', strings: { station: st.id }, bools: { compare: true } });
    expect((await rescan()).text).toMatch(/There were no unverified sources to compare\./);
    t.compare.error = new RadioError('NO_ELIGIBLE_SOURCE', 'There is no verified source to compare against.');
    expect((await rescan()).text).toMatch(
      /The audio comparison did not run: There is no verified source to compare against\./,
    );
    t.compare.error = new Error('crashed');
    const failed = await rescan();
    expect(failed.text).toMatch(/The audio comparison did not run: it failed\./);
    expect(failed.text).not.toMatch(/crashed/);
  });

  it('is limited to three checks per server every ten minutes', async () => {
    const { t, st } = customServer();
    for (let n = 0; n < 3; n++)
      await t.command(t.people.admin, { sub: 'rescan', strings: { station: st.id } });
    const fourth = await t.command(t.people.admin, { sub: 'rescan', strings: { station: st.id } });
    expect(fourth.text).toMatch(/Too many stream checks/);
    expect(t.probes).toHaveLength(3);
  });

  it('runs from the Check sources again button too', async () => {
    const { t, st } = customServer();
    const i = await t.click(t.people.admin, t.ids.make(GUILD, 'rescan', st.id));
    expect(i.calls[0]).toMatchObject({ method: 'deferReply', payload: { flags: EPHEMERAL } });
    expect(t.probes).toEqual([st.id]);
    const gone = await t.click(t.people.admin, t.ids.make(GUILD, 'rescan', 'custom:not-here'));
    expect(gone.text).toMatch(/That station is no longer available\./);
  });
});

describe('/radio sync', () => {
  it('says when no enabled pack has an official list', async () => {
    const t = setup();
    const i = await t.command(t.people.admin, { sub: 'sync' });
    expect(i.text).toMatch(/None of the enabled station packs has an official list to check against\./);
    expect(t.sync.calls).toEqual([]);
  });

  it('refuses a pack it cannot sync', async () => {
    const t = setup();
    t.sync.syncable = [t.ctx.packs.packs[0]!.meta.id];
    const i = await t.command(t.people.admin, { sub: 'sync', strings: { pack: 'custom' } });
    expect(i.text).toMatch(/That pack is either not enabled or has no official list/);
    expect(t.sync.calls).toEqual([]);
  });

  it('syncs one pack and reports every change', async () => {
    const t = setup();
    const pack = t.ctx.packs.packs[0]!;
    t.sync.syncable = [pack.meta.id];
    t.sync.reports.set(pack.meta.id, {
      officialCount: 12,
      added: ['New One'],
      renamed: [{ from: 'Old Name', to: 'New Name' }],
      missing: ['Gone One'],
      returned: ['Back One'],
      needsSourceMapping: ['New One'],
      unreachable: ['Down One'],
    });
    const i = await t.command(t.people.admin, { sub: 'sync', strings: { pack: pack.meta.id } });
    expect(i.calls[0]).toMatchObject({ method: 'deferReply', payload: { flags: EPHEMERAL } });
    expect(t.sync.calls).toEqual([pack.meta.id]);
    const e = lastEmbed(i);
    expect(e.title).toBe('Catalogue sync report');
    expect(e.color).toBe(COLOR.ok);
    expect(e.description).toBe(
      [
        `**${pack.meta.name}**: the official list has 12 stations.`,
        'Added: New One',
        'Renamed: Old Name → New Name',
        'No longer on the official list: Gone One (kept here, so favourites still work)',
        'Back on the list: Back One',
        'New stations with no stream yet (they can’t play until a reviewed source is added to the pack): New One',
        'Stations whose sources all failed their last check: Down One',
      ].join('\n'),
    );
  });

  it('syncs every pack, says when nothing changed, and reports a failure in amber', async () => {
    const t = setup();
    const pack = t.ctx.packs.packs[0]!;
    t.sync.syncable = [pack.meta.id];
    const quiet = await t.command(t.people.admin, { sub: 'sync' });
    expect(t.sync.calls).toEqual(['*']);
    expect(lastEmbed(quiet).description).toMatch(
      /Added: none\nRenamed: none\nNo longer on the official list: none\nBack on the list: none\nNo new stations are waiting for a stream\.\nNo station has all of its checked sources failing\./,
    );

    const other = setup();
    other.sync.syncable = [pack.meta.id];
    other.sync.reports.set(pack.meta.id, { ok: false, error: 'The list could not be fetched.' });
    const failed = await other.command(other.people.admin, { sub: 'sync' });
    const e = lastEmbed(failed);
    expect(e.color).toBe(COLOR.warn);
    expect(e.description).toBe(
      `**${pack.meta.name}**: the sync failed. The list could not be fetched.\nNothing was removed. The list is marked as possibly out of date.`,
    );
  });

  it('is rate-limited for the whole installation', async () => {
    const t = setup();
    t.sync.syncable = [t.ctx.packs.packs[0]!.meta.id];
    await t.command(t.people.admin, { sub: 'sync' });
    const again = await t.command(t.people.owner, { sub: 'sync' });
    expect(again.text).toMatch(/Too many catalogue syncs in a short time/);
    expect(t.sync.calls).toEqual(['*']);
  });
});

describe('/radio config', () => {
  it('sets the default station by name and a manual bitrate, which applies at once', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    const i = await t.command(t.people.admin, {
      sub: 'config',
      strings: { default_station: 'My Station' },
      ints: { manual_bitrate: 256 },
    });
    expect(i.ephemeral).toBe(true);
    expect(t.guilds.getSettings(GUILD)).toMatchObject({ defaultStationId: st.id, manualBitrateKbps: 256 });
    expect(s.encoderRefreshes).toBe(1);
    expect(i.text).toMatch(/The station restarts for a moment to use the new quality\./);
    expect(i.text).toMatch(/Default station: My Station/);
    expect(i.text).toMatch(/Page: Access/);
  });

  it('clears the default station when "none" is typed, in any case', async () => {
    const { t, st } = customServer();
    t.guilds.updateSettings(GUILD, { defaultStationId: st.id });
    await t.command(t.people.admin, { sub: 'config', strings: { default_station: ' None ' } });
    expect(t.guilds.getSettings(GUILD).defaultStationId).toBeNull();
  });

  it('changes nothing for an unknown default station, and does not touch the encoder', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    t.guilds.updateSettings(GUILD, { defaultStationId: st.id });
    const i = await t.command(t.people.admin, {
      sub: 'config',
      strings: { default_station: 'Nothing Like It' },
    });
    expect(i.text).toMatch(/No station matches/);
    expect(t.guilds.getSettings(GUILD).defaultStationId).toBe(st.id);
    await t.command(t.people.admin, { sub: 'config' });
    expect(s.encoderRefreshes).toBe(0);
  });
});

describe('/radio export', () => {
  it('sends this server’s settings as a private JSON file', async () => {
    const { t } = customServer();
    t.guilds.updateSettings(GUILD, { qualityMode: 'balanced', allowedTextChannelIds: [TEXT] });
    const i = await t.command(t.people.admin, { sub: 'export' });
    expect(i.ephemeral).toBe(true);
    expect(i.text).toMatch(/The file contains no tokens/);
    const [file] = i.calls[0]!.payload.files as AttachmentBuilder[];
    expect(file).toBeInstanceOf(AttachmentBuilder);
    expect(file!.name).toBe(`radio-bot-config-${GUILD}.json`);
    const data = JSON.parse(String(file!.attachment));
    const expected = exportGuild(GUILD, t.guilds, t.stations);
    expect(data).toEqual({ ...expected, exportedAt: data.exportedAt });
    expect(data.settings).toMatchObject({ qualityMode: 'balanced', allowedTextChannelIds: [TEXT] });
  });
});

describe('/radio import', () => {
  const ATTACHMENT = { size: 1000, url: 'https://cdn.discordapp.com/attachments/1/2/radio.json' };
  const preview = (t: Harness) => t.command(t.people.admin, { sub: 'import', attachment: ATTACHMENT });

  it('refuses a file too big to be an export, and one not stored on Discord, without reading it', async () => {
    const t = setup();
    let fetched = 0;
    (t.ctx.http as unknown as { fetchText(): Promise<{ text: string }> }).fetchText = async () => {
      fetched++;
      return { text: '' };
    };
    const big = await t.command(t.people.admin, {
      sub: 'import',
      attachment: { size: 300 * 1024, url: ATTACHMENT.url },
    });
    expect(big.text).toMatch(/That file is too big to be a settings export \(the limit is 256 KB\)\./);
    const elsewhere = await t.command(t.people.admin, {
      sub: 'import',
      attachment: { size: 1000, url: 'https://files.example.org/radio.json' },
    });
    expect(elsewhere.text).toMatch(/That attachment is not stored on Discord, so it was not read\./);
    expect(fetched).toBe(0);
  });

  it('says why a file is not a settings export', async () => {
    const t = setup();
    t.setImport('this is not JSON');
    const i = await preview(t);
    expect(i.violations).toEqual([]);
    expect(methods(i)).toEqual(['deferReply', 'editReply']);
    expect(lastEmbed(i).title).toMatch(/Couldn’t do that/);
    expect(i.componentIds).toEqual([]);
  });

  it('warns about channels and roles this server does not have', async () => {
    const t = setup();
    t.guild.channels.cache.set(TEXT, {});
    const data = exportGuild(GUILD, t.guilds, t.stations);
    data.settings.allowedTextChannelIds = [TEXT, '800000000000000077'];
    data.settings.djRoleIds = ['600000000000000077'];
    t.setImport(JSON.stringify(data));
    const i = await preview(t);
    expect(i.text).toMatch(/Import preview \(nothing has changed yet\)/);
    expect(i.text).toMatch(
      /\*\*Warnings\*\*\n⚠ 1 channel ID\(s\) do not exist here and will be dropped\.\n⚠ 1 role ID\(s\)/,
    );
  });

  it('applies settings to the station already playing and rechecks who is listening', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    t.guild.voiceStates.cache.set('900000000000000011', { channelId: V1, member: { user: { bot: false } } });
    t.guild.voiceStates.cache.set('900000000000000012', { channelId: V1, member: { user: { bot: true } } });
    t.guild.voiceStates.cache.set('900000000000000013', { channelId: V1 });
    t.guild.voiceStates.cache.set('900000000000000014', { channelId: V2, member: { user: { bot: false } } });
    const data = exportGuild(GUILD, t.guilds, t.stations);
    data.settings.qualityMode = 'balanced';
    data.settings.idleMode = '24x7';
    data.customStations = [];
    t.setImport(JSON.stringify(data));
    const apply = (await preview(t)).componentIds[0]!;
    const i = await t.click(t.people.admin, apply);
    expect(i.violations).toEqual([]);
    expect(i.text).toMatch(
      /Import applied\nSettings, favourites and source preferences were applied\.\nThe station restarts for a moment to use the new quality\.$/,
    );
    expect(t.guilds.getSettings(GUILD)).toMatchObject({ qualityMode: 'balanced', idleMode: '24x7' });
    expect(s.encoderRefreshes).toBe(1);
    // Two people (one with no member cached) in the bot's channel; the bot user is not counted.
    expect(s.listenerCounts).toEqual([2]);
  });

  it('adds at most five custom stations at once, and names the ones it could not add', async () => {
    const t = setup();
    const data = exportGuild(GUILD, t.guilds, t.stations);
    const station = (name: string, urlRedacted = false) => ({
      name,
      url: urlRedacted ? '' : 'https://radio.example.org/live',
      urlRedacted,
      website: null,
      description: null,
      category: null,
      language: null,
    });
    data.customStations = [
      station('Hidden Address', true),
      station('Refused Station'),
      station('Broken Station'),
      ...[1, 2, 3, 4, 5].map((n) => station(`Station ${n}`)),
    ];
    t.customFailures.set('Refused Station', new RadioError('ACCESS_DENIED', 'Refused.'));
    t.customFailures.set('Broken Station', new Error('boom'));
    t.setImport(JSON.stringify(data));
    const i = await t.click(t.people.admin, (await preview(t)).componentIds[0]!);
    expect(t.customAdds).toEqual(['Station 1', 'Station 2', 'Station 3']);
    expect(i.text).toMatch(/Custom stations added: Station 1, Station 2, Station 3/);
    expect(i.text).toMatch(
      /Custom stations not added: Refused Station \(ACCESS_DENIED\), Broken Station \(INTERNAL\), Station 4 \(too many added at once; add it later with \/radio add\), Station 5 \(too many/,
    );
    expect(i.text).not.toMatch(/Hidden Address/);
  });

  it('refuses a preview that has run out, even with a button that has not', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t = setup();
    t.setImport(JSON.stringify(exportGuild(GUILD, t.guilds, t.stations)));
    const apply = (await preview(t)).componentIds[0]!;
    const token = decode(t.ids, apply)!.arg;
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const late = await t.click(t.people.admin, t.ids.make(GUILD, 'imp', token, 60 * 60_000));
    expect(late.text).toMatch(/This import preview expired\. Run \/radio import again\./);
    expect(t.customAdds).toEqual([]);
  });
});

describe('/radio source', () => {
  /** My Station with its source checked and usable. */
  const usable = () => {
    const { t, st } = customServer();
    t.stations.applyProbePatch('custom-my-station-1', {
      lastProbeAt: new Date().toISOString(),
      verificationState: 'eligible',
      identityStatus: 'verified',
      codec: 'mp3',
    });
    return { t, st };
  };

  it('auto hands the choice back to the bot', async () => {
    const { t, st } = usable();
    t.guilds.setPreference(GUILD, st.id, 'pin', 'custom-my-station-1', OWNER);
    const i = await t.command(t.people.admin, { group: 'source', sub: 'auto', strings: { station: st.id } });
    expect(i.text).toMatch(/Automatic selection\nThe bot chooses the source for My Station again/);
    // Automatic is the absence of an override.
    expect(t.guilds.getPreference(GUILD, st.id)?.mode ?? 'auto').toBe('auto');
  });

  it('refuses a source of another station', async () => {
    const { t, st } = usable();
    const i = await t.command(t.people.admin, {
      group: 'source',
      sub: 'prefer',
      strings: { station: st.id, source: 'made-up-source' },
    });
    expect(i.text).toMatch(/`made-up-source` is not a source of My Station\./);
    expect(t.guilds.getPreference(GUILD, st.id)).toBeNull();
  });

  it('prefer confirms a usable source in green', async () => {
    const { t, st } = usable();
    const i = await t.command(t.people.admin, {
      group: 'source',
      sub: 'prefer',
      strings: { station: st.id, source: 'custom-my-station-1' },
    });
    const e = lastEmbed(i);
    expect(e.title).toBe('Source tried first');
    expect(e.color).toBe(COLOR.ok);
    expect(e.description).toMatch(
      /^On this server, My Station now tries `custom-my-station-1` \(.*\) first\. Whenever it can’t be used, the bot picks another source by itself\.$/,
    );
    expect(t.guilds.getPreference(GUILD, st.id)).toMatchObject({
      mode: 'prefer',
      sourceId: 'custom-my-station-1',
    });
  });

  it('pin warns in amber when the source cannot be used, and says a fallback plays meanwhile', async () => {
    const { t, st } = customServer();
    const i = await t.command(t.people.admin, {
      group: 'source',
      sub: 'pin',
      strings: { station: st.id, source: 'custom-my-station-1' },
    });
    const e = lastEmbed(i);
    expect(e.title).toBe('Source pinned');
    expect(e.color).toBe(COLOR.warn);
    expect(e.description).toMatch(/only admins can switch it to another source\./);
    expect(e.description).toMatch(/⚠ That source can’t be used right now \(.+\)\. Until it works again/);
    expect(t.guilds.getPreference(GUILD, st.id)?.mode).toBe('pin');
  });

  it('verify of a pack source is for the operator only', async () => {
    const t = setup();
    const src = t.stations.listAllSources()[0]!;
    const i = await t.command(t.people.admin, {
      group: 'source',
      sub: 'verify',
      strings: { station: src.stationId, source: src.id, verdict: 'mismatch' },
    });
    expect(i.text).toMatch(/only the bot’s operator can record it/);
    expect(t.stations.getSource(src.id)?.identityOverride).toBeNull();
  });

  it('verify of a pack source is recorded for an operator, and can be cleared again', async () => {
    const t = setup({ operators: [ADMIN] });
    const src = t.stations.listAllSources()[0]!;
    const verify = (verdict: string) =>
      t.command(t.people.admin, {
        group: 'source',
        sub: 'verify',
        strings: { station: src.stationId, source: src.id, verdict },
      });
    const i = await verify('mismatch');
    expect(i.text).toMatch(
      new RegExp(`Source review recorded\\n\`${src.id}\`: .*kept in the source’s evidence`),
    );
    expect(t.stations.getSource(src.id)?.identityOverride).toBe('mismatch');
    await verify('clear');
    expect(t.stations.getSource(src.id)?.identityOverride).toBeNull();
  });

  it('counts the application’s owner, and its team, as operators', async () => {
    const t = setup();
    const src = t.stations.listAllSources()[0]!;
    const verify = (actor: typeof t.people.owner) =>
      t.command(actor, {
        group: 'source',
        sub: 'verify',
        strings: { station: src.stationId, source: src.id, verdict: 'verified' },
      });
    (t.ctx.client as unknown as { application: unknown }).application = { owner: { id: OWNER } };
    expect((await verify(t.people.owner)).text).toMatch(/Source review recorded/);
    expect((await verify(t.people.admin)).text).toMatch(/only the bot’s operator/);
    (t.ctx.client as unknown as { application: unknown }).application = {
      owner: { members: new Map([[ADMIN, {}]]) },
    };
    expect((await verify(t.people.admin)).text).toMatch(/Source review recorded/);
  });

  it('verify of this server’s own custom station needs no operator', async () => {
    const { t, st } = customServer();
    const i = await t.command(t.people.admin, {
      group: 'source',
      sub: 'verify',
      strings: { station: st.id, source: 'custom-my-station-1', verdict: 'verified' },
    });
    expect(i.text).toMatch(/Source review recorded/);
    expect(t.stations.getSource('custom-my-station-1')?.identityOverride).toBe('verified');
  });

  it('names a station that does not exist', async () => {
    const { t } = customServer();
    const i = await t.command(t.people.admin, {
      group: 'source',
      sub: 'auto',
      strings: { station: 'Nothing Like It' },
    });
    expect(i.text).toMatch(/No station matches "Nothing Like It"/);
  });
});

describe('/radio list, sources and inspect', () => {
  it('list shows this server’s custom stations when asked for the custom pack', async () => {
    const { t } = customServer();
    const i = await t.command(t.people.member, { sub: 'list', strings: { pack: 'custom' } });
    const e = lastEmbed(i);
    expect(e.title).toBe('Custom stations (this server)');
    expect(e.description).toMatch(/\*\*My Station\*\*/);
  });

  it('list shows the favourites, on the page asked for', async () => {
    const { t, st } = customServer();
    t.guilds.toggleFavourite(GUILD, st.id);
    const i = await t.command(t.people.member, {
      sub: 'list',
      strings: { scope: 'favourites' },
      ints: { page: 1 },
    });
    expect(lastEmbed(i).title).toBe('Favourite stations');
    expect(lastEmbed(i).description).toMatch(/My Station/);
  });

  it('inspect shows an admin the server override and the buttons that change it', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    s.playingSourceId = 'custom-my-station-1';
    t.guilds.setPreference(GUILD, st.id, 'prefer', 'custom-my-station-1', OWNER);
    const i = await t.command(t.people.admin, { sub: 'inspect', strings: { station: st.id } });
    expect(i.text).toMatch(/Source chosen on this server\n`custom-my-station-1` is tried first\./);
    // It already tries the playing source first, so only Check again and Let the bot choose are offered.
    expect(i.componentIds.map((id) => decode(t.ids, id)?.action)).toEqual(['rescan', 'sauto']);
  });

  it('sources offers an admin to prefer the playing source when no preference is set', async () => {
    const { t, st } = customServer();
    playingIn(t, V1, st.id).playingSourceId = 'custom-my-station-1';
    const i = await t.command(t.people.admin, { sub: 'sources', strings: { station: st.id } });
    expect(i.componentIds.map((id) => decode(t.ids, id)?.action)).toEqual(['rescan', 'spref']);
    const member = await t.command(t.people.member, { sub: 'sources', strings: { station: st.id } });
    expect(member.componentIds).toEqual([]);
  });

  it('offers no buttons for a station with no sources', async () => {
    const { t } = customServer();
    const silent = t.addCustomStation('Silent Station', false);
    const i = await t.command(t.people.admin, { sub: 'sources', strings: { station: silent.id } });
    expect(i.componentIds).toEqual([]);
  });
});

describe('/radio browse and /radio help', () => {
  it('browse starts from the pack, category and search it was given', async () => {
    const { t } = customServer();
    t.addCustomStation('Another Station');
    const i = await t.command(t.people.member, { sub: 'browse', strings: { search: 'another' } });
    const e = lastEmbed(i);
    expect(e.description).toMatch(/Another Station/);
    expect(e.description).not.toMatch(/My Station/);
  });

  it('help still answers someone outside the command channels, without the admin section', async () => {
    const t = setup();
    t.guilds.updateSettings(GUILD, { allowedTextChannelIds: [TEXT] });
    const i = await t.command(t.people.member, { sub: 'help' }, '800000000000000099');
    expect(i.ephemeral).toBe(true);
    expect(i.text).toMatch(/🛠 Settings\nServer admins choose channels and DJ roles/);
    expect(i.text).not.toMatch(/🛠 Admin/);
  });
});
