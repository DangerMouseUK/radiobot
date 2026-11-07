/**
 * Listener-triggered paths that touch the whole catalogue (list, stats, suggestions, Next and
 * Previous): they give the same answers as before while doing less work on the voice thread.
 */
import { describe, expect, it, vi } from 'vitest';
import { loadPack, seedPacks } from '../../src/catalogue/packs.ts';
import type { Station } from '../../src/catalogue/types.ts';
import { visibleStations } from '../../src/discord/context.ts';
import {
  IMPORT_MAX_BYTES,
  MAX_FAVOURITES,
  MAX_SOURCE_PREFERENCES,
} from '../../src/import-export/config-io.ts';
import { rootPath } from '../../src/shared/paths.ts';
import type { CoverageCounts } from '../../src/streams/source-service.ts';
import { GUILD, type Harness, OTHER_GUILD, setup, suggest, V1 } from './controller-harness.ts';

/** Adds pack stations (to the `demo` pack, so they are visible) in one transaction. */
function bulkStations(t: Harness, n: number, prefix = 'bulk'): string[] {
  const ids: string[] = [];
  t.db.transaction(() => {
    for (let k = 0; k < n; k++) {
      const slug = `${prefix}-${k}`;
      t.stations.upsertProviderStation({
        id: `demo:${slug}`,
        provider: 'demo',
        slug,
        externalId: null,
        displayName: `Bulk ${prefix} ${k}`,
        aliases: [],
        tags: [],
        category: null,
        sortOrder: 1000 + k,
        officialPageUrl: null,
        officialLastSeenAt: null,
        catalogueStatus: 'active',
        description: null,
      });
      ids.push(`demo:${slug}`);
    }
  });
  return ids;
}

/**
 * Two packs (the demo pack and the template pack), a retired station, sources in every state
 * coverage counts, this server's custom stations and another server's.
 */
function mixedCatalogue() {
  const t = setup();
  t.ctx.packs.put(loadPack(rootPath('catalog', 'packs', '_template'), 'installed'));
  seedPacks(t.stations, t.ctx.packs);
  const now = new Date().toISOString();
  const sources = t.stations.listAllSources();
  t.db.transaction(() => {
    sources.forEach((s, n) => {
      if (n % 3 === 0)
        t.stations.applyProbePatch(s.id, {
          lastProbeAt: now,
          verificationState: 'eligible',
          identityStatus: 'verified',
          codec: 'mp3',
          measuredBitrateKbps: 128,
        });
      if (n % 2 === 0) t.stations.recordSuccess(s.id);
      if (n % 7 === 0) t.stations.setSourceEnabled(s.id, false, 'test');
    });
  });
  t.stations.setCatalogueStatus('demo:demo-radio', 'retired');
  const mine = t.addCustomStation('My Station');
  t.addCustomStation('Silent Station', false);
  t.stations.recordSuccess(t.stations.listSources(mine.id)[0]!.id);
  t.stations.insertCustomStation({
    id: 'custom:theirs',
    guildId: OTHER_GUILD,
    slug: 'theirs',
    displayName: 'Theirs',
    description: null,
    category: null,
    websiteUrl: null,
    language: null,
    createdById: '1',
  });
  return t;
}

/** The counts as /radio list worked them out before: coverage() over every listed station. */
function listedBefore(t: Harness, scope: 'all' | 'packs', pack: string | null): CoverageCounts {
  const all = [...visibleStations(t.ctx, GUILD)];
  const list = pack
    ? all.filter((s) => s.provider === pack)
    : scope === 'all'
      ? all
      : all.filter((s) => s.provider !== 'custom');
  return t.ctx.sources.coverage(list);
}

const countsText = (c: CoverageCounts) =>
  `${c.catalogued} ${c.catalogued === 1 ? 'station' : 'stations'} · ${c.withSources} with a known stream · ${c.usable} with a working stream · ${c.verifiedPlayable} verified and playable`;

