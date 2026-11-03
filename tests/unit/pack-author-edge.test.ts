import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLibrary,
  CSV_COLUMNS,
  type CsvColumn,
  diffCheck,
  exportIntake,
  formatJson,
  generatePack,
  lastCheckedDate,
  main,
  markdownTable,
  newPack,
  nextVersion,
  parseCsv,
  readIntake,
  signedUrlReason,
  sourceId,
  stationSlug,
  strictProblems,
  TEMPLATE_DIR,
  tableCells,
  writeCsv,
} from '../../scripts/pack-author.ts';
import { checkBundle } from '../../src/catalogue/pack-library.ts';
import { loadPack } from '../../src/catalogue/packs.ts';
import { projectRoot } from '../../src/shared/paths.ts';

type Json = Record<string, unknown>;
type Row = Partial<Record<CsvColumn, string>>;

const NOW = new Date('2027-01-15T12:00:00Z');

const dirs: string[] = [];
const savedCwd = process.cwd();
afterEach(() => {
  process.chdir(savedCwd);
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'radiobot-pack-author-edge-'));
  dirs.push(d);
  return d;
};

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Json;
const editJson = (path: string, fn: (v: Json) => void) => {
  const v = readJson(path);
  fn(v);
  writeFileSync(path, formatJson(v));
};

/** A small pack written by hand: no version, no aliases, no sources.json and no SOURCE_PROVENANCE.md. */
function writePack(
  dir: string,
  files: { pack?: Json; stations?: Json[]; sources?: Json[] | null; md?: string | null } = {},
): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'pack.json'),
    formatJson(
      files.pack ?? {
        schemaVersion: 1,
        id: 'mini',
        name: 'Mini',
        categories: [{ id: 'music', name: 'Music' }],
      },
    ),
  );
  writeFileSync(
    join(dir, 'stations.json'),
    formatJson({
      schemaVersion: 1,
      stations: files.stations ?? [{ slug: 'one', displayName: 'One', order: 1 }],
    }),
  );
  if (files.sources)
    writeFileSync(join(dir, 'sources.json'), formatJson({ schemaVersion: 1, sources: files.sources }));
  if (files.md) writeFileSync(join(dir, 'SOURCE_PROVENANCE.md'), files.md);
  return dir;
}

const writeIntake = (dir: string, rows: Row[], columns: readonly CsvColumn[] = CSV_COLUMNS) =>
  writeFileSync(
    join(dir, 'intake.csv'),
    writeCsv([[...columns], ...rows.map((r) => columns.map((c) => r[c] ?? ''))]),
  );

/** The pack's exported intake rows as objects. */
const exportedRows = (dir: string): Row[] => {
  const [header, ...rows] = parseCsv(exportIntake(dir).csv).map((r) => r.cells);
  return rows.map((cells) => Object.fromEntries(header!.map((c, i) => [c, cells[i]!])) as Row);
};

const copyTemplate = (root: string, name = 'template') => {
  const dir = join(root, name);
  cpSync(TEMPLATE_DIR(), dir, { recursive: true });
  return dir;
};

const HITS_MP3 = 'https://stream.example.org/hits.mp3';

/** Runs the CLI in this process and captures what it prints. */
function cli(args: string[]) {
  let out = '';
  let err = '';
  vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => {
    out += s;
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => {
    err += s;
    return true;
  }) as never);
  try {
    const code = main(args);
    return { code, out, err };
  } finally {
    vi.restoreAllMocks();
  }
}

