import { describe, expect, it } from 'vitest';
import type { LibraryIndex } from '../../src/catalogue/pack-library.ts';
import { loadPack } from '../../src/catalogue/packs.ts';
import { RadioError } from '../../src/shared/errors.ts';
import { rootPath } from '../../src/shared/paths.ts';
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
    expect(done.lastText).toMatch(/Installed: 12 stations, ready to play now\./);
    expect(done.violations).toEqual([]);
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