describe('/radio list and /radio stats count streams per pack', () => {
  it('give the same counts as counting every listed station, without counting the packs’ stations', async () => {
    const t = mixedCatalogue();
    // Each pack's counts are worked out once (with coverage() itself), then come from the cache.
    await t.command(t.people.member, { sub: 'list' });
    const coverage = vi.spyOn(t.ctx.sources, 'coverage');
    const cases: Array<['all' | 'packs', string | null]> = [
      ['all', null],
      ['packs', null],
      ['packs', 'demo'],
      ['all', 'template'],
    ];
    for (const [scope, pack] of cases) {
      const expected = countsText(listedBefore(t, scope, pack));
      coverage.mockClear();
      const i = await t.command(t.people.member, {
        sub: 'list',
        strings: { scope, pack },
      });
      expect(i.calls[0]!.payload.embeds![0]!.toJSON().footer?.text).toContain(expected);
      // Only this server's custom stations are counted now; each pack's counts come cached.
      for (const [list] of coverage.mock.calls) expect(list.every((s) => s.provider === 'custom')).toBe(true);
    }
    // A page click shows the same.
    const page = await t.click(t.people.member, t.ids.make(GUILD, 'list', 'all_:p1'));
    expect(page.calls[0]!.payload.embeds![0]!.toJSON().footer?.text).toContain(
      countsText(listedBefore(t, 'all', null)),
    );
    // A button naming "custom" as the pack lists, and counts, the custom stations.
    const asPack = await t.click(t.people.member, t.ids.make(GUILD, 'list', 'all_custom:p0'));
    expect(asPack.calls[0]!.payload.embeds![0]!.toJSON().footer?.text).toContain(
      countsText(listedBefore(t, 'all', 'custom')),
    );
    expect(listedBefore(t, 'all', 'custom')).toMatchObject({ catalogued: 2, withSources: 1 });
    // The fixture has counts of every kind, so equal numbers mean something.
    const all = listedBefore(t, 'all', null);
    expect(new Set([all.catalogued, all.withSources, all.usable, all.verifiedPlayable]).size).toBe(4);
    expect(Math.min(all.usable, all.verifiedPlayable)).toBeGreaterThan(0);

    // Stats: one line per pack, with the same counts as before.
    const before = new Map(
      ['demo', 'template'].map((id) => [
        id,
        t.ctx.sources.coverage(visibleStations(t.ctx, GUILD).filter((s) => s.provider === id)),
      ]),
    );
    coverage.mockClear();
    const stats = await t.command(t.people.admin, { sub: 'stats' });
    for (const [id, c] of before) {
      const name = t.ctx.packs.get(id)!.meta.name;
      expect(stats.text).toContain(
        `**${name}** (\`${id}\`): ${c.catalogued} stations · ${c.usable} with a working stream · ${c.verifiedPlayable} verified and playable`,
      );
    }
    expect(coverage).not.toHaveBeenCalled();
  });

  it('names a pack that isn’t installed, or is switched off, instead of saying there are no stations', async () => {
    const t = setup({ customOnly: true });
    const unknown = await t.command(t.people.member, { sub: 'list', strings: { pack: 'nopack' } });
    const off = await t.command(t.people.member, { sub: 'list', strings: { pack: 'demo' } });
    expect(unknown.calls[0]!.payload.embeds![0]!.toJSON().description).toBe(
      'No station pack called `nopack` is installed. Run `/radio list` on its own to see every station.',
    );
    expect(off.calls[0]!.payload.embeds![0]!.toJSON().description).toBe(
      'The station pack Radio Demo is switched off on this bot, so its stations can’t be listed or played.',
    );
    // Neither has stream counts to give.
    expect(off.calls[0]!.payload.embeds![0]!.toJSON().footer?.text).toMatch(
      /^Page 1\/1 · 0 stations · 0 with a known stream · 0 with a working stream · 0 verified and playable/,
    );
    // An enabled pack with nothing left to list says so.
    const t2 = setup();
    for (const s of t2.stations.listProviderStations('demo')) t2.stations.setCatalogueStatus(s.id, 'retired');
    const empty = await t2.command(t2.people.member, { sub: 'list', strings: { pack: 'demo' } });
    expect(empty.calls[0]!.payload.embeds![0]!.toJSON().description).toBe(
      'The station pack Radio Demo has no stations to list.',
    );
  });

  it('says that the bot’s owner installs packs when there are no stations at all', async () => {
    const t = setup({ customOnly: true });
    const list = await t.command(t.people.member, { sub: 'list' });
    const browse = await t.command(t.people.member, { sub: 'browse' });
    for (const i of [list, browse])
      expect(i.calls[0]!.payload.embeds![0]!.toJSON().description).toBe(
        'No stations yet. The bot’s operator can install station packs with `/radio packs library`, and admins can add a custom station with `/radio add`.',
      );
  });
});

/** The station suggestions with nothing typed, as they were worked out before (the oracle). */
function suggestedBefore(
  stations: readonly Station[],
  defaultId: string | null,
  favourites: string[],
): string[] {
  const top = [...new Set([defaultId, ...favourites])]
    .map((id) => stations.find((s) => s.id === id))
    .filter((s): s is Station => Boolean(s));
  const shown = new Set(top.map((s) => s.id));
  return [...top, ...stations.filter((s) => !shown.has(s.id))].slice(0, 25).map((s) => s.id);
}