describe('formatting, CSV and IDs: edge cases', () => {
  it('formats empty objects, long arrays and missing values the way Biome does', () => {
    const long = Array.from({ length: 12 }, (_, i) => `a-fairly-long-value-${i}`);
    const text = formatJson({ empty: {}, long, gone: undefined, list: [{}] });
    expect(text).toContain('"empty": {},');
    expect(text).toContain('"long": [\n    "a-fairly-long-value-0",');
    expect(text).not.toContain('gone');
    expect(text).toContain('"list": [\n    {}\n  ]');
  });

  it('counts a .0 version as the first change of the day', () => {
    expect(nextVersion('2027.01.15.0', NOW)).toBe('2027.01.15.2');
    expect(nextVersion('2027.02.01', NOW)).toBe('2027.02.01.2');
  });

  it('reads a last record without a line break, and refuses a quote inside a field', () => {
    expect(parseCsv('a,b').map((r) => r.cells)).toEqual([['a', 'b']]);
    expect(parseCsv('"x"').map((r) => r.cells)).toEqual([['x']]);
    expect(parseCsv('a,\n,\n"b\nc",d\ne,f').map((r) => r.line)).toEqual([1, 3, 5]);
    expect(() => parseCsv('a"b')).toThrow(/a quote may only start a field/);
  });

  it('falls back to "station" for a name with no letters, and numbers repeated IDs', () => {
    expect(stationSlug('!!!', new Set())).toBe('station');
    expect(stationSlug('Example', new Set(['example', 'example-2']))).toBe('example-3');
    expect(sourceId('mini', 'one', { transport: 'hls' }, new Set())).toBe('mini-one-hls');
  });

  it('pads short Markdown rows and escapes pipes', () => {
    expect(markdownTable(['a', 'b'], [['x|y']])).toBe('| a    | b   |\n| ---- | --- |\n| x\\|y |     |');
  });

  it('escapes backslashes too, so any cell text survives a round trip', () => {
    const cells = ['ends with \\', 'a\\|b', 'pipe | here', '\\\\double'];
    const table = markdownTable(['1', '2', '3', '4'], [cells]);
    expect(table.split('\n')[2]).toContain('ends with \\\\ |');
    expect(tableCells(table.split('\n')[2]!)).toEqual(cells);
    expect(tableCells('| a |  |')).toEqual(['a', '']);
    expect(tableCells('| a | b')).toEqual(['a', 'b']);
  });
});

describe('reading intake.csv: refused inputs', () => {
  it('needs a header with known, unique columns including "station", and rows of the same width', () => {
    expect(() => readIntake('')).toThrow(/intake\.csv is empty/);
    expect(() => readIntake('station,station\n')).toThrow(/"station" appears twice/);
    expect(() => readIntake('url\n')).toThrow(/required column "station" is missing/);
    expect(() => readIntake('station,url\nOne\nTwo,https://x,extra\n')).toThrow(
      /line 2: has 1 fields but the header has 2[\s\S]*line 3: has 3 fields/,
    );
  });

  it('reports every bad value in the rows at once', () => {
    const dir = writePack(join(tempDir(), 'mini'));
    writeIntake(dir, [
      { slug: 'nameless' },
      { station: 'A', slug: 'Bad Slug' },
      { station: 'B', order: 'first' },
      { station: 'C', country: 'GBR', catalogue_status: 'gone' },
      {
        station: 'D',
        url: 'ftp://x',
        transport: 'rtmp',
        provenance: 'found',
        enabled: 'maybe',
        priority: 'x',
      },
      { station: 'E', url: 'https://x', found_on: '2027-02-30' },
      { station: 'F', label: 'Lonely label' },
      { station: 'G', url: 'https://y', provenance: 'curated', found_on: 'soon' },
    ]);
    const message = (() => {
      try {
        generatePack(dir, { now: NOW });
      } catch (err) {
        return (err as Error).message;
      }
      return '';
    })();
    for (const expected of [
      'line 2: "station" (the display name) is empty',
      'line 3: slug "Bad Slug" may only use',
      'line 4: order must be a whole number',
      'line 5: country must be a two-letter code',
      'line 5: catalogue_status must be',
      'line 6: priority must be a whole number',
      'line 6: transport must be',
      'line 6: provenance must be',
      'line 6: enabled must be true or false',
      'line 6: url must start with https://',
      'line 7: found_on must be a date',
      'line 7: a row with a url needs provenance',
      'line 8: label given without a url',
      'line 9: found_on must be a date',
    ])
      expect(message).toContain(expected);
  });
});

describe('reading a pack folder: refused inputs', () => {
  it('explains a missing or broken file', () => {
    const base = tempDir();
    expect(() => exportIntake(join(base, 'nothing'))).toThrow(/pack\.json could not be read/);
    const dir = writePack(join(base, 'p'));
    writeFileSync(join(dir, 'pack.json'), '{ nope');
    expect(() => exportIntake(dir)).toThrow(/pack\.json is not valid JSON/);
    writeFileSync(join(dir, 'pack.json'), '{"schemaVersion":1}');
    expect(() => exportIntake(dir)).toThrow(/pack\.json has no "id"/);
    writePack(dir);
    writeFileSync(join(dir, 'stations.json'), '{"stations":[1]}');
    expect(() => exportIntake(dir)).toThrow(/stations\.json must hold a "stations" list/);
    writePack(dir);
    writeFileSync(join(dir, 'sources.json'), '{"sources":{}}');
    expect(() => exportIntake(dir)).toThrow(/sources\.json must hold a "sources" list/);
    rmSync(join(dir, 'sources.json'));
    expect(() => generatePack(dir)).toThrow(/intake\.csv does not exist\. Run "export" first/);
  });

  it('exports a pack without sources.json, one row per station, writing odd values as JSON', () => {
    const dir = writePack(join(tempDir(), 'mini'), {
      stations: [{ slug: 'one', displayName: 'One', order: 1, externalId: { odd: 1 } }],
    });
    const e = exportIntake(dir);
    expect(e.rows).toBe(1);
    expect(exportedRows(dir)[0]).toMatchObject({
      station: 'One',
      slug: 'one',
      external_id: '{"odd":1}',
      url: '',
    });
  });
});

