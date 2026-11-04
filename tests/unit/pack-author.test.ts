import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AuthorError,
  buildLibrary,
  CSV_COLUMNS,
  diffCheck,
  exportIntake,
  formatJson,
  generatePack,
  newPack,
  nextVersion,
  parseCsv,
  publishedVersion,
  signedUrlReason,
  sourceId,
  stationSlug,
  strictProblems,
  strictWarnings,
  TEMPLATE_DIR,
  writeCsv,
} from '../../scripts/pack-author.ts';
import { checkBundle, libraryIndexSchema } from '../../src/catalogue/pack-library.ts';
import { loadPack } from '../../src/catalogue/packs.ts';
import { projectRoot } from '../../src/shared/paths.ts';
import { compareVersions } from '../../src/shared/version.ts';

type Json = Record<string, unknown>;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'radiobot-pack-author-'));
  dirs.push(d);
  return d;
};

/** Runs a script from source with a clean environment. */
function run(script: string, args: string[]) {
  const r = spawnSync(process.execPath, [join(projectRoot(), 'scripts', script), ...args], {
    cwd: projectRoot(),
    env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '' },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Json;
const editJson = (path: string, fn: (v: Json) => void) => {
  const v = readJson(path);
  fn(v);
  writeFileSync(path, formatJson(v));
};

/** A copy of the template pack as `<root>/<id>`, with its pack and source IDs renamed. */
function copyTemplate(root: string, id = 'template', countries = ['GB']): string {
  const dir = join(root, id);
  cpSync(TEMPLATE_DIR(), dir, { recursive: true });
  if (id !== 'template') {
    editJson(join(dir, 'pack.json'), (p) => {
      p.id = id;
      p.name = `Pack ${id}`;
      p.countries = countries;
    });
    editJson(join(dir, 'sources.json'), (s) => {
      for (const src of s.sources as Json[]) src.id = String(src.id).replace(/^template-/, `${id}-`);
    });
    const md = join(dir, 'SOURCE_PROVENANCE.md');
    writeFileSync(md, readFileSync(md, 'utf8').replace(/template-/g, `${id}-`));
  }
  return dir;
}

const snapshot = (dir: string) =>
  ['pack.json', 'stations.json', 'sources.json', 'SOURCE_PROVENANCE.md'].map((f) =>
    readFileSync(join(dir, f), 'utf8'),
  );

const csvRow = (values: Partial<Record<(typeof CSV_COLUMNS)[number], string>>) =>
  writeCsv([CSV_COLUMNS.map((c) => values[c] ?? '')]);

const NOW = new Date('2027-01-15T12:00:00Z');

describe('CSV', () => {
  it('reads quotes, embedded commas, quotes and line breaks, CRLF and a byte-order mark', () => {
    const text = '﻿a,b,c\r\n"x, y","say ""hi""","two\r\nlines"\r\n\r\nplain,,end\n';
    expect(parseCsv(text).map((r) => r.cells)).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'say "hi"', 'two\nlines'],
      ['plain', '', 'end'],
    ]);
    expect(parseCsv(text).map((r) => r.line)).toEqual([1, 2, 5]);
  });

  it('round-trips what it writes', () => {
    const rows = [
      ['a', 'b,c', 'd"e'],
      ['multi\nline', ' padded ', ''],
    ];
    expect(parseCsv(writeCsv(rows)).map((r) => r.cells)).toEqual(rows);
  });

  it('refuses broken quoting', () => {
    expect(() => parseCsv('a\n"open')).toThrow(/never closed/);
    expect(() => parseCsv('a\n"x"y')).toThrow(/after a closing quote/);
  });
});

