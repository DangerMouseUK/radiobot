import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CUSTOM_PROVIDER,
  discoverPackDirs,
  loadPack,
  PackRegistry,
  type StationPack,
} from '../../src/catalogue/packs.ts';
import { loadConfig } from '../../src/config/env.ts';
import { COMPONENT_ACTIONS, ComponentIds, MAX_ARG_LENGTH } from '../../src/discord/components/custom-id.ts';
import { MAX_SLUG_LENGTH } from '../../src/shared/text.ts';

const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempRoot = () => {
  const d = mkdtempSync(join(tmpdir(), 'radiobot-packs2-'));
  roots.push(d);
  return d;
};

const source = (id: string, station: string, url = `https://radio.example.org/${id}`) => ({
  id,
  station,
  url,
  provenance: 'curated',
  provenanceDetail: 'Listed on the broadcaster website.',
});

function writeFiles(
  dir: string,
  files: { meta?: object; stations?: unknown; sources?: unknown; raw?: Record<string, string> },
) {
  mkdirSync(dir, { recursive: true });
  const id = dir.split(/[\\/]/).pop();
  writeFileSync(
    join(dir, 'pack.json'),
    JSON.stringify({ schemaVersion: 1, id, name: `Pack ${id}`, ...files.meta }),
  );
  writeFileSync(
    join(dir, 'stations.json'),
    JSON.stringify(
      files.stations ?? {
        schemaVersion: 1,
        stations: [
          { slug: 'one', displayName: 'Station One', order: 1 },
          { slug: 'two', displayName: 'Station Two', order: 2 },
        ],
      },
    ),
  );
  if (files.sources !== null) {
    writeFileSync(
      join(dir, 'sources.json'),
      JSON.stringify(files.sources ?? { schemaVersion: 1, sources: [source('one-a', 'one')] }),
    );
  }
  for (const [name, text] of Object.entries(files.raw ?? {})) writeFileSync(join(dir, name), text);
  return dir;
}

const fakePack = (
  id: string,
  meta: Partial<StationPack['meta']> = {},
  sourceIds: string[] = [],
): StationPack => ({
  meta: {
    schemaVersion: 1,
    id,
    name: `Pack ${id}`,
    description: '',
    disclaimer: null,
    order: 100,
    enabledByDefault: true,
    brandLabels: [],
    categories: [],
    sync: null,
    snapshotDate: null,
    ...meta,
  },
  dir: `/packs/${id}`,
  stations: [],
  sources: sourceIds.map((sid) => ({ ...source(sid, 'one'), stationId: `${id}:one` }) as never),
});

describe('loadPack validation', () => {
  it('limits slugs so the longest possible station id still fits signed button ids', () => {
    const root = tempRoot();
    const tooLong = 'a'.repeat(MAX_SLUG_LENGTH + 1);
    const station = (slug: string) => ({
      schemaVersion: 1,
      stations: [{ slug, displayName: 'One', order: 1 }],
    });
    expect(() =>
      loadPack(writeFiles(join(root, 'long'), { stations: station(tooLong), sources: null })),
    ).toThrow();
    const packId = 'p'.repeat(32);
    const longest = `${packId}:${'s'.repeat(MAX_SLUG_LENGTH)}`;
    expect(
      loadPack(
        writeFiles(join(root, packId), { stations: station('s'.repeat(MAX_SLUG_LENGTH)), sources: null }),
      ).stations[0]!.id,
    ).toBe(longest);
    const ids = new ComponentIds('secret');
    expect(longest).toHaveLength(MAX_ARG_LENGTH);
    for (const action of COMPONENT_ACTIONS) {
      for (const ttl of [15 * 60_000, null]) {
        expect(ids.parse('123456789012345678', ids.make('123456789012345678', action, longest, ttl))).toEqual(
          {
            action,
            arg: longest,
            expired: false,
          },
        );
      }
    }
  });

  it('rejects duplicate station slugs and duplicate source ids', () => {
    const root = tempRoot();
    expect(() =>
      loadPack(
        writeFiles(join(root, 'dupslug'), {
          stations: {
            schemaVersion: 1,
            stations: [
              { slug: 'one', displayName: 'A', order: 1 },
              { slug: 'one', displayName: 'B', order: 2 },
            ],
          },
          sources: { schemaVersion: 1, sources: [] },
        }),
      ),
    ).toThrow(/duplicate station slug "one"/);
    expect(() =>
      loadPack(
        writeFiles(join(root, 'dupsrc'), {
          sources: {
            schemaVersion: 1,
            sources: [source('one-a', 'one'), source('one-a', 'two', 'https://radio.example.org/other')],
          },
        }),
      ),
    ).toThrow(/duplicate source id "one-a"/);
  });

  it('refuses one URL mapped to two stations but allows it twice for the same station', () => {
    const root = tempRoot();
    const url = 'https://radio.example.org/shared';
    expect(() =>
      loadPack(
        writeFiles(join(root, 'shared'), {
          sources: { schemaVersion: 1, sources: [source('one-a', 'one', url), source('two-a', 'two', url)] },
        }),
      ),
    ).toThrow(/also mapped to station "one"/);
    const ok = loadPack(
      writeFiles(join(root, 'same'), {
        sources: { schemaVersion: 1, sources: [source('one-a', 'one', url), source('one-b', 'one', url)] },
      }),
    );
    expect(ok.sources.map((s) => s.stationId)).toEqual(['same:one', 'same:one']);
  });

  it('names the file and field when the schema is violated', () => {
    const root = tempRoot();
    expect(() =>
      loadPack(
        writeFiles(join(root, 'noorder'), {
          stations: { schemaVersion: 1, stations: [{ slug: 'one', displayName: 'One' }] },
        }),
      ),
    ).toThrow(/stations\.json is invalid:[\s\S]*stations\.0\.order/);
    expect(() =>
      loadPack(
        writeFiles(join(root, 'ftp'), {
          sources: { schemaVersion: 1, sources: [source('one-a', 'one', 'ftp://radio.example.org/x')] },
        }),
      ),
    ).toThrow(/http\(s\) only/);
    expect(() =>
      loadPack(
        writeFiles(join(root, 'badsync'), {
          meta: { sync: { adapter: 'nope', url: 'https://x.example.org' } },
        }),
      ),
    ).toThrow(/unknown sync adapter/);
    expect(() => loadPack(writeFiles(join(root, 'Upper'), {}))).toThrow(/pack\.json is invalid/);
  });

  it('reports unreadable JSON with its path', () => {
    const root = tempRoot();
    const dir = writeFiles(join(root, 'broken'), { raw: { 'stations.json': '{ nope' } });
    expect(() => loadPack(dir)).toThrow(/stations\.json/);
  });

  it('treats a missing sources.json as a pack without sources and fills schema defaults', () => {
    const root = tempRoot();
    const pack = loadPack(writeFiles(join(root, 'bare'), { sources: null }));
    expect(pack.sources).toEqual([]);
    expect(pack.meta).toMatchObject({ order: 100, enabledByDefault: true, disclaimer: null, sync: null });
    expect(pack.stations[0]).toMatchObject({
      id: 'bare:one',
      aliases: [],
      tags: [],
      category: null,
      catalogueStatus: 'active',
    });
  });
});