describe('station suggestions with nothing typed', () => {
  it('are the same as before with 3000 stations and 500 favourites, the default first', async () => {
    const t = setup();
    const ids = bulkStations(t, 3000);
    const theirs = 'custom:theirs';
    t.stations.insertCustomStation({
      id: theirs,
      guildId: OTHER_GUILD,
      slug: 'theirs',
      displayName: 'Theirs',
      description: null,
      category: null,
      websiteUrl: null,
      language: null,
      createdById: '1',
    });
    const retired = ids[7]!;
    t.stations.setCatalogueStatus(retired, 'retired');
    // Favourites from the end of the catalogue, mixed with ones this server can't see.
    const favourites = [retired, theirs, ...ids.slice(2400, 2900).reverse()];
    t.guilds.setFavourites(GUILD, favourites);
    t.guilds.updateSettings(GUILD, { defaultStationId: ids[2600]! });
    const visible = visibleStations(t.ctx, GUILD);
    const choices = await suggest(t, 'play', 'station');
    expect(choices.map((c) => c.value)).toEqual(suggestedBefore(visible, ids[2600]!, favourites));
    expect(choices[0]).toMatchObject({ value: ids[2600] });
    expect(choices[0]!.name).toMatch(/\(default, favourite\)/);
    expect(choices).toHaveLength(25);

    // A few favourites: the rest are filled from the catalogue, without repeats.
    const few = [ids[2999]!, retired, ids[5]!];
    t.guilds.setFavourites(GUILD, few);
    t.guilds.updateSettings(GUILD, { defaultStationId: null });
    const filled = await suggest(t, 'play', 'station');
    expect(filled.map((c) => c.value)).toEqual(suggestedBefore(visible, null, few));
    expect(new Set(filled.map((c) => c.value)).size).toBe(25);
  });

  it('for edit and remove, only this server’s custom stations, favourites first', async () => {
    const t = setup();
    const ids = bulkStations(t, 50);
    const a = t.addCustomStation('Alpha Custom');
    const b = t.addCustomStation('Beta Custom');
    t.guilds.setFavourites(GUILD, [ids[3]!, b.id]);
    t.guilds.updateSettings(GUILD, { defaultStationId: ids[3]! });
    const custom = visibleStations(t.ctx, GUILD).filter((s) => s.provider === 'custom');
    const choices = await suggest(t, 'edit', 'station');
    expect(choices.map((c) => c.value)).toEqual(suggestedBefore(custom, ids[3]!, [ids[3]!, b.id]));
    expect(choices.map((c) => c.value)).toEqual([b.id, a.id]);
  });
});

describe('Next and Previous', () => {
  it('check access before they look through the catalogue', async () => {
    const t = setup();
    t.guilds.updateSettings(GUILD, { memberControlMode: 'none' });
    const availability = vi.spyOn(t.ctx.sources, 'availability');
    for (const action of ['next', 'prev'] as const) {
      const i = await t.click(t.people.member, t.ids.make(GUILD, action));
      expect(i.text).toMatch(/Only DJs and administrators can control the radio/);
    }
    expect(availability).not.toHaveBeenCalled();
    expect(t.sessions.plays).toEqual([]);
    // Someone who may control still moves on.
    t.putInVoice(t.people.admin, V1);
    await t.click(t.people.admin, t.ids.make(GUILD, 'next'));
    expect(t.sessions.plays).toHaveLength(1);
  });

  it('step through the favourites by ID, skipping ones that have gone', async () => {
    const t = setup();
    const ids = bulkStations(t, 5);
    t.stations.setCatalogueStatus(ids[2]!, 'retired');
    t.guilds.setFavourites(GUILD, [ids[0]!, ids[2]!, ids[4]!]);
    t.putInVoice(t.people.admin, V1);
    const s = t.sessions.ensure(GUILD);
    Object.assign(s, { connected: true, channelId: V1, stationId: ids[0]! });
    t.guilds.setIntent(GUILD, { desiredState: 'playing', desiredStationId: ids[0]! });
    t.stations.insertSource({
      id: 'bulk-4-1',
      stationId: ids[4]!,
      url: 'https://radio.example.org/bulk-4',
      label: null,
      priority: 10,
      transportHint: 'http-continuous',
      codecHint: 'mp3',
      provenance: 'curated',
      provenanceDetail: null,
      rightsStatus: 'unreviewed',
    });
    await t.click(t.people.admin, t.ids.make(GUILD, 'next'));
    expect(t.sessions.plays.map((p) => p.stationId)).toEqual([ids[4]]);
  });
});