describe('IDs and versions', () => {
  it('makes slugs and source IDs that are unique and the right shape', () => {
    expect(stationSlug('Example Ünïque Radio!', new Set())).toBe('example-unique-radio');
    expect(stationSlug('Example', new Set(['example']))).toBe('example-2');
    expect(stationSlug('A'.repeat(50), new Set()).length).toBeLessThanOrEqual(32);
    expect(sourceId('mypack', 'my-station', { label: 'Direct MP3' }, new Set())).toBe(
      'mypack-my-station-direct-mp3',
    );
    expect(sourceId('mypack', 'mypack-one', { codec: 'aac' }, new Set())).toBe('mypack-one-aac');
    expect(sourceId('mypack', 'one', {}, new Set(['mypack-one-1']))).toBe('mypack-one-2');
    expect(sourceId('mypack', 'one', { codec: 'mp3' }, new Set(['mypack-one-mp3']))).toBe('mypack-one-mp3-2');
  });

  it('versions by date, adding .2, .3 … on the same day', () => {
    expect(nextVersion(null, NOW)).toBe('2027.01.15');
    expect(nextVersion('2026.11.03', NOW)).toBe('2027.01.15');
    expect(nextVersion('2027.01.15', NOW)).toBe('2027.01.15.2');
    expect(nextVersion('2027.01.15.2', NOW)).toBe('2027.01.15.3');
  });
});

describe('new', () => {
  it('starts a pack from the template', () => {
    const root = join(tempDir(), 'packs');
    const r = newPack('mypack', { root, now: NOW });
    expect(r.dir).toBe(join(root, 'mypack'));
    const pack = readJson(join(r.dir, 'pack.json'));
    expect(pack).toMatchObject({
      id: 'mypack',
      version: '2027.01.15',
      owner: null,
      countries: [],
      categories: [],
    });
    expect(readJson(join(r.dir, 'stations.json'))).toEqual({ schemaVersion: 1, stations: [] });
    expect(readJson(join(r.dir, 'sources.json'))).toEqual({ schemaVersion: 1, sources: [] });
    expect(readFileSync(join(r.dir, 'intake.csv'), 'utf8')).toBe(`${CSV_COLUMNS.join(',')}\n`);
    expect(readFileSync(join(r.dir, 'SOURCE_PROVENANCE.md'), 'utf8')).toContain('<!-- sources:start -->');
    expect(existsSync(join(r.dir, 'README.md'))).toBe(false);
    expect(existsSync(join(r.dir, 'evidence', 'probe-2026-11-03.json'))).toBe(false);
    expect(r.nextSteps.join('\n')).toMatch(/pack-ids\.json/);
  });

  it('prints commands that run from the current folder, as a pack library next to the bot runs them', () => {
    const library = join(tempDir(), 'my library');
    mkdirSync(library);
    const saved = process.cwd();
    process.chdir(library);
    try {
      const r = newPack('mypack', { root: 'packs', now: NOW });
      const steps = r.nextSteps.join('\n');
      const scripts = relative(library, join(projectRoot(), 'scripts')).replace(/\\/g, '/');
      const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
      expect(steps).toContain(`Run: node ${q(`${scripts}/pack-author.ts`)} generate packs/mypack`);
      expect(steps).toContain(
        `Check: node ${q(`${scripts}/validate-catalogue.ts`)} --pack packs/mypack --strict`,
      );
      expect(steps).toContain('--base origin/main');
    } finally {
      process.chdir(saved);
    }
  });

  it('refuses a bad, reserved, existing or already registered ID', () => {
    const base = tempDir();
    const root = join(base, 'packs');
    expect(() => newPack('Bad Id', { root })).toThrow(AuthorError);
    expect(() => newPack('custom', { root })).toThrow(/reserved/);
    newPack('mypack', { root });
    expect(() => newPack('mypack', { root })).toThrow(/already exists/);
    writeFileSync(join(base, 'pack-ids.json'), JSON.stringify({ schemaVersion: 1, ids: ['taken'] }));
    expect(() => newPack('taken', { root })).toThrow(/already taken/);
    expect(existsSync(join(root, 'taken'))).toBe(false);
  });

  it('works from the command line, and a filled-in pack generates and validates', () => {
    const root = join(tempDir(), 'packs');
    const r = run('pack-author.ts', ['new', 'mypack', '--root', root]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Next steps:/);
    const dir = join(root, 'mypack');
    writeFileSync(
      join(dir, 'intake.csv'),
      writeCsv([[...CSV_COLUMNS]]) +
        csvRow({
          station: 'My Station',
          url: 'https://stream.example.org/my.mp3',
          codec: 'mp3',
          provenance: 'official-player',
          found_at: 'https://www.example.org/listen',
          found_on: '2027-01-14',
        }),
    );
    const created = String(readJson(join(dir, 'pack.json')).version);
    const g = generatePack(dir);
    expect(g.addedStations).toEqual(['my-station']);
    expect(g.addedSources).toEqual(['mypack-my-station-mp3']);
    expect(compareVersions(g.version!, created)).toBe(1);
    expect(loadPack(dir).stations).toHaveLength(1);
  });
});