describe('generate: more cases', () => {
  it('builds a hand-written pack up: new stations by slug and by name, a version, sources.json and the provenance file', () => {
    const dir = writePack(join(tempDir(), 'mini'));
    writeIntake(dir, [
      {
        station: 'one',
        aliases: 'Uno|uno|One',
        category: 'music',
        tags: 'a|b',
        order: '5',
        external_id: 'ext-1',
        official_page: 'https://www.example.org/one',
        country: 'gb',
        region: 'Example County',
        catalogue_status: 'missing_from_official',
      },
      {
        station: 'Two Radio',
        slug: 'two',
        url: 'https://stream.example.org/two',
        transport: 'hls',
        priority: '7',
        provenance: 'curated',
        found_at: 'https://www.example.org/two',
        found_on: '2027-01-14',
        enabled: 'false',
        disabled_reason: 'Down when checked.',
      },
      { station: 'Two Radio', slug: 'two', catalogue_status: 'retired', order: '50' },
      { station: 'Three' },
      {
        station: 'three',
        url: 'https://stream.example.org/three',
        provenance: 'official-player',
        provenance_detail: 'Reviewed by hand.',
        enabled: 'false',
      },
    ]);
    const r = generatePack(dir, { now: NOW });
    expect(r.changed).toBe(true);
    expect(r.version).toBe('2027.01.15');
    expect(r.addedStations).toEqual(['two', 'three']);
    expect(r.addedSources).toEqual(['mini-two-hls', 'mini-three-1']);
    expect(r.updatedStations).toBe(1);
    expect(r.renamedStations).toEqual([]); // "One" → "one" is only a change of case
    expect(r.warnings).toEqual(['Source "mini-three-1" is disabled without a disabled_reason.']);

    const pack = readJson(join(dir, 'pack.json'));
    expect(Object.keys(pack).slice(0, 4)).toEqual(['schemaVersion', 'id', 'name', 'version']);
    const loaded = loadPack(dir);
    expect(loaded.stations.map((s) => [s.slug, s.displayName, s.order, s.catalogueStatus])).toEqual([
      ['one', 'one', 5, 'missing_from_official'],
      ['two', 'Two Radio', 50, 'retired'],
      ['three', 'Three', 51, 'active'],
    ]);
    expect(loaded.stations[0]).toMatchObject({
      aliases: ['Uno'],
      category: 'music',
      tags: ['a', 'b'],
      externalId: 'ext-1',
      officialPage: 'https://www.example.org/one',
      country: 'GB',
      region: 'Example County',
    });
    expect(loaded.sources.find((s) => s.id === 'mini-two-hls')).toMatchObject({
      priority: 7,
      transportHint: 'hls',
      enabled: false,
      disabledReason: 'Down when checked.',
      provenanceDetail: 'Linked from https://www.example.org/two on 2027-01-14.',
    });
    const md = readFileSync(join(dir, 'SOURCE_PROVENANCE.md'), 'utf8');
    expect(
      md.startsWith('# Source provenance: Mini (`mini`)\n\n## Sources\n\n<!-- sources:start -->\n'),
    ).toBe(true);
    expect(md).toMatch(/`mini-three-1` +\| Three +\| — +\| — +\| official-player/);
    expect(md).toMatch(/`mini-two-hls` +\| Two Radio +\| https:\/\/www\.example\.org\/two \| 2027-01-14/);
  });

  it('leaves sources.json alone when a pack has none, and refuses a pack with no stations at all', () => {
    const dir = writePack(join(tempDir(), 'mini'));
    writeIntake(dir, [{ station: 'One', slug: 'one', tags: 'x' }]);
    const r = generatePack(dir, { now: NOW });
    expect(r.written.map((p) => p.split(/[\\/]/).pop()).sort()).toEqual([
      'SOURCE_PROVENANCE.md',
      'pack.json',
      'stations.json',
    ]);
    expect(existsSync(join(dir, 'sources.json'))).toBe(false);

    const empty = writePack(join(tempDir(), 'empty'), { stations: [] });
    writeIntake(empty, []);
    expect(() => generatePack(empty, { now: NOW })).toThrow(/has no stations yet/);
  });

  it('refuses a result without a name, and writes nothing', () => {
    const dir = writePack(join(tempDir(), 'mini'), { pack: { schemaVersion: 1, id: 'mini' } });
    writeIntake(dir, [{ station: 'One', slug: 'one', tags: 'x' }]);
    expect(() => generatePack(dir, { now: NOW })).toThrow(/nothing was written[\s\S]*name/);
    expect(readJson(join(dir, 'pack.json'))).toEqual({ schemaVersion: 1, id: 'mini' });
  });

  it('matches an alias without renaming, and updates or clears source fields', () => {
    const dir = copyTemplate(tempDir());
    const rows = exportedRows(dir).filter((r) => r.url !== HITS_MP3);
    for (const r of rows) {
      // Point to the station by an alias only, with no slug.
      if (r.slug === 'example-hits') Object.assign(r, { slug: '', station: 'Example Radio Hits' });
      if (r.url?.endsWith('hits/playlist.m3u8'))
        Object.assign(r, {
          label: 'Adaptive',
          priority: '15',
          transport: 'http-continuous',
          codec: 'mp3',
          provenance: 'curated',
          provenance_detail: 'Reviewed again on 2027-01-14.',
          found_at: 'https://www.example.org/again',
          found_on: '2027-01-14',
        });
      if (r.url?.endsWith('news-low.mp3')) Object.assign(r, { enabled: 'true', disabled_reason: '' });
      if (r.url?.endsWith('county.mp3'))
        Object.assign(r, { enabled: 'false', disabled_reason: 'Gone quiet.' });
      if (r.slug === 'example-news')
        Object.assign(r, {
          external_id: 'n2',
          category: 'music',
          order: '9',
          official_page: 'https://www.example.org/n2',
          country: 'FR',
          region: 'Example Region',
          catalogue_status: 'retired',
        });
    }
    // An alias, with no slug and no other station columns.
    rows.push({ station: 'Example Radio Hits', url: HITS_MP3, provenance: 'official-player' });
    writeIntake(dir, rows);
    const r = generatePack(dir, { now: NOW });
    expect(r.updatedSources).toBe(3);
    expect(r.updatedStations).toBe(1);
    const pack = loadPack(dir);
    expect(pack.stations.find((s) => s.slug === 'example-hits')!.displayName).toBe('Example Hits');
    expect(pack.stations.find((s) => s.slug === 'example-news')).toMatchObject({
      externalId: 'n2',
      category: 'music',
      order: 9,
      officialPage: 'https://www.example.org/n2',
      country: 'FR',
      region: 'Example Region',
      catalogueStatus: 'retired',
    });
    const byId = new Map(pack.sources.map((s) => [s.id, s]));
    expect(byId.get('template-example-hits-hls')).toMatchObject({
      label: 'Adaptive',
      priority: 15,
      transportHint: 'http-continuous',
      codecHint: 'mp3',
      provenance: 'curated',
      provenanceDetail: 'Reviewed again on 2027-01-14.',
    });
    expect(byId.get('template-example-news-mp3-low')).toMatchObject({ enabled: true, disabledReason: null });
    expect(byId.get('template-example-county-sound-mp3')).toMatchObject({
      enabled: false,
      disabledReason: 'Gone quiet.',
    });
    expect(readFileSync(join(dir, 'SOURCE_PROVENANCE.md'), 'utf8')).toMatch(
      /`template-example-hits-hls` +\| Example Hits +\| https:\/\/www\.example\.org\/again +\| 2027-01-14 \| curated +\|/,
    );
  });

  it('refuses a URL of another station, a new source without provenance details, and disagreeing rows', () => {
    const dir = copyTemplate(tempDir());
    const rows = exportedRows(dir);
    const moved = rows.filter((r) => r.url !== HITS_MP3);
    moved.push({
      station: 'Example News',
      slug: 'example-news',
      url: HITS_MP3,
      provenance: 'curated',
      provenance_detail: 'x',
    });
    writeIntake(dir, moved);
    expect(() => generatePack(dir, { now: NOW })).toThrow(/already belongs to station "example-hits"/);

    writeIntake(dir, [
      ...rows,
      { station: 'New', url: 'https://stream.example.org/new', provenance: 'curated' },
    ]);
    expect(() => generatePack(dir, { now: NOW })).toThrow(
      /needs provenance_detail, or both found_at and found_on/,
    );

    writeIntake(dir, [...rows, { station: 'Example Hits', slug: 'example-hits', tags: 'other' }]);
    expect(() => generatePack(dir, { now: NOW })).toThrow(/different tags for the same station/);

    writeIntake(dir, [...rows, { station: 'Example Hits Two', slug: 'example-hits' }]);
    expect(() => generatePack(dir, { now: NOW })).toThrow(/one station has different names/);
  });

  it('adds the table markers when they are missing, and reads short table rows', () => {
    const dir = copyTemplate(tempDir());
    const md = join(dir, 'SOURCE_PROVENANCE.md');
    writeFileSync(md, '# Notes\n\nSee `template-example-hits-mp3`.\n');
    writeIntake(dir, exportedRows(dir));
    generatePack(dir, { now: NOW });
    const text = readFileSync(md, 'utf8');
    expect(text).toMatch(
      /^# Notes\n\nSee `template-example-hits-mp3`\.\n\n## Sources\n\n<!-- sources:start -->\n\| Source ID/,
    );

    writeFileSync(
      md,
      '<!-- sources:start -->\n| `template-example-hits-mp3` | Example Hits |\n|  |\n<!-- sources:end -->\n',
    );
    generatePack(dir, { now: NOW });
    expect(readFileSync(md, 'utf8')).toMatch(
      /`template-example-hits-mp3` +\| Example Hits +\| https:\/\/www\.example\.org\/hits\/listen \| 2026-11-03/,
    );
  });
});

