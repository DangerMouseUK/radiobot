import { describe, expect, it } from 'vitest';
import type { LibraryIndex } from '../../src/catalogue/pack-library.ts';
import { loadPack } from '../../src/catalogue/packs.ts';
import { RadioError } from '../../src/shared/errors.ts';
import { rootPath } from '../../src/shared/paths.ts';
import { emptyOutcome, type ProbeOutcome } from '../../src/streams/probe.ts';
import { decode, type Harness, OWNER, setup } from './controller-harness.ts';

/** A library with one pack that isn't installed and one that is (the demo fixture pack). */
function library(): LibraryIndex {
  const entry = (id: string, name: string, extra: object = {}) => ({
    id,
    name,
    description: '',
    version: '2026.11.03',
    owner: { name: 'Example Media', kind: 'group' as const, brand: null },
    countries: ['GB'],
    regions: ['Manchester'],
    languages: ['en'],
    stations: 12,
    sources: 12,
    lastChecked: '2026-11-01',
    minBotVersion: null,
    status: 'available' as const,
    withdrawnReason: null,
    file: `${id}.json`,
    sha256: 'a'.repeat(64),
    bytes: 100,
    ...extra,
  });
  return {
    schemaVersion: 1,
    generatedAt: '2026-11-03T00:00:00Z',
    packs: [
      entry('northern', 'Northern Hits'),
      entry('paris', 'Paris Dance', { countries: ['FR'], languages: ['fr'], regions: [] }),
    ],
    collections: [],
  };
}

/** The custom ID of the first component in the last reply whose action is `action`. */
function componentId(t: Harness, ids: string[], action: string): string {
  const id = ids.find((c) => decode(t.ids, c)?.action === action);
  if (!id) throw new Error(`no ${action} component in ${ids.join(', ')}`);
  return id;
}

/** Label and disabled state of every button in a reply. */
function buttonsIn(payload: { components?: unknown[] }): Array<{ label: string; disabled: boolean }> {
  return (payload.components ?? []).flatMap((row) =>
    (row as { toJSON(): { components: Array<{ label?: string; disabled?: boolean }> } })
      .toJSON()
      .components.map((c) => ({ label: String(c.label), disabled: c.disabled === true })),
  );
}