describe('export and generate', () => {
  it('round-trips the template without changing its JSON', () => {
    const dir = copyTemplate(tempDir());
    const before = snapshot(dir);
    const e = exportIntake(dir);
    expect(e.rows).toBe(5);
    writeFileSync(join(dir, 'intake.csv'), e.csv);
    const r = generatePack(dir, { now: NOW });
    expect(r.changed).toBe(false);
    expect(r.warnings).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
  });

  it('adds stations and sources with new IDs, keeps old IDs, keeps a renamed name as an alias and bumps the version', () => {
    const dir = copyTemplate(tempDir());
    const oldSources = (readJson(join(dir, 'sources.json')).sources as Json[]).map((s) => s.id);
    const csv = exportIntake(dir).csv.replace(
      /^Example Hits,example-hits,/gm,
      'Example Hits Radio,example-hits,',
    );
    writeFileSync(
      join(dir, 'intake.csv'),
      csv +
        csvRow({
          station: 'Example Jazz',
          category: 'music',
          tags: 'jazz|smooth',
          url: 'https://stream.example.org/jazz.mp3',
          label: 'Direct MP3',
          transport: 'http-continuous',
          provenance: 'official-player',
          found_at: 'https://www.example.org/jazz/listen',
          found_on: '2027-01-14',
        }) +
        // An existing station, matched by name with no slug.
        csvRow({
          station: 'example news',
          url: 'https://stream.example.org/news-backup.aac',
          codec: 'aac',
          provenance: 'curated',
          provenance_detail: 'Listed in the stream directory on 2027-01-14.',
        }),
    );
    const r = generatePack(dir, { now: NOW });
    expect(r.changed).toBe(true);
    expect(r.version).toBe('2027.01.15');
    expect(r.addedStations).toEqual(['example-jazz']);
    expect([...r.addedSources].sort()).toEqual([
      'template-example-jazz-direct-mp3',
      'template-example-news-aac-2',
    ]);

    const pack = loadPack(dir);
    expect(pack.meta.version).toBe('2027.01.15');
    const hits = pack.stations.find((s) => s.slug === 'example-hits')!;
    expect(hits.displayName).toBe('Example Hits Radio');
    expect(hits.aliases).toContain('Example Hits');
    const news = pack.stations.find((s) => s.slug === 'example-news')!;
    expect(news.displayName).toBe('Example News');
    const jazz = pack.stations.find((s) => s.slug === 'example-jazz')!;
    expect(jazz).toMatchObject({
      displayName: 'Example Jazz',
      category: 'music',
      tags: ['jazz', 'smooth'],
      order: 4,
    });
    for (const id of oldSources) expect(pack.sources.some((s) => s.id === id)).toBe(true);
    const jazzSource = pack.sources.find((s) => s.id === 'template-example-jazz-direct-mp3')!;
    expect(jazzSource.provenanceDetail).toBe(
      'Linked from https://www.example.org/jazz/listen on 2027-01-14.',
    );
    // A new source goes after the other sources of its station.
    const ids = pack.sources.map((s) => s.id);
    expect(ids.indexOf('template-example-news-aac-2')).toBe(ids.indexOf('template-example-news-mp3-low') + 1);
    const md = readFileSync(join(dir, 'SOURCE_PROVENANCE.md'), 'utf8');
    expect(md).toMatch(
      /`template-example-jazz-direct-mp3` .*https:\/\/www\.example\.org\/jazz\/listen .*2027-01-14/,
    );
    expect(md).toContain('## Disabled sources'); // the rest of the file is untouched
    expect(strictProblems(pack)).toEqual([]);

    // A second change on the same day.
    writeFileSync(
      join(dir, 'intake.csv'),
      exportIntake(dir).csv.replace('Low-bandwidth MP3', 'Low bandwidth MP3'),
    );
    expect(generatePack(dir, { now: NOW }).version).toBe('2027.01.15.2');
    expect(loadPack(dir).meta.version).toBe('2027.01.15.2');
  });

  it('keeps stations and sources missing from the CSV, with a warning', () => {
    const dir = copyTemplate(tempDir());
    const lines = exportIntake(dir).csv.split('\n');
    writeFileSync(
      join(dir, 'intake.csv'),
      `${lines.filter((l) => !l.includes('Example County Sound')).join('\n')}`,
    );
    const r = generatePack(dir, { now: NOW });
    expect(r.changed).toBe(false);
    expect(r.warnings.join('\n')).toMatch(/Station "example-county-sound".*kept/);
    expect(r.warnings.join('\n')).toMatch(/Source "template-example-county-sound-mp3".*kept/);
    expect(loadPack(dir).stations).toHaveLength(3);
  });

  it('refuses a bad CSV and writes nothing', () => {
    const dir = copyTemplate(tempDir());
    const before = snapshot(dir);
    const good = exportIntake(dir).csv;

    writeFileSync(
      join(dir, 'intake.csv'),
      good.replace('station,', 'station,colour,').replace(/\n(?=.)/g, '\nx,'),
    );
    expect(() => generatePack(dir, { now: NOW })).toThrow(/Unknown column "colour"/);

    writeFileSync(
      join(dir, 'intake.csv'),
      good +
        csvRow({ station: 'New One', url: 'https://stream.example.org/new.mp3', found_on: '2027-13-01' }),
    );
    expect(() => generatePack(dir, { now: NOW })).toThrow(/found_on must be a date[\s\S]*needs provenance/);

    // Well-formed, but the result would break the pack's rules (an undeclared category).
    writeFileSync(
      join(dir, 'intake.csv'),
      good +
        csvRow({
          station: 'New One',
          category: 'sport',
          url: 'https://stream.example.org/new.mp3',
          provenance: 'curated',
          provenance_detail: 'Reviewed on 2027-01-14.',
        }),
    );
    expect(() => generatePack(dir, { now: NOW })).toThrow(/nothing was written[\s\S]*undeclared category/);

    // A URL that already belongs to another station.
    writeFileSync(
      join(dir, 'intake.csv'),
      `${good}${csvRow({ station: 'Other', url: 'https://stream.example.org/hits.mp3', provenance: 'curated', provenance_detail: 'x' })}`,
    );
    expect(() => generatePack(dir, { now: NOW })).toThrow(/already/);

    expect(snapshot(dir)).toEqual(before);
  });
});