describe('new: more cases', () => {
  it('uses catalog/packs under the current folder by default, and checks an ids file given by name', () => {
    const base = tempDir();
    process.chdir(base);
    const r = newPack('here', { now: NOW });
    expect(realpathSync(r.dir)).toBe(realpathSync(join(base, 'catalog', 'packs', 'here')));
    expect(r.idsFile).toBeNull();

    const ids = join(base, 'ids.json');
    writeFileSync(ids, JSON.stringify({ schemaVersion: 1, list: [] }));
    expect(() => newPack('other', { idsFile: ids })).toThrow(/must hold an "ids" list/);
    writeFileSync(ids, JSON.stringify({ schemaVersion: 1, ids: ['taken'] }));
    const named = newPack('other', { idsFile: ids });
    expect(named.idsFile).toBe(ids);
    expect(named.nextSteps[0]).toContain(`Add "other" to ${ids}`);
  });
});

describe('strict checks: more cases', () => {
  it('does not call an unreadable URL signed (the pack loader rejects it anyway)', () => {
    expect(signedUrlReason('not a url')).toBeNull();
  });

  it('needs SOURCE_PROVENANCE.md, and source IDs that start with the pack ID or the station slug', () => {
    const dir = copyTemplate(tempDir());
    editJson(join(dir, 'sources.json'), (s) => {
      const list = s.sources as Json[];
      list[0]!.id = 'elsewhere-mp3';
      list[1]!.id = 'example-hits-extra';
    });
    rmSync(join(dir, 'SOURCE_PROVENANCE.md'));
    const problems = strictProblems(loadPack(dir));
    expect(problems).toContain('Pack "template": SOURCE_PROVENANCE.md is missing.');
    expect(problems).toContain(
      'Pack "template": source ID "elsewhere-mp3" must start with "template-" or "example-hits-".',
    );
    expect(problems.join('\n')).not.toContain('"example-hits-extra" must start');
  });
});