describe('/radio packs', () => {
  it('lists the installed packs privately, for admins only', async () => {
    const t = setup();
    t.packLibrary.index = library();
    const i = await t.command(t.people.admin, { group: 'packs', sub: 'installed' });
    expect(i.ephemeral).toBe(true);
    expect(i.violations).toEqual([]);
    expect(i.lastText).toMatch(/Station packs/);
    expect(i.lastText).toMatch(
      /\(`demo`\) · version 2026\.11\.03 · 26 stations · your own pack \(EXTRA_PACKS_DIR\)/,
    );
    const member = await t.command(t.people.member, { group: 'packs', sub: 'installed' });
    expect(member.text).not.toMatch(/Station packs/);
  });

  it('still lists installed packs when the library cannot be reached', async () => {
    const t = setup();
    const i = await t.command(t.people.admin, { group: 'packs', sub: 'installed' });
    expect(i.lastText).toMatch(/demo/);
  });

  it('shows the library filtered by search and country, with a menu to pick a pack', async () => {
    const t = setup();
    t.packLibrary.index = library();
    const all = await t.command(t.people.admin, { group: 'packs', sub: 'library' });
    expect(all.lastText).toMatch(/Northern Hits/);
    expect(all.lastText).toMatch(/Paris Dance/);
    const fr = await t.command(t.people.admin, {
      group: 'packs',
      sub: 'library',
      strings: { country: 'France' },
    });
    expect(fr.lastText).toMatch(/Paris Dance/);
    expect(fr.lastText).not.toMatch(/Northern Hits/);
    const city = await t.command(t.people.admin, {
      group: 'packs',
      sub: 'library',
      strings: { search: 'manchester' },
    });
    expect(city.lastText).toMatch(/Northern Hits/);
    expect(city.lastText).not.toMatch(/Paris/);
    expect(city.componentIds.some((c) => decode(t.ids, c)?.action === 'pksel')).toBe(true);
  });

  it('says plainly when the library cannot be reached', async () => {
    const t = setup();
    const i = await t.command(t.people.admin, { group: 'packs', sub: 'library' });
    expect(i.lastText).toMatch(/Couldn’t reach the pack library: The pack library took too long to answer\./);
  });

  it('lets an operator install a pack from its card, reporting when it is done', async () => {
    const t = setup({ operators: [OWNER] });
    t.packLibrary.index = library();
    const list = await t.command(t.people.owner, { group: 'packs', sub: 'library' });
    const card = await t.click(t.people.owner, componentId(t, list.componentIds, 'pksel'), 'string', [
      'northern',
    ]);
    expect(card.lastText).toMatch(/Northern Hits \(northern\)/);
    expect(card.lastText).toMatch(/Company: Example Media/);
    expect(card.lastText).toMatch(/Not installed\./);
    const done = await t.click(t.people.owner, componentId(t, card.componentIds, 'pkinst'));
    expect(t.packLibrary.installs).toEqual(['northern']);
    expect(done.text).toMatch(/Working on it in the background/);
    // While it installs, Install gives way to one greyed-out "Installing…" button.
    expect(buttonsIn(done.calls[0]!.payload)).toEqual([{ label: 'Installing…', disabled: true }]);
    expect(done.lastText).toMatch(/Installed: 12 stations, ready to play now\./);
    expect(buttonsIn(done.calls.at(-1)!.payload).every((b) => !b.disabled)).toBe(true);
    expect(done.violations).toEqual([]);
  });

  it('says "Updating…" while an installed pack updates', async () => {
    const t = setup({ operators: [OWNER] });
    t.ctx.packs.put(loadPack(rootPath('catalog', 'packs', '_template'), 'installed'));
    const done = await t.click(t.people.owner, t.ids.make('123456789012345678', 'pkinst', 'template'));
    expect(buttonsIn(done.calls[0]!.payload)).toEqual([{ label: 'Updating…', disabled: true }]);
  });

  it('reports a failed install with its reason', async () => {
    const t = setup({ operators: [OWNER] });
    t.packLibrary.index = library();
    t.packLibrary.failure = new RadioError(
      'PACK_INVALID',
      'The download doesn’t match the library’s fingerprint.',
    );
    const done = await t.click(t.people.owner, t.ids.make('123456789012345678', 'pkinst', 'northern'));
    expect(done.lastText).toMatch(/doesn’t match the library’s fingerprint/);
  });

  it('only lets an operator change packs, since they are shared by every server', async () => {
    const t = setup();
    t.packLibrary.index = library();
    const i = await t.click(t.people.admin, t.ids.make('123456789012345678', 'pkinst', 'northern'));
    expect(i.text).toMatch(/only the bot owner can install, update or remove them/);
    expect(t.packLibrary.installs).toEqual([]);
    const member = await t.click(t.people.member, t.ids.make('123456789012345678', 'pkrm', 'demo'));
    expect(member.text).not.toMatch(/Remove/);
    expect(t.packLibrary.removes).toEqual([]);
  });

  it('asks before removing a pack, then removes it', async () => {
    const t = setup({ operators: [OWNER] });
    const ask = await t.click(t.people.owner, t.ids.make('123456789012345678', 'pkrm', 'demo'));
    expect(ask.lastText).toMatch(/Its stations disappear from every server this bot is in/);
    const done = await t.click(t.people.owner, componentId(t, ask.componentIds, 'pkrmok'));
    expect(t.packLibrary.removes).toEqual(['demo']);
    // The confirmation gives way to the card with a greyed-out "Removing…" until it is done.
    const working = done.calls.find((c) => c.method === 'editReply')!.payload;
    expect(buttonsIn(working)).toEqual([{ label: 'Removing…', disabled: true }]);
    expect(done.lastText).toMatch(/Removed\./);
  });

  it('refuses to change packs when the bot has no data folder', async () => {
    const t = setup({ operators: [OWNER] });
    t.packLibrary.canInstall = false;
    const i = await t.click(t.people.owner, t.ids.make('123456789012345678', 'pkinst', 'northern'));
    expect(i.text).toMatch(/no data folder/);
  });

  it('shows an update available and a notice on the installed list', async () => {
    const t = setup();
    t.packLibrary.index = library();
    t.packLibrary.updates.set('demo', '2026.12.01');
    t.packLibrary.notices.push('**Old Pack** was withdrawn from the pack library and has been removed.');
    const i = await t.command(t.people.admin, { group: 'packs', sub: 'installed' });
    expect(i.lastText).toMatch(/update available: 2026\.12\.01/);
    expect(i.lastText).toMatch(/Old Pack\*\* was withdrawn/);
  });

  it('offers Update and Remove for an installed pack, and lists packs that were not loaded', async () => {
    const t = setup({ operators: [OWNER] });
    // The template pack, as if installed from the library.
    t.ctx.packs.put(loadPack(rootPath('catalog', 'packs', '_template'), 'installed'));
    t.ctx.packs.skipped = [{ dir: '/data/installed-packs/broken', reason: 'pack.json is invalid' }];
    const index = library();
    index.packs.push({
      ...index.packs[0]!,
      id: 'template',
      name: 'Example Radio Network',
      version: '2099.01.01',
    });
    t.packLibrary.index = index;
    t.packLibrary.updates.set('template', '2099.01.01');
    const list = await t.command(t.people.owner, { group: 'packs', sub: 'installed' });
    expect(list.lastText).toMatch(/\(`template`\) .* installed from the library/);
    expect(list.lastText).toMatch(/Not loaded/);
    expect(list.lastText).toMatch(/broken`: pack\.json is invalid/);
    const card = await t.click(t.people.owner, componentId(t, list.componentIds, 'pksel'), 'string', [
      'template',
    ]);
    expect(card.lastText).toMatch(/Installed version: 2026\.11\.03 · installed from the library/);
    const buttons = card.componentIds.map((c) => decode(t.ids, c)?.action);
    expect(buttons).toEqual(['pkinst', 'pkrm']);
  });

  it('names skipped packs in /radio stats', async () => {
    const t = setup();
    t.ctx.packs.skipped = [{ dir: '/data/installed-packs/broken', reason: 'pack.json is invalid' }];
    const i = await t.command(t.people.admin, { sub: 'stats' });
    expect(i.text).toMatch(/Not loaded: `\/data\/installed-packs\/broken` \(see `\/radio packs installed`\)/);
  });

  it('describes a pack the library no longer lists', async () => {
    const t = setup({ operators: [OWNER] });
    t.packLibrary.index = library();
    const card = await t.click(
      t.people.owner,
      t.ids.make('123456789012345678', 'pksel', 'installed'),
      'string',
      ['demo'],
    );
    expect(card.lastText).toMatch(/doesn’t list this pack/);
    expect(card.lastText).toMatch(/your own pack \(EXTRA_PACKS_DIR\)/);
    expect(card.componentIds).toEqual([]);
  });

  it('caps a long library list and takes a country code too', async () => {
    const t = setup();
    const index = library();
    for (let n = 0; n < 30; n++)
      index.packs.push({ ...index.packs[0]!, id: `extra-${n}`, name: `Extra ${n}` });
    t.packLibrary.index = index;
    const many = await t.command(t.people.admin, {
      group: 'packs',
      sub: 'library',
      strings: { country: 'gb' },
    });
    expect(many.lastText).toMatch(/Showing 25 of 31/);
    const none = await t.command(t.people.admin, {
      group: 'packs',
      sub: 'library',
      strings: { country: 'Atlantis' },
    });
    expect(none.lastText).toMatch(/No packs match that/);
  });
});

/** A passing check, as the probe reports it. */
const passing = (): ProbeOutcome => ({
  ...emptyOutcome(Date.now()),
  success: true,
  transport: 'http-continuous',
  container: 'mp3',
  codec: 'mp3',
  sampleRateHz: 44_100,
  channels: 2,
  channelLayout: 'stereo',
  measuredBitrateKbps: 128,
  bitrateEvidence: 'measured',
});

const until = async (cond: () => boolean, ms = 2_000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('Check all sources again', () => {
  const G = '123456789012345678';

  it('is a button on /radio packs installed, and only the bot owner may use it', async () => {
    const t = setup({ operators: [OWNER] });
    const list = await t.command(t.people.admin, { group: 'packs', sub: 'installed' });
    expect(buttonsIn(list.calls.at(-1)!.payload)).toContainEqual({
      label: 'Check all sources again',
      disabled: false,
    });
    // An admin of this server who isn't the bot's operator: refused, nothing starts.
    const admin = await t.click(t.people.admin, componentId(t, list.componentIds, 'pkchk'));
    expect(admin.text).toMatch(/only the bot owner can start or stop it/);
    const confirm = await t.click(t.people.admin, t.ids.make(G, 'pkchkok'));
    expect(confirm.text).toMatch(/only the bot owner/);
    const member = await t.click(t.people.member, t.ids.make(G, 'pkchkok'));
    expect(member.text).not.toMatch(/Checked/);
    const stop = await t.click(t.people.admin, t.ids.make(G, 'pkchkx'));
    expect(stop.text).toMatch(/only the bot owner/);
    expect(t.ctx.fullCheck.state).toBeNull();
  });

  it('asks first, then checks every pack source in the background and reports the result', async () => {
    const t = setup({ operators: [OWNER] });
    t.probe.impl = async () => passing();
    const ask = await t.click(t.people.owner, t.ids.make(G, 'pkchk'));
    expect(ask.lastText).toMatch(/Check every source again\?/);
    expect(ask.lastText).toMatch(/sources paused after a week of failing/);
    expect(ask.componentIds.map((c) => decode(t.ids, c)?.action)).toEqual(['pkchkok', 'close']);
    expect(t.ctx.fullCheck.state).toBeNull();

    const go = await t.click(t.people.owner, componentId(t, ask.componentIds, 'pkchkok'));
    expect(go.violations).toEqual([]);
    expect(go.calls[0]!.method).toBe('update');
    await until(() => t.ctx.fullCheck.state?.status === 'finished');
    const total = t.stations
      .listAllSources()
      .filter((s) => s.stationId.startsWith('demo:') && s.enabled).length;
    expect(t.ctx.fullCheck.state).toMatchObject({ total, done: total, usable: total, failed: 0 });
    // The reply follows the run to its end, then shows the summary.
    await until(() => /Finished/.test(go.lastText));
    expect(go.lastText).toContain(`checked ${total} of ${total}.`);
    expect(go.lastText).toContain(`${total} working (${total} newly working) · 0 failing.`);
    // Reopened later, the list shows the last run, and the button is back.
    const again = await t.command(t.people.admin, { group: 'packs', sub: 'installed' });
    expect(again.lastText).toMatch(/Check of every source/);
    expect(again.lastText).toMatch(/Finished <t:\d+:R>/);
    expect(buttonsIn(again.calls.at(-1)!.payload).map((b) => b.label)).toContain('Check all sources again');
  });

  it('can start only once every 6 hours', async () => {
    const t = setup({ operators: [OWNER] });
    t.probe.impl = async () => passing();
    await t.click(t.people.owner, t.ids.make(G, 'pkchkok'));
    await until(() => t.ctx.fullCheck.state?.status === 'finished');
    const second = await t.click(t.people.owner, t.ids.make(G, 'pkchkok'));
    expect(second.text).toMatch(/Too many checks of every source in a short time\. Try again in 6 h\./);
    expect(t.ctx.fullCheck.running).toBe(false);
  });

  it('runs one at a time, shows its progress when reopened, and stops on Stop', async () => {
    const t = setup({ operators: [OWNER] });
    let checks = 0;
    // Each check waits until it is stopped.
    t.probe.impl = (_deps, _url, _budget, signal) => {
      checks++;
      return new Promise((resolve) =>
        signal?.addEventListener('abort', () =>
          resolve({ ...emptyOutcome(Date.now()), failureCode: 'CANCELLED' }),
        ),
      );
    };
    const go = await t.click(t.people.owner, t.ids.make(G, 'pkchkok'));
    await until(() => checks === 1);
    expect(buttonsIn(go.calls.at(-1)!.payload).map((b) => b.label)).toContain('Stop the check');
    const open = await t.command(t.people.admin, { group: 'packs', sub: 'installed' });
    expect(open.lastText).toMatch(/Checked 0 of \d+\*\*, one at a time in the background/);
    // A second start while it runs: said plainly, and it doesn't use up the 6-hour allowance.
    const twice = await t.click(t.people.owner, t.ids.make(G, 'pkchkok'));
    expect(twice.lastText).toMatch(/already running/);
    expect(t.ctx.limits.fullCheckGlobal.take('global')).toBeGreaterThan(0);

    const stop = await t.click(t.people.owner, componentId(t, open.componentIds, 'pkchkx'));
    expect(stop.violations).toEqual([]);
    expect(t.ctx.fullCheck.running).toBe(false);
    expect(t.ctx.fullCheck.state?.status).toBe('stopped');
    expect(stop.lastText).toMatch(/Stopped <t:\d+:R> after checking 0 of \d+\./);
    expect(buttonsIn(stop.calls.at(-1)!.payload).map((b) => b.label)).toContain('Check all sources again');
    expect(checks).toBe(1);
  });
});
