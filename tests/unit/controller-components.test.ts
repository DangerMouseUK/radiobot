import { type APIEmbed, MessageFlags } from 'discord.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSource } from '../helpers.ts';
import {
  DJ_ROLE,
  decode,
  type FakeInteraction,
  GUILD,
  type Harness,
  MEMBER,
  OWNER,
  setup,
  signedId,
  TEXT,
  V1,
  V2,
} from './controller-harness.ts';

const EPHEMERAL = MessageFlags.Ephemeral;
const PANEL_MESSAGE = '500000000000000042';

const methods = (i: FakeInteraction) => i.calls.map((c) => c.method);
const firstEmbed = (i: FakeInteraction): APIEmbed => i.calls[0]!.payload.embeds![0]!.toJSON();

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

/** My Station with two checked, usable sources, playing in V1 from the first. */
function twoSources() {
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
  for (const id of ['custom-my-station-1', 'custom-my-station-2']) {
    t.stations.applyProbePatch(id, {
      lastProbeAt: new Date().toISOString(),
      verificationState: 'eligible',
      identityStatus: 'verified',
      codec: 'mp3',
    });
  }
  const session = playingIn(t, V1, st.id);
  session.playingSourceId = 'custom-my-station-1';
  return { t, st, session };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('every click', () => {
  it('is rate-limited per person', async () => {
    const t = setup();
    for (let n = 0; n < 20; n++) t.ctx.limits.componentUser.take(MEMBER);
    const i = await t.click(t.people.member, t.ids.make(GUILD, 'now'));
    expect(i.acks).toBe(1);
    expect(i.ephemeral).toBe(true);
    expect(i.text).toMatch(/Too many clicks in a short time\. Try again in \d+ s\./);
  });

  it('says a button from an older version is no longer supported', async () => {
    const t = setup();
    const i = await t.click(t.people.admin, signedId(GUILD, 'retired', 'x'));
    expect(i.ephemeral).toBe(true);
    expect(i.text).toMatch(/That button is no longer supported\. Run the command again\./);
  });
});

describe('Play buttons and the station picker', () => {
  it('a Play button answers privately, then plays in the listener’s channel', async () => {
    const { t, st } = customServer();
    t.putInVoice(t.people.member, V1);
    const i = await t.click(t.people.member, t.ids.make(GUILD, 'play', st.id));
    expect(i.violations).toEqual([]);
    expect(i.calls[0]).toMatchObject({ method: 'deferReply', payload: { flags: EPHEMERAL } });
    expect(t.sessions.plays).toEqual([{ guildId: GUILD, stationId: st.id, channelId: V1 }]);
    // A station change from a button is announced to the channel too, in one public line.
    expect(i.calls.at(-1)).toMatchObject({
      method: 'followUp',
      payload: { content: `<@${t.people.member.id}> started **My Station** in <#${V1}>.` },
    });
    expect(i.calls.at(-1)!.payload.flags).toBeUndefined();
  });

  it('a Play button or picker choice for a station that has gone is refused', async () => {
    const { t } = customServer();
    t.putInVoice(t.people.admin, V1);
    const button = await t.click(t.people.admin, t.ids.make(GUILD, 'play', 'custom:gone'));
    expect(button.text).toMatch(/That station is no longer available\./);
    const pick = await t.click(t.people.admin, t.ids.make(GUILD, 'pick', ''), 'string', ['custom:gone']);
    expect(pick.text).toMatch(/That station is no longer available\./);
    expect(t.sessions.plays).toEqual([]);
  });

  it('a picker with no channel plays where the listener is', async () => {
    const { t, st } = customServer();
    t.putInVoice(t.people.admin, V2);
    const pick = await t.click(t.people.admin, t.ids.make(GUILD, 'pick', ''), 'string', [st.id]);
    expect(pick.calls[0]?.method).toBe('deferUpdate');
    expect(t.sessions.plays).toEqual([{ guildId: GUILD, stationId: st.id, channelId: V2 }]);
  });

  it('ignores a picker ID on something that is not a menu', async () => {
    const { t } = customServer();
    t.putInVoice(t.people.admin, V1);
    const i = await t.click(t.people.admin, t.ids.make(GUILD, 'pick', ''));
    expect(i.calls).toEqual([]);
    expect(t.sessions.plays).toEqual([]);
  });
});

describe('Browse and List buttons', () => {
  it('Browse stations opens a new private list whose pages work', async () => {
    const t = setup();
    const open = await t.click(t.people.member, t.ids.make(GUILD, 'obrowse'));
    expect(open.violations).toEqual([]);
    expect(open.calls[0]).toMatchObject({ method: 'reply', payload: { flags: EPHEMERAL } });
    const next = open.componentIds.find((id) => decode(t.ids, id)?.arg.endsWith(':p1'))!;
    const page = await t.click(t.people.member, next);
    expect(methods(page)).toEqual(['update']);
    expect(firstEmbed(page).footer?.text).toMatch(/Page 2\//);
  });

  it('a page argument that is not a number goes to the first page', async () => {
    const t = setup();
    const open = await t.click(t.people.member, t.ids.make(GUILD, 'obrowse'));
    const token = decode(t.ids, open.componentIds.find((id) => decode(t.ids, id)?.action === 'browse')!)!.arg;
    const page = await t.click(t.people.member, t.ids.make(GUILD, 'browse', `${token.split(':')[0]}:px`));
    expect(firstEmbed(page).footer?.text).toMatch(/Page 1\//);
  });

  it('a list unused for 15 minutes has expired, for its pages and its Favourites filter', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t = setup();
    const open = await t.command(t.people.member, { sub: 'browse' });
    const args = open.componentIds.map((id) => decode(t.ids, id)!);
    const pageArg = args.find((a) => a.action === 'browse')!.arg;
    const token = args.find((a) => a.action === 'bfav')!.arg;
    vi.setSystemTime(Date.now() + 16 * 60_000);
    // Fresh buttons for the same list, so it is the list that has expired, not the buttons.
    const page = await t.click(t.people.member, t.ids.make(GUILD, 'browse', pageArg));
    const filter = await t.click(t.people.member, t.ids.make(GUILD, 'bfav', token));
    for (const i of [page, filter]) {
      expect(i.text).toMatch(/This station list has expired\. Run \/radio browse again\./);
      expect(i.ephemeral).toBe(true);
    }
  });

  it('Search opens a box holding the current search, and what is typed redraws the list in place', async () => {
    const t = setup();
    const open = await t.command(t.people.member, { sub: 'browse' });
    const button = open.componentIds.find((id) => decode(t.ids, id)?.action === 'bsearch')!;
    const token = decode(t.ids, button)!.arg;
    const ask = await t.click(t.people.member, button);
    expect(methods(ask)).toEqual(['showModal']);
    const modal = (ask.calls[0]!.payload as { modal: { custom_id: string } }).modal;
    expect(decode(t.ids, modal.custom_id)).toEqual({ action: 'bsearch', arg: token });

    const found = await t.submit(t.people.member, modal.custom_id, { search: '  techno ' });
    expect(found.violations).toEqual([]);
    expect(methods(found)).toEqual(['update']);
    // Fewer stations than the whole list: the search narrowed it (and was trimmed).
    expect(firstEmbed(found).footer?.text).toMatch(/^Page 1\/1 · \d+ stations? · search: "techno"\./);
    // A form sent from somewhere other than the list gets the results as a new private reply.
    const elsewhere = await t.submit(t.people.member, modal.custom_id, { search: 'techno' }, false);
    expect(methods(elsewhere)).toEqual(['reply']);
    expect(elsewhere.ephemeral).toBe(true);
    expect(elsewhere.calls[0]!.payload.embeds![0]!.toJSON().footer?.text).toMatch(/search: "techno"/);
    // The box opens again with the search in it, and emptying it shows every station.
    const again = await t.click(t.people.member, button);
    expect(JSON.stringify(again.calls[0]!.payload)).toContain('"value":"techno"');
    const everything = await t.submit(t.people.member, modal.custom_id, { search: '' });
    expect(firstEmbed(everything).footer?.text).toMatch(/^Page 1\/2 · 26 stations\. /);
  });

  it('a search form whose list has expired, or that is not one of ours, changes nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t = setup();
    const open = await t.command(t.people.member, { sub: 'browse' });
    const token = decode(
      t.ids,
      open.componentIds.find((id) => decode(t.ids, id)?.action === 'bsearch')!,
    )!.arg;
    vi.setSystemTime(Date.now() + 16 * 60_000);
    for (const i of [
      await t.click(t.people.member, t.ids.make(GUILD, 'bsearch', token)),
      await t.submit(t.people.member, t.ids.make(GUILD, 'bsearch', token), { search: 'jazz' }),
    ]) {
      expect(methods(i)).toEqual(['reply']);
      expect(i.text).toMatch(/This station list has expired\. Run \/radio browse again\./);
      expect(i.ephemeral).toBe(true);
    }
    const other = await t.submit(t.people.member, t.ids.make(GUILD, 'play', 'x'), { search: 'jazz' });
    expect(other.text).toMatch(/This form is not valid here\./);
    const forged = await t.submit(t.people.member, signedId(GUILD, 'bsearch', token, 'wrong'), {
      search: 'jazz',
    });
    expect(forged.text).toMatch(/This form is not valid here\./);
    // A form left open past its 15 minutes has expired, whatever the list's state.
    const old = t.ids.make(GUILD, 'bsearch', token);
    vi.setSystemTime(Date.now() + 16 * 60_000);
    const late = await t.submit(t.people.member, old, { search: 'jazz' });
    expect(late.text).toMatch(/This form has expired\. Run the command again\./);
  });

  it('List pages move through the station list in place', async () => {
    const t = setup();
    const i = await t.click(t.people.member, t.ids.make(GUILD, 'list', 'packs_:p1'));
    expect(methods(i)).toEqual(['update']);
    expect(firstEmbed(i).title).toBe('Station packs');
    expect(firstEmbed(i).footer?.text).toMatch(/^Page 2\//);
  });

  it('read-only buttons are refused outside the command channels', async () => {
    const t = setup();
    t.guilds.updateSettings(GUILD, { allowedTextChannelIds: ['800000000000000099'] });
    for (const [action, arg] of [
      ['browse', 'x:p1'],
      ['bfav', 'x'],
      ['obrowse', ''],
      ['list', 'packs_:p1'],
      ['srcs', 'custom:my-station'],
      ['now', ''],
      ['bsearch', 'x'],
    ] as const) {
      const i = await t.click(t.people.member, t.ids.make(GUILD, action, arg));
      expect(i.text).toMatch(/Radio commands are only allowed in <#800000000000000099>/);
    }
    // A submitted search form is checked the same way.
    const form = await t.submit(t.people.member, t.ids.make(GUILD, 'bsearch', 'x'), { search: 'jazz' });
    expect(form.text).toMatch(/Radio commands are only allowed in <#800000000000000099>/);
  });
});

describe('now-playing buttons', () => {
  it('Close removes the private message', async () => {
    const t = setup();
    const i = await t.click(t.people.admin, t.ids.make(GUILD, 'close'));
    expect(i.violations).toEqual([]);
    expect(methods(i)).toEqual(['deferUpdate', 'deleteReply']);
  });

  it('Close on the stats stops reading receiver reports for that admin; other Close buttons do not', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    const refresh = await t.click(t.people.admin, t.ids.make(GUILD, 'stats'));
    expect(refresh.violations).toEqual([]);
    expect(s.reportOpens).toEqual([t.people.admin.id]);
    await t.click(t.people.admin, t.ids.make(GUILD, 'close'));
    expect(s.reportCloses).toEqual([]);
    const close = await t.click(t.people.admin, t.ids.make(GUILD, 'close', 'stats'));
    expect(methods(close)).toEqual(['deferUpdate', 'deleteReply']);
    expect(s.reportCloses).toEqual([t.people.admin.id]);
  });

  it('Stop and Leave act on the session', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    const stop = await t.click(t.people.admin, t.ids.make(GUILD, 'stop'));
    expect(s.stops).toBe(1);
    expect(stop.text).toMatch(/stopped the radio/);
    const leave = await t.click(t.people.admin, t.ids.make(GUILD, 'leave'));
    expect(s.leaves).toEqual(['left']);
    expect(leave.text).toMatch(/disconnected the radio/);
  });

  it('Refresh redraws the card it is on, the control panel included, without a reply', async () => {
    const { t, st } = customServer();
    playingIn(t, V1, st.id).fullStatus = { state: 'PLAYING', stationId: st.id, channelId: V1 };
    const card = await t.click(t.people.member, t.ids.make(GUILD, 'now'));
    expect(methods(card)).toEqual(['update']);
    expect(firstEmbed(card).title).toBe('▶ Playing: My Station');
    t.guilds.updateSettings(GUILD, { panelChannelId: '800000000000000010', panelMessageId: PANEL_MESSAGE });
    const panel = await t.click(t.people.member, t.ids.make(GUILD, 'now'), 'button', [], PANEL_MESSAGE);
    // The panel itself is redrawn for everyone: no private copy.
    expect(methods(panel)).toEqual(['update']);
    expect(firstEmbed(panel)).toMatchObject({
      title: '▶ Playing: My Station',
      author: { name: 'Radio Bot control panel' },
    });
    // Its buttons are still the panel's own, which never expire.
    expect(panel.componentIds.map((id) => t.ids.parse(GUILD, id)?.expired)).not.toContain(true);
  });

  it('Favourite and Unfavourite refuse a station that has gone, and listeners who cannot control', async () => {
    const { t, st } = customServer();
    t.putInVoice(t.people.admin, V1);
    const gone = await t.click(t.people.admin, t.ids.make(GUILD, 'fav', 'custom:gone'));
    expect(gone.text).toMatch(/That station is no longer available\./);
    t.guilds.updateSettings(GUILD, { memberControlMode: 'none' });
    const denied = await t.click(t.people.member, t.ids.make(GUILD, 'fav', st.id));
    expect(denied.text).toMatch(/Only DJs and administrators can control the radio/);
    expect(t.guilds.listFavourites(GUILD)).toEqual([]);
  });

  it('Favourite and Unfavourite redraw the control panel only when something changed', async () => {
    const { t, st } = customServer();
    const panel = t.textChannel('800000000000000010');
    t.guilds.updateSettings(GUILD, { panelChannelId: panel.id, panelMessageId: PANEL_MESSAGE });
    // Playing, so the panel shows Favourite or Unfavourite for the station.
    playingIn(t, V1, st.id).fullStatus = {};
    await t.click(t.people.admin, t.ids.make(GUILD, 'fav', st.id), 'button', [], PANEL_MESSAGE);
    expect(panel.edits.map((e) => e.id)).toEqual([PANEL_MESSAGE]);
    await t.click(t.people.admin, t.ids.make(GUILD, 'fav', st.id), 'button', [], PANEL_MESSAGE);
    expect(panel.edits).toHaveLength(1);
    await t.click(t.people.admin, t.ids.make(GUILD, 'unfav', st.id), 'button', [], PANEL_MESSAGE);
    expect(panel.edits).toHaveLength(2);
  });

  it('a panel refresh that would show the same is not sent again, and a failed one is retried', async () => {
    const { t, st } = customServer();
    const panel = t.textChannel('800000000000000010');
    t.guilds.updateSettings(GUILD, { panelChannelId: panel.id, panelMessageId: PANEL_MESSAGE });
    const s = playingIn(t, V1, st.id);
    s.fullStatus = {};
    await t.controller.refreshPanel(GUILD);
    await t.controller.refreshPanel(GUILD);
    expect(panel.edits).toHaveLength(1);
    // Something the panel shows changes: it is edited again.
    s.fullStatus = { state: 'CONNECTED', desiredState: 'stopped' };
    await t.controller.refreshPanel(GUILD);
    expect(panel.edits).toHaveLength(2);
    // A failed edit is forgotten, so the same panel is sent again next time.
    s.fullStatus = {};
    panel.editError = 50013;
    await t.controller.refreshPanel(GUILD);
    panel.editError = null;
    await t.controller.refreshPanel(GUILD);
    expect(panel.edits).toHaveLength(3);
    await t.controller.refreshPanel(GUILD);
    expect(panel.edits).toHaveLength(3);
    // Refresh on the panel redraws it in place, and the timer then has nothing new to send.
    s.fullStatus = { state: 'CONNECTED', desiredState: 'stopped' };
    const refresh = await t.click(
      t.people.member,
      t.ids.make(GUILD, 'now', '', null),
      'button',
      [],
      PANEL_MESSAGE,
    );
    expect(refresh.calls[0]!.method).toBe('update');
    await t.controller.refreshPanel(GUILD);
    expect(panel.edits).toHaveLength(3);
  });

  it('a new panel starts from what it was posted with', async () => {
    const { t, st } = customServer();
    const panel = t.textChannel('800000000000000010');
    playingIn(t, V1, st.id).fullStatus = {};
    await t.command(t.people.admin, { sub: 'panel', channel: panel.id });
    expect(panel.sent).toHaveLength(1);
    await t.controller.refreshPanel(GUILD);
    expect(panel.edits).toEqual([]);
  });

  it('Sources and Inspect show the station’s sources privately', async () => {
    const { t, st } = customServer();
    const sources = await t.click(t.people.member, t.ids.make(GUILD, 'srcs', st.id));
    const inspect = await t.click(t.people.member, t.ids.make(GUILD, 'insp', st.id));
    for (const i of [sources, inspect]) {
      expect(i.calls[0]).toMatchObject({ method: 'reply', payload: { flags: EPHEMERAL } });
      expect(i.text).toMatch(/My Station/);
      expect(i.text).toMatch(/\nMain stream\n/);
    }
    // The source's ID is detail: only Inspect shows it, on a line of its own.
    expect(sources.text).not.toMatch(/custom-my-station-1/);
    expect(inspect.text).toMatch(/ID: `custom-my-station-1`/);
    // Inspect has the detail that Sources leaves out.
    expect(inspect.text.length).toBeGreaterThan(sources.text.length);
    const gone = await t.click(t.people.member, t.ids.make(GUILD, 'insp', 'custom:gone'));
    expect(gone.text).toMatch(/That station is no longer available\./);
  });
});

describe('preferring the playing source', () => {
  it('Prefer is refused when the station is not playing from one of its sources', async () => {
    const { t, st } = customServer();
    const notPlaying = await t.click(t.people.admin, t.ids.make(GUILD, 'spref', st.id));
    expect(notPlaying.text).toMatch(
      /isn’t playing from one of its sources right now, so there is no source to try first/,
    );
    // Playing, but from a source that belongs to another station.
    const s = playingIn(t, V1, st.id);
    s.fullStatus = { source: makeSource({ id: 'src-elsewhere' }) };
    t.stations.insertSource({
      id: 'src-elsewhere',
      stationId: t.addCustomStation('Other Station', false).id,
      url: 'https://radio.example.org/other',
      label: null,
      priority: 10,
      transportHint: null,
      codecHint: null,
      provenance: 'curated',
      provenanceDetail: null,
      rightsStatus: 'unreviewed',
    });
    const wrong = await t.click(t.people.admin, t.ids.make(GUILD, 'spref', st.id));
    expect(wrong.text).toMatch(/isn’t playing from one of its sources right now/);
    expect(t.guilds.getPreference(GUILD, st.id)).toBeNull();
  });

  it('Try first names the source it now tries first', async () => {
    const { t, st } = twoSources();
    const i = await t.click(t.people.admin, t.ids.make(GUILD, 'spref', st.id));
    expect(i.text).toMatch(
      /Source tried first\nOn this server, My Station now tries \*\*Main stream\*\* first\. If it fails, the bot switches to another source\.$/,
    );
    expect(i.ephemeral).toBe(true);
  });

  it('Let the bot choose is refused for a station that has gone', async () => {
    const t = setup();
    const i = await t.click(t.people.admin, t.ids.make(GUILD, 'sauto', 'custom:gone'));
    expect(i.text).toMatch(/That station is no longer available\./);
  });
});

describe('choosing another source', () => {
  it('ignores the ID on something that is not a menu', async () => {
    const { t, st, session } = twoSources();
    const i = await t.click(t.people.admin, t.ids.make(GUILD, 'usesrc', st.id));
    expect(i.calls).toEqual([]);
    expect(session.usedSources).toEqual([]);
  });

  it('refuses a station that has gone, and the source already playing', async () => {
    const { t, st, session } = twoSources();
    t.putInVoice(t.people.admin, V1);
    const gone = await t.click(t.people.admin, t.ids.make(GUILD, 'usesrc', 'custom:gone'), 'string', [
      'custom-my-station-2',
    ]);
    expect(gone.text).toMatch(/That station is no longer available\./);
    const same = await t.click(t.people.admin, t.ids.make(GUILD, 'usesrc', st.id), 'string', [
      'custom-my-station-1',
    ]);
    expect(same.text).toMatch(/My Station is already playing from that source\./);
    expect(session.usedSources).toEqual([]);
  });

  it('reports a switch the session could not make', async () => {
    const { t, st, session } = twoSources();
    t.putInVoice(t.people.admin, V1);
    session.useSourceResult = { ok: false, code: 'STREAM_STALLED', message: 'The backup did not start.' };
    const i = await t.click(t.people.admin, t.ids.make(GUILD, 'usesrc', st.id), 'string', [
      'custom-my-station-2',
    ]);
    expect(i.violations).toEqual([]);
    expect(i.calls[0]).toMatchObject({ method: 'deferReply', payload: { flags: EPHEMERAL } });
    expect(i.lastText).toMatch(/The backup did not start\./);
    expect(i.lastText).not.toMatch(/Source changed/);
  });

  it('is rate-limited like changing station', async () => {
    const { t, st, session } = twoSources();
    t.putInVoice(t.people.admin, V1);
    for (let n = 0; n < 6; n++) t.ctx.limits.playUser.take('900000000000000002');
    const i = await t.click(t.people.admin, t.ids.make(GUILD, 'usesrc', st.id), 'string', [
      'custom-my-station-2',
    ]);
    expect(i.text).toMatch(/Too many station changes/);
    expect(session.usedSources).toEqual([]);
  });
});

describe('the settings card', () => {
  const cfg = (t: Harness, arg: string) => t.ids.make(GUILD, 'cfg', arg, 30 * 60_000);
  /** The button or menu on the card with this argument. */
  const control = (t: Harness, i: FakeInteraction, arg: string) =>
    i.cardControls.find((c) => decode(t.ids, c.custom_id ?? '')?.arg === arg);
  const PANEL = '800000000000000010';
  const OLD_PANEL = '800000000000000011';

  it('Change, Back and the setup steps move between screens in place, changing nothing', async () => {
    const t = setup();
    const before = t.guilds.getSettings(GUILD);
    for (const [to, heading] of [
      ['access', '## Who can use it'],
      ['playing', '## Playing'],
      ['sound', '## Sound and empty channel'],
      ['notices', '## Notices'],
      ['panel', '## Control panel'],
      ['reset', '## Reset all settings?'],
      ['setup1', 'Step 1 of 4'],
      ['setup5', 'Finished'],
      ['home', '## Radio Bot settings'],
    ] as const) {
      const i = await t.click(t.people.admin, cfg(t, `go:${to}`));
      expect(i.violations).toEqual([]);
      expect(methods(i)).toEqual(['update']);
      expect(i.text).toContain(heading);
    }
    // A screen that doesn't exist opens the overview.
    expect((await t.click(t.people.admin, cfg(t, 'go'))).text).toContain('## Radio Bot settings');
    expect(t.guilds.getSettings(GUILD)).toEqual(before);
  });

  it('the channel menus set the command, voice, preferred and notice channels, and stay on their screen', async () => {
    const t = setup();
    const text = await t.click(t.people.admin, cfg(t, 'text:access'), 'channel', ['800000000000000021']);
    expect(text.text).toContain('## Who can use it');
    await t.click(t.people.admin, cfg(t, 'voice:access'), 'channel', [V1, V2]);
    const pvoice = await t.click(t.people.admin, cfg(t, 'pvoice:setup1'), 'channel', [V2]);
    expect(pvoice.text).toContain('Step 1 of 4');
    const notify = await t.click(t.people.admin, cfg(t, 'notify:notices'), 'channel', ['800000000000000022']);
    expect(notify.text).toContain('## Notices');
    expect(t.guilds.getSettings(GUILD)).toMatchObject({
      allowedTextChannelIds: ['800000000000000021'],
      allowedVoiceChannelIds: [V1, V2],
      preferredVoiceChannelId: V2,
      notificationChannelId: '800000000000000022',
    });
    // Emptying a single-choice menu clears the setting.
    await t.click(t.people.admin, cfg(t, 'pvoice:playing'), 'channel', []);
    await t.click(t.people.admin, cfg(t, 'notify:notices'), 'channel', []);
    expect(t.guilds.getSettings(GUILD)).toMatchObject({
      preferredVoiceChannelId: null,
      notificationChannelId: null,
    });
  });

  it('says when the bot cannot post in the notice channel just chosen', async () => {
    const t = setup();
    t.guild.members.me = { id: '900000000000000099' };
    const muted = t.textChannel('800000000000000022');
    muted.canSend = false;
    const i = await t.click(t.people.admin, cfg(t, 'notify:setup4'), 'channel', [muted.id]);
    expect(i.text).toContain(
      '⚠️ I can’t post in <#800000000000000022> yet. Give me View Channel and Send Messages there.',
    );
    // The setting is saved anyway: the admin may be about to fix the channel's permissions.
    expect(t.guilds.getSettings(GUILD).notificationChannelId).toBe(muted.id);
    muted.canSend = true;
    const fine = await t.click(t.people.admin, cfg(t, 'notify:setup4'), 'channel', [muted.id]);
    expect(fine.text).not.toMatch(/I can’t post/);
  });

  it('the DJ role menu never stores @everyone', async () => {
    const t = setup();
    // @everyone has the server's own ID.
    await t.click(t.people.admin, cfg(t, 'djs:access'), 'role', [DJ_ROLE, GUILD]);
    expect(t.guilds.getSettings(GUILD).djRoleIds).toEqual([DJ_ROLE]);
  });

  it('a button or menu for an unknown field changes nothing', async () => {
    const t = setup();
    const before = t.guilds.getSettings(GUILD);
    await t.click(t.people.admin, cfg(t, 'mystery:access'), 'channel', [V1]);
    await t.click(t.people.admin, cfg(t, 'mystery'), 'role', [DJ_ROLE]);
    await t.click(t.people.admin, cfg(t, 'mystery'), 'string', ['any']);
    const button = await t.click(t.people.admin, cfg(t, 'mystery'));
    expect(button.text).toContain('## Radio Bot settings');
    // A form button pressed as a menu, or a panel menu pressed as a button, does nothing either.
    await t.click(t.people.admin, cfg(t, 'station:playing'), 'string', ['x']);
    await t.click(t.people.admin, cfg(t, 'panel:panel'));
    expect(t.guilds.getSettings(GUILD)).toEqual(before);
  });

  it('the idle menu applies at once to the people in the bot’s channel', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    t.guild.voiceStates.cache.set('900000000000000011', { channelId: V1, member: { user: { bot: false } } });
    t.guild.voiceStates.cache.set('900000000000000012', { channelId: V1, member: { user: { bot: true } } });
    t.guild.voiceStates.cache.set('900000000000000013', { channelId: V2, member: { user: { bot: false } } });
    const i = await t.click(t.people.admin, cfg(t, 'idle:sound'), 'string', ['24x7']);
    expect(i.text).toContain('## Sound and empty channel');
    expect(t.guilds.getSettings(GUILD).idleMode).toBe('24x7');
    expect(s.listenerCounts).toEqual([1]);
    expect(s.encoderRefreshes).toBe(0);
    await t.click(t.people.admin, cfg(t, 'idle:sound'), 'string', ['sometimes']);
    expect(t.guilds.getSettings(GUILD).idleMode).toBe('24x7');
  });

  it('the idle menu has nobody to recheck when the bot is not in a channel', async () => {
    const t = setup();
    const s = t.sessions.ensure(GUILD);
    await t.click(t.people.admin, cfg(t, 'idle:setup3'), 'string', ['pause_when_empty']);
    expect(t.guilds.getSettings(GUILD).idleMode).toBe('pause_when_empty');
    expect(s.listenerCounts).toEqual([]);
  });

  it('the member and quality menus take only known values; quality applies to the stream at once', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    await t.click(t.people.admin, cfg(t, 'member:access'), 'string', ['any']);
    await t.click(t.people.admin, cfg(t, 'member:access'), 'string', ['everyone']);
    expect(t.guilds.getSettings(GUILD).memberControlMode).toBe('any');
    const changed = await t.click(t.people.admin, cfg(t, 'quality:sound'), 'string', ['balanced']);
    expect(t.guilds.getSettings(GUILD).qualityMode).toBe('balanced');
    expect(s.encoderRefreshes).toBe(1);
    expect(changed.text).toMatch(/restarts for a moment/);
    s.reencodes = false;
    const same = await t.click(t.people.admin, cfg(t, 'quality:sound'), 'string', ['balanced']);
    expect(same.text).not.toMatch(/restarts for a moment/);
    await t.click(t.people.admin, cfg(t, 'quality:sound'), 'string', ['lossless']);
    expect(t.guilds.getSettings(GUILD).qualityMode).toBe('balanced');
    expect(s.encoderRefreshes).toBe(2);
  });

  it('choosing Manual with no bitrate yet asks for one at once; with one, it just shows it', async () => {
    const t = setup();
    const ask = await t.click(t.people.admin, cfg(t, 'quality:sound'), 'string', ['manual']);
    expect(methods(ask)).toEqual(['showModal']);
    expect(t.guilds.getSettings(GUILD).qualityMode).toBe('manual');
    const modal = ask.calls[0]!.payload.modal as { custom_id: string; title: string };
    expect(modal.title).toBe('Manual bitrate');
    expect(decode(t.ids, modal.custom_id)).toEqual({ action: 'cfgm', arg: 'bitrate:sound' });
    t.guilds.updateSettings(GUILD, { qualityMode: 'maximum', manualBitrateKbps: 192 });
    const shown = await t.click(t.people.admin, cfg(t, 'quality:sound'), 'string', ['manual']);
    expect(methods(shown)).toEqual(['update']);
    expect(shown.text).toMatch(/\*\*Manual bitrate\*\*\n192 kbps/);
  });

  it('the Change buttons open the forms, with the current values filled in', async () => {
    const t = setup();
    const [a, b, c] = t.stations.listStations(GUILD).slice(-3);
    t.guilds.updateSettings(GUILD, { defaultStationId: c!.id, manualBitrateKbps: 256 });
    t.guilds.toggleFavourite(GUILD, a!.id);
    t.guilds.toggleFavourite(GUILD, b!.id);
    const station = await t.click(t.people.admin, cfg(t, 'station:playing'));
    expect(methods(station)).toEqual(['showModal']);
    const form = JSON.stringify(station.calls[0]!.payload.modal);
    const options = JSON.parse(form).components[0].component.options as Array<{
      value: string;
      description?: string;
      default?: boolean;
    }>;
    // "No default station", then the default, then the favourites, then the rest: 25 at most.
    expect(options.slice(0, 4).map((o) => o.value)).toEqual(['none', c!.id, a!.id, b!.id]);
    expect(options[1]).toMatchObject({ description: 'the default now', default: true });
    expect(options[2]!.description).toBe('favourite');
    expect(options.length).toBeLessThanOrEqual(25);
    const bitrate = await t.click(t.people.admin, cfg(t, 'bitrate:sound'));
    expect(JSON.stringify(bitrate.calls[0]!.payload.modal)).toContain('"value":"256"');
  });

  it('switches turn on only once they can work, and always turn off', async () => {
    const t = setup();
    const refused = await t.click(t.people.admin, cfg(t, 'autostart:playing'));
    expect(refused.text).toContain(
      '⚠️ Autostart needs a default station and a preferred voice channel first.',
    );
    const lockRefused = await t.click(t.people.admin, cfg(t, 'lock:playing'));
    expect(lockRefused.text).toContain('⚠️ Channel lock needs a preferred voice channel first.');
    expect(t.guilds.getSettings(GUILD)).toMatchObject({ autostart: false, voiceLock: false });
    // The card greys them out for the same reason.
    expect(control(t, refused, 'autostart:playing')).toMatchObject({ label: 'Off', disabled: true });
    t.guilds.updateSettings(GUILD, {
      defaultStationId: t.stations.listStations(GUILD)[0]!.id,
      preferredVoiceChannelId: V1,
    });
    const on = await t.click(t.people.admin, cfg(t, 'autostart:playing'));
    await t.click(t.people.admin, cfg(t, 'lock:playing'));
    expect(t.guilds.getSettings(GUILD)).toMatchObject({ autostart: true, voiceLock: true });
    expect(control(t, on, 'autostart:playing')).toMatchObject({ label: 'On', style: 3, disabled: false });
    // Without the channel they stay on (the card says they do nothing yet), and still turn off.
    t.guilds.updateSettings(GUILD, { preferredVoiceChannelId: null });
    const card = await t.click(t.people.admin, cfg(t, 'go:playing'));
    expect(card.text).toContain('⚠️ It does nothing yet: it needs a preferred voice channel first.');
    await t.click(t.people.admin, cfg(t, 'autostart:playing'));
    await t.click(t.people.admin, cfg(t, 'lock:playing'));
    const resume = await t.click(t.people.admin, cfg(t, 'resume:playing'));
    expect(t.guilds.getSettings(GUILD)).toMatchObject({
      autostart: false,
      voiceLock: false,
      resumeOnRestart: !t.ctx.guilds.defaults.resumeOnRestart,
    });
    expect(resume.text).toContain('## Playing');
  });

  it('the last setup step offers autostart once it can work', async () => {
    const t = setup();
    const early = await t.click(t.people.admin, cfg(t, 'go:setup5'));
    expect(control(t, early, 'autostart:setup5')).toBeUndefined();
    t.guilds.updateSettings(GUILD, {
      defaultStationId: t.stations.listStations(GUILD)[0]!.id,
      preferredVoiceChannelId: V1,
    });
    const ready = await t.click(t.people.admin, cfg(t, 'go:setup5'));
    expect(ready.text).toContain('**Start playing by itself?**');
    const on = await t.click(t.people.admin, cfg(t, 'autostart:setup5'));
    expect(on.text).toContain('Finished');
    expect(t.guilds.getSettings(GUILD).autostart).toBe(true);
  });

  it('Reset everything puts every setting back, keeping favourites and the control panel', async () => {
    const { t, st } = customServer();
    const s = playingIn(t, V1, st.id);
    t.guilds.toggleFavourite(GUILD, st.id);
    t.guilds.updateSettings(GUILD, {
      allowedTextChannelIds: [TEXT],
      allowedVoiceChannelIds: [V1],
      djRoleIds: [DJ_ROLE],
      memberControlMode: 'none',
      defaultStationId: st.id,
      preferredVoiceChannelId: V1,
      voiceLock: true,
      qualityMode: 'manual',
      manualBitrateKbps: 64,
      idleMode: '24x7',
      autostart: true,
      resumeOnRestart: !t.ctx.guilds.defaults.resumeOnRestart,
      voiceChannelStatus: false,
      notificationChannelId: TEXT,
      panelChannelId: PANEL,
      panelMessageId: PANEL_MESSAGE,
    });
    const i = await t.click(t.people.admin, cfg(t, 'reset:home'));
    expect(i.violations).toEqual([]);
    expect(i.text).toContain('Every setting is back to its default.');
    expect(i.text).toMatch(/restarts for a moment/);
    expect(s.encoderRefreshes).toBe(1);
    const after = t.guilds.getSettings(GUILD);
    expect(after).toMatchObject({
      ...t.guilds.defaultSettings(),
      panelChannelId: PANEL,
      panelMessageId: PANEL_MESSAGE,
    });
    expect(t.guilds.listFavourites(GUILD)).toEqual([st.id]);
  });

  it('Reset is for admins only', async () => {
    const t = setup();
    t.guilds.updateSettings(GUILD, { idleMode: '24x7' });
    const i = await t.click(t.people.member, cfg(t, 'reset:home'));
    expect(i.text).toMatch(/Only the server owner/);
    expect(t.guilds.getSettings(GUILD).idleMode).toBe('24x7');
  });

  it('posts or moves the control panel from its page, deleting the old one', async () => {
    const t = setup();
    const panel = t.textChannel(PANEL);
    const old = t.textChannel(OLD_PANEL);
    t.guilds.updateSettings(GUILD, { panelChannelId: OLD_PANEL, panelMessageId: '500000000000000099' });
    const i = await t.click(t.people.admin, cfg(t, 'panel:panel'), 'channel', [PANEL]);
    expect(i.violations).toEqual([]);
    expect(methods(i)).toEqual(['deferUpdate', 'editReply']);
    expect(panel.sent).toHaveLength(1);
    expect(old.deleted).toEqual(['500000000000000099']);
    expect(t.guilds.getSettings(GUILD)).toMatchObject({
      panelChannelId: PANEL,
      panelMessageId: '500000000000000001',
    });
    expect(i.text).toContain('Posted in <#800000000000000010>. The old panel was deleted.');
    expect(i.text).toContain('**Now:** posted in <#800000000000000010>');
  });

  it('refuses a panel channel the bot can’t use, and changes nothing', async () => {
    const t = setup();
    const voice = await t.click(t.people.admin, cfg(t, 'panel:panel'), 'channel', [V2]);
    expect(voice.text).toContain('⚠️ Pick a text channel for the control panel.');
    t.guild.members.me = { id: '900000000000000099' };
    const muted = t.textChannel(PANEL);
    muted.canSend = false;
    const denied = await t.click(t.people.admin, cfg(t, 'panel:panel'), 'channel', [PANEL]);
    expect(methods(denied)).toEqual(['update']);
    expect(denied.text).toContain(
      'I need View Channel, Send Messages and Embed Links in <#800000000000000010>.',
    );
    expect(muted.sent).toEqual([]);
    expect(t.guilds.getSettings(GUILD).panelChannelId).toBeNull();
  });

  it('removes the control panel, even when its message is already gone', async () => {
    const t = setup();
    const panel = t.textChannel(PANEL);
    t.guilds.updateSettings(GUILD, { panelChannelId: PANEL, panelMessageId: PANEL_MESSAGE });
    const page = await t.click(t.people.admin, cfg(t, 'go:panel'));
    expect(control(t, page, 'go:unpanel')).toMatchObject({ label: 'Remove…', style: 4 });
    const i = await t.click(t.people.admin, cfg(t, 'unpanel:panel'));
    expect(methods(i)).toEqual(['deferUpdate', 'editReply']);
    expect(panel.deleted).toEqual([PANEL_MESSAGE]);
    expect(t.guilds.getSettings(GUILD)).toMatchObject({ panelChannelId: null, panelMessageId: null });
    expect(i.text).toContain('The control panel was removed.');
    // Nothing left to remove.
    const again = await t.click(t.people.admin, cfg(t, 'unpanel:panel'));
    expect(again.text).toContain('There is no control panel to remove.');
    // Already deleted by hand: removed all the same.
    t.guilds.updateSettings(GUILD, { panelChannelId: PANEL, panelMessageId: PANEL_MESSAGE });
    panel.deleteError = 10008;
    const gone = await t.click(t.people.admin, cfg(t, 'unpanel:panel'));
    expect(gone.text).toContain('The control panel was removed.');
    // Not allowed to delete it: stops updating it, and says so.
    t.guilds.updateSettings(GUILD, { panelChannelId: PANEL, panelMessageId: PANEL_MESSAGE });
    panel.deleteError = 50013;
    const stuck = await t.click(t.people.admin, cfg(t, 'unpanel:panel'));
    expect(stuck.text).toContain(
      'I couldn’t delete its message in <#800000000000000010>. Delete it by hand.',
    );
    expect(t.guilds.getSettings(GUILD).panelMessageId).toBeNull();
  });

  it('answers a card from before 1.3 with a new card, and its old controls still work', async () => {
    const t = setup();
    t.guilds.updateSettings(GUILD, { autostart: false, resumeOnRestart: true, voiceLock: false });
    const old = (field: string, kind: 'button' | 'string' = 'button', values: string[] = []) =>
      t.click(t.people.admin, cfg(t, field), kind, values, undefined, false);
    for (const [field, heading] of [
      ['page-access', '## Who can use it'],
      ['page-playback', '## Playing'],
      ['page-notify', '## Notices'],
    ] as const) {
      const i = await old(field);
      expect(methods(i)).toEqual(['reply']);
      expect(i.ephemeral).toBe(true);
      expect(i.text).toContain(heading);
    }
    // The menu that held all three switches: ticked is on.
    await old('switches', 'string', ['resume', 'lock']);
    expect(t.guilds.getSettings(GUILD)).toMatchObject({
      autostart: false,
      resumeOnRestart: true,
      voiceLock: true,
    });
    await old('resume');
    expect(t.guilds.getSettings(GUILD).resumeOnRestart).toBe(false);
  });

  it('every control on every screen is signed for this server and admin-only', async () => {
    for (const screen of ['home', 'access', 'playing', 'sound', 'notices', 'panel', 'setup2']) {
      // A new server each time, so the member's clicks stay under the click rate limit.
      const t = setup();
      t.guilds.updateSettings(GUILD, { panelChannelId: PANEL, qualityMode: 'manual' });
      const i = await t.click(t.people.admin, cfg(t, `go:${screen}`));
      for (const c of i.cardControls) {
        const p = decode(t.ids, c.custom_id ?? '');
        expect(p?.action === 'cfg' || p?.action === 'close').toBe(true);
        if (p?.action !== 'cfg') continue;
        const denied = await t.click(t.people.member, c.custom_id!, c.type === 2 ? 'button' : 'string', []);
        expect(denied.text).toMatch(/Only the server owner/);
      }
    }
  });
});

describe('import buttons', () => {
  it('a preview for another token, or none at all, has expired', async () => {
    const t = setup();
    const none = await t.click(t.people.admin, t.ids.make(GUILD, 'impx', 'token'));
    expect(none.text).toMatch(/This import preview expired/);
    expect(none.ephemeral).toBe(true);
  });

  it('are for administrators only', async () => {
    const t = setup();
    const i = await t.click(t.people.member, t.ids.make(GUILD, 'impx', 'token'));
    expect(i.text).toMatch(/Only the server owner/);
  });

  it('work for the owner outside the command channels', async () => {
    const t = setup();
    t.guilds.updateSettings(GUILD, { allowedTextChannelIds: ['800000000000000099'] });
    const i = await t.click({ id: OWNER }, t.ids.make(GUILD, 'impx', 'token'));
    // Admins are not bound by the command channels, so this reaches the preview check.
    expect(i.text).toMatch(/This import preview expired/);
  });
});