describe('build-library: refused inputs and fallbacks', () => {
  it('reports every problem with the pack folders and the withdrawn list', () => {
    const base = tempDir();
    const packs = join(base, 'packs');
    copyTemplate(packs);
    copyTemplate(packs, 'misnamed'); // also clashes with "template"
    copyTemplate(packs, '_ignored');
    mkdirSync(join(packs, '.hidden'));
    mkdirSync(join(packs, 'empty'));
    writeFileSync(join(packs, 'notes.txt'), 'not a pack');
    const broken = writePack(join(packs, 'broken'));
    writeFileSync(join(broken, 'pack.json'), '{"schemaVersion":1,"id":"Broken"}');
    writePack(join(packs, 'mini'));
    const withdrawn = join(base, 'gone.json');
    const gone = { id: 'gone', reason: 'Asked to.', date: '2026-12-01', name: 'Gone' };
    writeFileSync(
      withdrawn,
      JSON.stringify({
        schemaVersion: 1,
        packs: [gone, gone, { id: 'template', reason: 'x', date: '2026-12-01', name: 'T' }],
      }),
    );
    let message = '';
    try {
      buildLibrary({ packsRoot: packs, outDir: join(base, 'out'), baseUrl: './', withdrawnFile: withdrawn });
    } catch (err) {
      message = (err as Error).message;
    }
    for (const expected of [
      `${join(packs, 'empty')} has no pack.json.`,
      'pack.json is invalid',
      `${join(packs, 'misnamed')}: the folder must be named after the pack ID ("template").`,
      'Two packs use the id "template"',
      `${join(packs, 'mini')}: pack.json needs a "version".`,
      `"gone" is in ${withdrawn} twice.`,
      `"template" is in ${withdrawn} but its pack folder is still there.`,
    ])
      expect(message).toContain(expected);
    expect(message).not.toMatch(/_ignored|\.hidden|notes\.txt/);
    expect(existsSync(join(base, 'out'))).toBe(false);
  });

  it('refuses a missing packs folder and a broken withdrawn list', () => {
    const base = tempDir();
    expect(() => buildLibrary({ packsRoot: join(base, 'none'), outDir: base, baseUrl: './' })).toThrow(
      /does not exist/,
    );
    const packs = join(base, 'packs');
    copyTemplate(packs);
    writeFileSync(join(base, 'withdrawn.json'), '[]');
    expect(() => buildLibrary({ packsRoot: packs, outDir: join(base, 'out'), baseUrl: './' })).toThrow(
      /withdrawn\.json is not valid: \(root\)/,
    );
  });

  it('reports bad, clashing and reserved collections, and a missing collections folder', () => {
    const base = tempDir();
    const packs = join(base, 'packs');
    copyTemplate(packs);
    const out = join(base, 'out');
    expect(() =>
      buildLibrary({ packsRoot: packs, outDir: out, baseUrl: './', collectionsDir: join(base, 'none') }),
    ).toThrow(/none does not exist/);
    const cdir = join(base, 'collections');
    mkdirSync(cdir);
    writeFileSync(join(cdir, 'a.json'), JSON.stringify({ id: 'Bad Id', name: 'x', packs: [] }));
    writeFileSync(join(cdir, 'b.json'), JSON.stringify({ id: 'dup', name: 'One', packs: ['template'] }));
    writeFileSync(join(cdir, 'c.json'), JSON.stringify({ id: 'dup', name: 'Two', packs: [] }));
    writeFileSync(join(cdir, 'd.json'), JSON.stringify({ id: 'country-gb', name: 'Mine', packs: [] }));
    writeFileSync(join(cdir, 'notes.txt'), 'ignored');
    let message = '';
    try {
      buildLibrary({ packsRoot: packs, outDir: out, baseUrl: './', collectionsDir: cdir });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain(`${join(cdir, 'a.json')} is not valid: id:`);
    expect(message).toContain('Two collections use the ID "dup".');
    expect(message).toContain('The collection ID "country-gb" is reserved');
  });

  it('bundles a pack without sources.json, and falls back to snapshotDate or nothing for lastChecked', () => {
    const base = tempDir();
    const packs = join(base, 'packs');
    writePack(join(packs, 'mini'), {
      pack: { schemaVersion: 1, id: 'mini', name: 'Mini', version: '2027.01.15' },
    });
    const dated = copyTemplate(packs);
    rmSync(join(dated, 'evidence'), { recursive: true });
    mkdirSync(join(dated, 'evidence'));
    writeFileSync(join(dated, 'evidence', 'notes.json'), '{}');
    expect(lastCheckedDate(dated)).toBeNull();
    expect(lastCheckedDate(join(packs, 'mini'))).toBeNull();
    writeFileSync(
      join(base, 'withdrawn.json'),
      JSON.stringify({
        schemaVersion: 1,
        packs: [
          {
            id: 'gone',
            reason: 'Asked to.',
            date: '2026-12-01',
            name: 'Gone',
            description: 'Old pack.',
            version: '2026.11.30',
            owner: { name: 'Example Group', kind: 'group' },
            countries: ['FR'],
            regions: ['North'],
            languages: ['fr'],
            stations: 4,
            sources: 6,
            minBotVersion: '1.0.0',
          },
        ],
      }),
    );
    const out = join(base, 'out');
    const { index, files } = buildLibrary({
      packsRoot: packs,
      outDir: out,
      baseUrl: 'https://example.org/lib/',
    });
    expect(files.map((f) => f.split(/[\\/]/).pop())).toEqual(['mini.json', 'template.json', 'index.json']);
    const mini = index.packs.find((p) => p.id === 'mini')!;
    expect(mini).toMatchObject({ lastChecked: null, sources: 0, file: 'https://example.org/lib/mini.json' });
    expect(
      checkBundle(readFileSync(join(out, 'mini.json')), { id: 'mini', sha256: mini.sha256 }).files[
        'sources.json'
      ],
    ).toBeNull();
    expect(index.packs.find((p) => p.id === 'template')!.lastChecked).toBe('2026-11-03'); // the snapshot date
    expect(index.packs.find((p) => p.id === 'gone')).toMatchObject({
      version: '2026.11.30',
      owner: { name: 'Example Group', kind: 'group', brand: null },
      countries: ['FR'],
      stations: 4,
      sources: 6,
      minBotVersion: '1.0.0',
      description: 'Old pack.',
    });
    // Countries of withdrawn packs get no collection.
    expect(index.collections.map((c) => c.id)).toEqual(['country-gb']);
  });
});

describe('diff-check: more cases', () => {
  it('refuses a deleted or broken new pack, and a broken old one', () => {
    const base = tempDir();
    const old = copyTemplate(join(base, 'old'));
    expect(diffCheck(old, join(base, 'gone')).problems[0]).toMatch(
      /has no pack\.json\. Packs are never deleted/,
    );
    const broken = copyTemplate(join(base, 'broken'));
    writeFileSync(join(broken, 'stations.json'), '{}');
    expect(diffCheck(old, broken).problems[0]).toMatch(/stations\.json is invalid/);
    const next = copyTemplate(join(base, 'new'));
    expect(diffCheck(broken, next).problems[0]).toMatch(/^The old pack could not be read/);
  });

  it('needs a version on a new pack, spots a changed ID and accepts a first version', () => {
    const base = tempDir();
    const next = copyTemplate(join(base, 'new'));
    editJson(join(next, 'pack.json'), (p) => {
      p.version = null;
    });
    expect(diffCheck(join(base, 'none'), next)).toEqual({
      problems: ['Pack "template": pack.json needs a "version".'],
      notes: ['"template" is a new pack.'],
    });

    const old = copyTemplate(join(base, 'old'));
    // Changed, but with no version at all: only the missing version is reported.
    expect(diffCheck(old, next).problems).toEqual(['Pack "template": pack.json needs a "version".']);

    editJson(join(next, 'pack.json'), (p) => {
      p.id = 'renamed';
      p.version = '2027.01.15';
    });
    expect(diffCheck(old, next).problems).toContain(
      'The pack ID changed from "template" to "renamed". Pack IDs are permanent.',
    );

    editJson(join(next, 'pack.json'), (p) => {
      p.id = 'template';
    });
    editJson(join(old, 'pack.json'), (p) => {
      p.version = null;
    });
    expect(diffCheck(old, next)).toEqual({
      problems: [],
      notes: ['Pack "template" changed: version none → 2027.01.15.'],
    });
  });
});

describe('the command line', () => {
  it('prints the usage for no command, an unknown command, a wrong count or an unknown option', () => {
    expect(cli([])).toMatchObject({ code: 1, err: expect.stringMatching(/^Usage:/) });
    expect(cli(['bogus']).code).toBe(1);
    expect(cli(['new']).err).toMatch(/^Usage:/);
    expect(cli(['new', 'x', '--bogus', '1']).err).toMatch(/^Unknown option --bogus\./);
    expect(cli(['new', 'x', '--root']).err).toMatch(/--root needs a value/);
    expect(cli(['new', 'x', '--root', '--ids']).err).toMatch(/--root needs a value/);
  });

  it('runs new, export, generate, build-library and diff-check', () => {
    const base = tempDir();
    const packs = join(base, 'packs');
    writeFileSync(join(base, 'pack-ids.json'), JSON.stringify({ schemaVersion: 1, ids: [] }));
    const created = cli(['new', 'clipack', '--root', packs, '--ids', join(base, 'pack-ids.json')]);
    expect(created.code).toBe(0);
    expect(created.out).toMatch(/Created the pack folder[\s\S]*Next steps:\n {2}1\. Add "clipack" to/);

    const dir = copyTemplate(packs);
    const exported = cli(['export', dir]);
    expect(exported).toMatchObject({ code: 0, out: expect.stringMatching(/Wrote .*intake\.csv: 5 rows\./) });
    expect(cli(['generate', dir]).out).toMatch(/The stations and sources are unchanged\./);

    const rows = exportedRows(dir)
      .filter((r) => !r.url?.endsWith('county.mp3'))
      .map((r) => (r.slug === 'example-hits' ? { ...r, station: 'Example Hits Plus' } : r));
    rows.push({
      station: 'Example Jazz',
      url: 'https://stream.example.org/jazz.mp3',
      provenance: 'curated',
      provenance_detail: 'Reviewed on 2027-01-14.',
    });
    writeIntake(dir, rows);
    const generated = cli(['generate', dir]);
    expect(generated.code).toBe(0);
    expect(generated.out).toMatch(
      /Warning: Source "template-example-county-sound-mp3" is not in intake\.csv/,
    );
    expect(generated.out).toMatch(/New stations: example-jazz/);
    expect(generated.out).toMatch(/New sources: template-example-jazz-1/);
    expect(generated.out).toMatch(
      /Renamed \(old name kept as an alias\): example-hits: "Example Hits" → "Example Hits Plus"/,
    );
    expect(generated.out).toMatch(/Updated 1 stations and 0 sources\./);
    expect(generated.out).toMatch(/The pack changed; its version is now \d{4}\.\d{2}\.\d{2}/);
    expect(generated.out).toMatch(/Wrote .*stations\.json/);

    rmSync(join(packs, 'clipack'), { recursive: true }); // not filled in, so not valid yet
    const out = join(base, 'out');
    expect(cli(['build-library', packs, out]).err).toMatch(/--base-url is required/);
    const built = cli(['build-library', packs, out, '--base-url', 'https://example.org/lib']);
    expect(built).toMatchObject({
      code: 0,
      out: expect.stringMatching(/1 packs, 0 withdrawn, 1 collections\./),
    });

    const old = copyTemplate(join(base, 'old'));
    expect(cli(['diff-check', old, old])).toMatchObject({ code: 0, out: 'Pack "template" is unchanged.\n' });
    // Going back to the old files would remove the new station and lower the version.
    const failed = cli(['diff-check', dir, old]);
    expect(failed.code).toBe(1);
    expect(failed.err).toMatch(/Station "example-jazz" was removed[\s\S]*version did not go up/);
  });

  it('reports a failure with exit code 1', () => {
    const r = cli(['export', join(tempDir(), 'missing')]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/pack\.json could not be read/);
  });

  it('runs main() when started as a script, not when imported', async () => {
    const savedArgv = process.argv;
    const savedExit = process.exitCode;
    let err = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => {
      err += s;
      return true;
    }) as never);
    try {
      vi.resetModules();
      process.argv = [process.execPath, join(projectRoot(), 'scripts', 'pack-author.ts'), 'bogus'];
      await import('../../scripts/pack-author.ts');
      expect(process.exitCode).toBe(1);
      expect(err).toMatch(/^Usage:/);
    } finally {
      process.argv = savedArgv;
      process.exitCode = savedExit;
      vi.restoreAllMocks();
    }
  });
});