describe('caps that keep a server’s export importable', () => {
  it('refuses a favourite beyond the most a server keeps, and still allows removing one', async () => {
    const t = setup();
    const ids = bulkStations(t, MAX_FAVOURITES + 1);
    t.guilds.setFavourites(GUILD, ids.slice(0, MAX_FAVOURITES));
    t.putInVoice(t.people.admin, V1);
    const refused = await t.click(t.people.admin, t.ids.make(GUILD, 'fav', ids[MAX_FAVOURITES]!));
    expect(refused.text).toMatch(
      new RegExp(`already has ${MAX_FAVOURITES} favourites, the most it can keep\\. Remove one`),
    );
    expect(refused.ephemeral).toBe(true);
    expect(t.guilds.listFavourites(GUILD)).toHaveLength(MAX_FAVOURITES);
    // One already a favourite is still "already a favourite", and removing one makes room.
    expect((await t.click(t.people.admin, t.ids.make(GUILD, 'fav', ids[0]!))).text).toMatch(/already one/);
    await t.click(t.people.admin, t.ids.make(GUILD, 'unfav', ids[0]!));
    await t.click(t.people.admin, t.ids.make(GUILD, 'fav', ids[MAX_FAVOURITES]!));
    expect(t.guilds.isFavourite(GUILD, ids[MAX_FAVOURITES]!)).toBe(true);
  });

  it('refuses a source choice for one more station beyond the most a server keeps', async () => {
    const t = setup();
    const ids = bulkStations(t, MAX_SOURCE_PREFERENCES + 1);
    t.db.transaction(() => {
      ids.forEach((id, k) => {
        t.stations.insertSource({
          id: `bulk-${k}-1`,
          stationId: id,
          url: `https://radio.example.org/bulk-${k}`,
          label: null,
          priority: 10,
          transportHint: 'http-continuous',
          codecHint: 'mp3',
          provenance: 'curated',
          provenanceDetail: null,
          rightsStatus: 'unreviewed',
        });
        if (k < MAX_SOURCE_PREFERENCES) t.guilds.setPreference(GUILD, id, 'prefer', `bulk-${k}-1`, null);
      });
    });
    const last = ids[MAX_SOURCE_PREFERENCES]!;
    const refused = await t.command(t.people.admin, {
      sub: 'pin',
      group: 'source',
      strings: { station: last, source: `bulk-${MAX_SOURCE_PREFERENCES}-1` },
    });
    expect(refused.text).toMatch(/source choices for 1000 stations, the most it can keep/);
    expect(t.guilds.getPreference(GUILD, last)).toBeNull();
    // Changing the choice of a station that already has one is fine.
    const changed = await t.command(t.people.admin, {
      sub: 'pin',
      group: 'source',
      strings: { station: ids[0]!, source: 'bulk-0-1' },
    });
    expect(changed.text).toMatch(/Source pinned/);
    expect(t.guilds.getPreference(GUILD, ids[0]!)?.mode).toBe('pin');
    // "Use this source first" on a playing station is refused the same way.
    const s = t.sessions.ensure(GUILD);
    Object.assign(s, {
      connected: true,
      channelId: V1,
      stationId: last,
      playingSourceId: `bulk-${MAX_SOURCE_PREFERENCES}-1`,
    });
    const button = await t.click(t.people.admin, t.ids.make(GUILD, 'spref', last));
    expect(button.text).toMatch(/the most it can keep/);
    expect(t.guilds.getPreference(GUILD, last)).toBeNull();
  });

  it('warns when an export is too big for /radio import', async () => {
    const t = setup({ customOnly: true });
    t.db.transaction(() => {
      for (let k = 0; k < 140; k++) {
        const st = t.addCustomStation(`Long Url ${k}`, false);
        t.stations.insertSource({
          id: `long-${k}`,
          stationId: st.id,
          url: `https://radio.example.org/${'a'.repeat(1990)}${k}`,
          label: null,
          priority: 10,
          transportHint: 'http-continuous',
          codecHint: 'mp3',
          provenance: 'curated',
          provenanceDetail: null,
          rightsStatus: 'unreviewed',
        });
      }
    });
    const big = await t.command(t.people.admin, { sub: 'export' });
    expect(String(big.calls[0]!.payload.content)).toMatch(
      new RegExp(`larger than \`/radio import\` accepts \\(${IMPORT_MAX_BYTES / 1024} KB\\)`),
    );
    const other = setup();
    const small = await other.command(other.people.admin, { sub: 'export' });
    expect(String(small.calls[0]!.payload.content)).not.toMatch(/larger than/);
  });
});

describe('help', () => {
  it('describes the bitrate of each quality mode truthfully', async () => {
    const t = setup();
    const i = await t.command(t.people.member, { sub: 'help' });
    expect(i.text).toContain('`/radio now`: what is playing · `/radio stop`: stop playing');
    expect(i.text).toContain(
      '**Maximum** follows the station’s own bitrate, but never below 128 kbps (96 for mono) (510 kbps at most)',
    );
    expect(i.text).toContain('**Balanced** uses at most 128 kbps');
    expect(i.text).toContain('**Manual** uses the bitrate an admin sets (510 kbps at most)');
  });
});