describe('pack discovery', () => {
  it('finds pack folders only, skipping hidden, underscored and non-pack folders', () => {
    const root = tempRoot();
    writeFiles(join(root, 'b-pack'), {});
    writeFiles(join(root, 'a-pack'), {});
    writeFiles(join(root, '.hidden'), {});
    writeFiles(join(root, '_draft'), {});
    mkdirSync(join(root, 'empty'));
    writeFileSync(join(root, 'notes.txt'), 'x');
    expect(discoverPackDirs(root).map((d) => d.split(/[\\/]/).pop())).toEqual(['a-pack', 'b-pack']);
    expect(discoverPackDirs(join(root, 'does-not-exist'))).toEqual([]);
  });
});

describe('PackRegistry', () => {
  it('orders packs by order then id, with custom stations after every pack', () => {
    const r = new PackRegistry([fakePack('zeta', { order: 5 }), fakePack('beta'), fakePack('alpha')]);
    expect(r.packs.map((p) => p.meta.id)).toEqual(['zeta', 'alpha', 'beta']);
    expect(r.orderOf('zeta')).toBe(0);
    expect(r.orderOf('beta')).toBe(2);
    expect(r.orderOf('unknown')).toBeLessThan(r.orderOf(CUSTOM_PROVIDER));
    expect(r.orderOf('unknown')).toBeGreaterThan(r.orderOf('beta'));
    expect(r.get('alpha')?.meta.id).toBe('alpha');
    expect(r.get('nope')).toBeNull();
  });

  it('lets DISABLED_PACKS win over ENABLED_PACKS and hides disabled packs’ categories', () => {
    const packs = [
      fakePack('on', { categories: [{ id: 'news', name: 'News' }] }),
      fakePack('optin', { enabledByDefault: false, categories: [{ id: 'jazz', name: 'Jazz' }] }),
    ];
    const config = loadConfig({
      DISCORD_TOKEN: 'x'.repeat(30),
      DISCORD_APPLICATION_ID: '123456789012345678',
      ENABLED_PACKS: 'optin',
      DISABLED_PACKS: 'on',
    });
    const r = new PackRegistry(packs, { enabled: config.enabledPacks, disabled: config.disabledPacks });
    expect(r.isEnabled('optin')).toBe(true);
    expect(r.isEnabled('on')).toBe(false);
    expect(r.enabledPacks().map((p) => p.meta.id)).toEqual(['optin']);
    expect(r.categories()).toEqual([{ id: 'jazz', name: 'Jazz', packId: 'optin' }]);
    const both = new PackRegistry(packs, { enabled: new Set(['optin']), disabled: new Set(['optin']) });
    expect(both.isEnabled('optin')).toBe(false);
    expect(new PackRegistry(packs).isEnabled('optin')).toBe(false);
  });

  it('rejects a source id reused by another pack', () => {
    expect(
      () => new PackRegistry([fakePack('one', {}, ['shared-src']), fakePack('two', {}, ['shared-src'])]),
    ).toThrow(/Source id "shared-src" is used by packs "one" and "two"/);
  });

  it('normalises brand labels for identity checks', () => {
    const r = new PackRegistry([fakePack('fm', { brandLabels: ['Radio FM!', 'FM Network', '---'] })]);
    expect([...r.brandLabels('fm')]).toEqual(['radio fm', 'fm network']);
    expect(r.brandLabels('missing').size).toBe(0);
  });
});