describe('validate-catalogue --strict', () => {
  class ExitCalled extends Error {
    readonly code: number;
    constructor(code: number) {
      super(`exit ${code}`);
      this.code = code;
    }
  }

  async function validate(args: string[]) {
    vi.resetModules();
    const savedArgv = process.argv;
    process.argv = [process.execPath, 'validate-catalogue.ts', ...args];
    let out = '';
    let err = '';
    vi.spyOn(process.stdout, 'write').mockImplementation(((s: string) => {
      out += s;
      return true;
    }) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((s: string) => {
      err += s;
      return true;
    }) as never);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new ExitCalled(code ?? 0);
    }) as never);
    let code: number | null = null;
    try {
      await import('../../scripts/validate-catalogue.ts');
    } catch (e) {
      if (e instanceof ExitCalled) code = e.code;
      else throw e;
    } finally {
      vi.restoreAllMocks();
      process.argv = savedArgv;
    }
    return { code, out, err };
  }

  it('passes the template and fails a pack that breaks the rules', async () => {
    const ok = await validate(['--pack', TEMPLATE_DIR(), '--strict']);
    expect(ok).toMatchObject({ code: 0, out: expect.stringMatching(/Strict checks passed\./) });

    const dir = copyTemplate(tempDir());
    editJson(join(dir, 'pack.json'), (p) => {
      p.languages = [];
    });
    const bad = await validate(['--pack', dir, '--strict']);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/needs at least one language[\s\S]*Strict checks failed: 1 problem\./);
  });
});