describe('build-library', () => {
  it('writes bundles and an index that the bot accepts, with country collections and withdrawn packs', () => {
    const base = tempDir();
    const packs = join(base, 'packs');
    copyTemplate(packs);
    copyTemplate(packs, 'second', ['FR', 'GB']);
    writeFileSync(
      join(base, 'withdrawn.json'),
      JSON.stringify({
        schemaVersion: 1,
        packs: [
          { id: 'gone', reason: 'Withdrawn at its owner’s request.', date: '2026-12-01', name: 'Gone Radio' },
        ],
      }),
    );
    mkdirSync(join(base, 'collections'));
    writeFileSync(
      join(base, 'collections', 'starter.json'),
      JSON.stringify({
        id: 'starter',
        name: 'Starter',
        description: 'A few to begin with.',
        packs: ['second'],
      }),
    );
    const out = join(base, 'out');
    const r = buildLibrary({
      packsRoot: packs,
      outDir: out,
      baseUrl: 'https://example.org/library',
      collectionsDir: join(base, 'collections'),
      now: NOW,
    });

    const index = libraryIndexSchema.parse(readJson(join(out, 'index.json')));
    expect(index.generatedAt).toBe(NOW.toISOString());
    expect(index.packs.map((p) => p.id)).toEqual(['gone', 'second', 'template']);
    expect(r.index.packs).toHaveLength(3);
    for (const entry of index.packs.filter((p) => p.status === 'available')) {
      expect(entry.file).toBe(`https://example.org/library/${entry.id}.json`);
      const bytes = readFileSync(join(out, `${entry.id}.json`));
      expect(bytes.length).toBe(entry.bytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
      const checked = checkBundle(bytes, { id: entry.id, sha256: entry.sha256 });
      expect(checked.pack.meta.id).toBe(entry.id);
    }
    const template = index.packs.find((p) => p.id === 'template')!;
    expect(template).toMatchObject({
      version: '2026.11.03',
      stations: 3,
      sources: 5,
      lastChecked: '2026-11-03',
      countries: ['GB'],
      languages: ['en'],
    });
    expect(index.packs.find((p) => p.id === 'gone')).toMatchObject({
      status: 'withdrawn',
      name: 'Gone Radio',
      withdrawnReason: 'Withdrawn at its owner’s request.',
      version: '2026.12.01',
      file: null,
      sha256: null,
      bytes: null,
    });
    const gb = index.collections.find((c) => c.id === 'country-gb')!;
    expect(gb.name).toBe('United Kingdom');
    expect(gb.packs).toEqual(['second', 'template']);
    expect(index.collections.find((c) => c.id === 'country-fr')!.packs).toEqual(['second']);
    expect(index.collections.find((c) => c.id === 'starter')!.packs).toEqual(['second']);
  });

  it('refuses a pack without a version, and a collection naming an unknown pack', () => {
    const base = tempDir();
    const packs = join(base, 'packs');
    const dir = copyTemplate(packs);
    editJson(join(dir, 'pack.json'), (p) => {
      delete p.version;
    });
    const out = join(base, 'out');
    expect(() => buildLibrary({ packsRoot: packs, outDir: out, baseUrl: './' })).toThrow(/needs a "version"/);
    editJson(join(dir, 'pack.json'), (p) => {
      p.version = '2026.11.03';
    });
    mkdirSync(join(base, 'collections'));
    writeFileSync(
      join(base, 'collections', 'x.json'),
      JSON.stringify({ id: 'x', name: 'X', packs: ['nope'] }),
    );
    expect(() =>
      buildLibrary({
        packsRoot: packs,
        outDir: out,
        baseUrl: './',
        collectionsDir: join(base, 'collections'),
      }),
    ).toThrow(/"nope" is not an available pack/);
    expect(existsSync(join(out, 'index.json'))).toBe(false);
  });
});

describe('diff-check', () => {
  it('accepts a new pack, and a change with a new version', () => {
    const base = tempDir();
    const next = copyTemplate(join(base, 'new'));
    expect(diffCheck(join(base, 'old', 'template'), next).problems).toEqual([]);
    const old = copyTemplate(join(base, 'old'));
    expect(diffCheck(old, next)).toEqual({ problems: [], notes: ['Pack "template" is unchanged.'] });
    editJson(join(next, 'sources.json'), (s) => {
      (s.sources as Json[])[0]!.label = 'Changed';
    });
    editJson(join(next, 'pack.json'), (p) => {
      p.version = '2026.11.03.2';
    });
    expect(diffCheck(old, next).problems).toEqual([]);
  });

  it('catches a removed station and a change without a new version', () => {
    const base = tempDir();
    const old = copyTemplate(join(base, 'old'));
    const next = copyTemplate(join(base, 'new'));
    editJson(join(next, 'stations.json'), (s) => {
      s.stations = (s.stations as Json[]).filter((x) => x.slug !== 'example-county-sound');
    });
    editJson(join(next, 'sources.json'), (s) => {
      s.sources = (s.sources as Json[]).filter((x) => x.station !== 'example-county-sound');
    });
    const problems = diffCheck(old, next).problems.join('\n');
    expect(problems).toMatch(/Station "example-county-sound" was removed/);
    expect(problems).toMatch(/Source "template-example-county-sound-mp3" was removed/);
    expect(problems).toMatch(/version did not go up/);

    const r = run('pack-author.ts', ['diff-check', old, next]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/was removed/);
  });
});

describe('strict checks', () => {
  it('passes the template pack', () => {
    expect(strictProblems(loadPack(TEMPLATE_DIR()))).toEqual([]);
    const r = run('validate-catalogue.ts', ['--pack', TEMPLATE_DIR(), '--strict']);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Strict checks passed/);
  });

  it('spots signed or expiring URLs', () => {
    expect(signedUrlReason('https://stream.example.org/a.mp3')).toBeNull();
    expect(signedUrlReason('https://stream.example.org/a.mp3?format=hd&listener=1')).toBeNull();
    expect(signedUrlReason('https://stream.example.org/a.mp3?Token=abc')).toMatch(/Token/);
    expect(signedUrlReason('https://stream.example.org/a.mp3?X-Amz-Date=1')).toMatch(/X-Amz-Date/);
    expect(signedUrlReason(`https://stream.example.org/a.mp3?s=${'a1_-'.repeat(8)}`)).toMatch(/token/);
  });

  it('catches a tokenised URL, an image and a source missing from SOURCE_PROVENANCE.md', () => {
    const dir = copyTemplate(tempDir());
    editJson(join(dir, 'sources.json'), (s) => {
      (s.sources as Json[])[0]!.url = 'https://stream.example.org/hits.mp3?token=abc';
    });
    writeFileSync(join(dir, 'evidence', 'logo.PNG'), 'not really an image');
    const md = join(dir, 'SOURCE_PROVENANCE.md');
    writeFileSync(
      md,
      readFileSync(md, 'utf8')
        .split('\n')
        .filter((l) => !l.includes('template-example-hits-hls'))
        .join('\n'),
    );
    const problems = strictProblems(loadPack(dir)).join('\n');
    expect(problems).toMatch(/"template-example-hits-mp3" looks signed or expiring/);
    expect(problems).toMatch(/may not hold images.*logo\.PNG/);
    expect(problems).toMatch(/"template-example-hits-hls" is not mentioned/);
    expect(problems).not.toMatch(/"template-example-hits-mp3" is not mentioned/);

    const r = run('validate-catalogue.ts', ['--pack', dir, '--strict']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Strict checks failed: 3 problems/);
  });

  it('asks for a version, owner, country, language and evidence', () => {
    const dir = copyTemplate(tempDir());
    editJson(join(dir, 'pack.json'), (p) => {
      p.version = null;
      p.owner = null;
      p.countries = [];
      p.languages = [];
    });
    rmSync(join(dir, 'evidence'), { recursive: true });
    const problems = strictProblems(loadPack(dir)).join('\n');
    for (const word of ['"version"', '"owner"', 'country', 'language', 'evidence/'])
      expect(problems).toContain(word);
  });

  /** Writes evidence/<name> with one probe per [source ID, failure code or null for success]. */
  const writeReport = (dir: string, name: string, probes: Array<[string, string | null]>) =>
    writeFileSync(
      join(dir, 'evidence', name),
      JSON.stringify({
        generatedAt: '2027-01-15T12:00:00.000Z',
        probes: probes.map(([sourceId, code]) => ({
          stationId: 'template:x',
          sourceId,
          outcome: { success: code === null, failureCode: code },
        })),
        comparisons: [],
      }),
    );

  it('needs the newest probe report to show a source of the pack playing', () => {
    const dir = copyTemplate(tempDir());
    const problems = () => strictProblems(loadPack(dir)).join('\n');

    // Every probe failed: a report on its own is not enough.
    writeReport(dir, 'probe-2027-01-15.json', [
      ['template-example-hits-mp3', 'HTTP_TIMEOUT'],
      ['template-example-news-aac', 'NOT_FOUND'],
    ]);
    expect(problems()).toMatch(/no source played in evidence\/probe-2027-01-15\.json/);

    // FFmpeg could not run: the report says nothing about the streams, even with a success in it.
    writeReport(dir, 'probe-2027-01-15.json', [
      ['template-example-hits-mp3', null],
      ['template-example-news-aac', 'FFMPEG_SPAWN'],
    ]);
    expect(problems()).toMatch(/records that FFmpeg could not run/);

    // A report about another pack's sources.
    writeReport(dir, 'probe-2027-01-15.json', [['other-pack-source', null]]);
    expect(problems()).toMatch(
      /holds no probe of this pack's sources\. Run the live check with --pack-id template/,
    );

    // Not a probe report at all.
    writeFileSync(join(dir, 'evidence', 'probe-2027-01-15.json'), '{"notes": "listened, sounded fine"}');
    expect(problems()).toMatch(/evidence\/probe-2027-01-15\.json is not a probe report/);

    // The newest report counts, by the date in its name: an older bad one doesn't matter.
    writeReport(dir, 'probe-2027-01-16.json', [['template-example-hits-mp3', null]]);
    expect(strictProblems(loadPack(dir))).toEqual([]);
  });

  it('warns about an enabled source that failed the newest live check, but not a disabled one', () => {
    const dir = copyTemplate(tempDir());
    expect(strictWarnings(loadPack(TEMPLATE_DIR()))).toEqual([]);
    writeReport(dir, 'probe-2027-01-15.json', [
      ['template-example-hits-mp3', null],
      ['template-example-hits-hls', 'ACCESS_DENIED'],
      ['template-example-news-mp3-low', 'NOT_FOUND'],
    ]);
    const pack = loadPack(dir);
    expect(strictProblems(pack)).toEqual([]);
    expect(strictWarnings(pack)).toEqual([
      'Pack "template": source "template-example-hits-hls" is enabled but failed the live check in evidence/probe-2027-01-15.json (ACCESS_DENIED). The host refuses access (HTTP 401, 403 or 451): switch it off with that as the reason.',
    ]);
  });

  it('advises by how the source failed: refused, gone, or a passing fault', () => {
    const dir = copyTemplate(tempDir());
    const advice = (code: string | null, detail: string | null = null) => {
      writeFileSync(
        join(dir, 'evidence', 'probe-2027-01-15.json'),
        JSON.stringify({
          generatedAt: '2027-01-15T12:00:00.000Z',
          probes: [
            { stationId: 'template:x', sourceId: 'template-example-hits-mp3', outcome: { success: true } },
            {
              stationId: 'template:x',
              sourceId: 'template-example-hits-hls',
              outcome: { success: false, failureCode: code, failureDetail: detail },
            },
          ],
          comparisons: [],
        }),
      );
      const pack = loadPack(dir);
      // Advice only: strict still passes.
      expect(strictProblems(pack)).toEqual([]);
      const warnings = strictWarnings(pack);
      expect(warnings).toHaveLength(1);
      return warnings[0]!;
    };
    expect(advice('ACCESS_DENIED')).toMatch(/refuses access .*: switch it off with that as the reason\.$/);
    const gone =
      /leave it on for now, and switch it off only if it is still gone in a check at least 7 days later\.$/;
    expect(advice('NOT_FOUND', 'Nothing is at that address any more (HTTP 410).')).toMatch(gone);
    const temporary = /usually temporary .*: leave it on and check it again another day\./;
    for (const code of ['HTTP_TIMEOUT', 'PROBE_TIMEOUT', 'HTTP_ERROR', 'DNS_FAILED'])
      expect(advice(code)).toMatch(temporary);
    expect(advice('HTTP_STATUS', 'The stream server returned an error (HTTP 503).')).toMatch(temporary);
    // Not a server error, or not a network fault: find out why.
    const other =
      /\(\w+\)\. Find out why\. If it can’t play, switch it off with the reason; otherwise check it again\.$/;
    expect(advice('HTTP_STATUS', 'The stream server returned an error (HTTP 400).')).toMatch(other);
    expect(advice('NO_AUDIO_STREAM')).toMatch(other);
    expect(advice(null)).toMatch(/\(no code\)\. Find out why\./);
  });

  it('prints the warnings from the command line and still passes', () => {
    const dir = copyTemplate(tempDir());
    writeReport(dir, 'probe-2027-01-15.json', [
      ['template-example-hits-mp3', null],
      ['template-example-hits-hls', 'HTTP_TIMEOUT'],
    ]);
    const r = run('validate-catalogue.ts', ['--pack', dir, '--strict']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(
      /Warning: Pack "template": source "template-example-hits-hls" is enabled but failed/,
    );
    expect(r.out).toMatch(/Strict checks passed/);
  });
});

describe('generate --base', () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync(
      'git',
      ['-c', 'user.name=Test', '-c', 'user.email=test@example.org', '-c', 'commit.gpgsign=false', ...args],
      {
        cwd,
        encoding: 'utf8',
      },
    );
    if (r.status !== 0) throw new Error(r.stderr);
  };

  /** Two edits in a row, as an author makes while working on one change. */
  const editTwice = (dir: string, published: { version: string | null }) => {
    writeFileSync(
      join(dir, 'intake.csv'),
      exportIntake(dir).csv.replace(/^Example Hits,example-hits,/gm, 'Example Hits Radio,example-hits,'),
    );
    const first = generatePack(dir, { now: NOW, published }).version;
    writeFileSync(
      join(dir, 'intake.csv'),
      exportIntake(dir).csv + csvRow({ station: 'Example Jazz', tags: 'jazz' }),
    );
    const second = generatePack(dir, { now: NOW, published }).version;
    return [first, second];
  };

  it('keeps a pack that was never published at the date it was started', () => {
    const repo = tempDir();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'README.md'), 'library\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'start');
    const dir = copyTemplate(join(repo, 'packs'));
    const published = publishedVersion(dir, 'HEAD');
    expect(published).toEqual({ version: null });
    expect(editTwice(dir, published)).toEqual(['2026.11.03', '2026.11.03']);
  });

  it('bumps a published pack once, however often generate runs', () => {
    const repo = tempDir();
    git(repo, 'init', '-q');
    const dir = copyTemplate(join(repo, 'packs'));
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'publish');
    const published = publishedVersion(dir, 'HEAD');
    expect(published).toEqual({ version: '2026.11.03' });
    expect(editTwice(dir, published)).toEqual(['2027.01.15', '2027.01.15']);
    // The same day as the published version: .2, once.
    expect(editTwice(copyTemplate(tempDir()), { version: '2027.01.15' })).toEqual([
      '2027.01.15.2',
      '2027.01.15.2',
    ]);
  });

  it('works from the command line, and refuses a ref git does not know', () => {
    const repo = tempDir();
    git(repo, 'init', '-q');
    writeFileSync(join(repo, 'README.md'), 'library\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'start');
    const dir = copyTemplate(join(repo, 'packs'));
    writeFileSync(join(dir, 'intake.csv'), exportIntake(dir).csv + csvRow({ station: 'Example Jazz' }));
    const ok = run('pack-author.ts', ['generate', dir, '--base', 'HEAD']);
    expect(ok.err).toBe('');
    expect(ok.out).toMatch(/its version is now 2026\.11\.03\./);
    expect(() => publishedVersion(dir, 'no-such-branch')).toThrow(
      /Could not read the published pack from git/,
    );
    const bad = run('pack-author.ts', ['generate', dir, '--base', 'no-such-branch']);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/no-such-branch/);
  });
});
