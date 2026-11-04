/**
 * Tools for writing station packs and publishing a pack library. Runs straight from source with
 * Node 24 (no build step), so a pack library's CI can check out this repository and use it.
 *
 *   node scripts/pack-author.ts new <pack-id> [--root <folder>] [--ids <pack-ids.json>]
 *   node scripts/pack-author.ts export <pack-dir> [--force]
 *   node scripts/pack-author.ts generate <pack-dir> [--base <git-ref>]
 *   node scripts/pack-author.ts build-library <packs-root> <out-dir> --base-url <url>
 *                                             [--collections <dir>] [--withdrawn <file>]
 *   node scripts/pack-author.ts diff-check <old-pack-dir> <new-pack-dir>
 *
 * `new` starts a pack from catalog/packs/_template. `export` writes the pack's stations and
 * sources to intake.csv, one row per source (it won't replace an intake.csv whose rows say
 * something else, which may be edits not yet generated, unless given --force); `generate` reads intake.csv back into stations.json,
 * sources.json and the sources table of SOURCE_PROVENANCE.md, never changing or removing an
 * existing station slug or source ID; with `--base <git-ref>` it bumps the version once against the
 * pack as published at that ref. `build-library` writes a library's index.json and one bundle per
 * pack. `diff-check` checks a library pull request: no ID removed, and a new version for any
 * change. `strictProblems()` and `strictWarnings()` hold the extra checks behind
 * `validate-catalogue.ts --strict`.
 *
 * Nothing here touches the network (`--base` only reads the local git repository).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  checkBundle,
  countryName,
  type LibraryCollection,
  type LibraryIndex,
  type LibraryPack,
  libraryIndexSchema,
  MAX_BUNDLE_BYTES,
  MAX_INDEX_BYTES,
} from '../src/catalogue/pack-library.ts';
import {
  CUSTOM_PROVIDER,
  discoverPackDirs,
  loadPack,
  PACK_FILE_NAMES,
  PACK_ID,
  PACK_OWNER_KINDS,
  PACK_VERSION,
  packConflict,
  parsePack,
  type StationPack,
} from '../src/catalogue/packs.ts';
import { rootPath } from '../src/shared/paths.ts';
import { normalizeName } from '../src/shared/text.ts';
import { compareVersions } from '../src/shared/version.ts';

/** A problem the author has to fix; the CLI prints its message and exits with code 1. */
export class AuthorError extends Error {}

type Json = Record<string, unknown>;

const SLUG = /^[a-z0-9][a-z0-9-]{0,31}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SLUG = 32;
const MAX_SOURCE_ID = 100;
const LINE_WIDTH = 110;

export const TEMPLATE_DIR = (): string => rootPath('catalog', 'packs', '_template');
export const INTAKE_FILE = 'intake.csv';
export const PROVENANCE_FILE = 'SOURCE_PROVENANCE.md';
export const TABLE_START = '<!-- sources:start -->';
export const TABLE_END = '<!-- sources:end -->';

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Today as a pack version (`YYYY.MM.DD`, UTC). */
export function todayVersion(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10).replace(/-/g, '.');
}

/** The version after `current`: today's date, or today plus `.2`, `.3` … if it already has today's date. */
export function nextVersion(current: string | null, now: Date = new Date()): string {
  const today = todayVersion(now);
  if (!current || compareVersions(current, today) < 0) return today;
  const parts = current.split('.');
  const n = parts.length > 3 ? Number.parseInt(parts[3]!, 10) || 1 : 1;
  return `${parts.slice(0, 3).join('.')}.${n + 1}`;
}

// ---------------------------------------------------------------------------------------------
// JSON in the layout Biome gives it: objects one key per line, short arrays of plain values on one
// line, so a generated file passes `biome check` unchanged.

export function formatJson(value: unknown): string {
  return `${render(value, '', 0, 0)}\n`;
}

function render(v: unknown, indent: string, before: number, after: number): string {
  const inner = `${indent}  `;
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    if (v.every((x) => x === null || typeof x !== 'object')) {
      const flat = `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
      if (before + flat.length + after <= LINE_WIDTH) return flat;
    }
    const items = v.map((x, i) => {
      const last = i === v.length - 1;
      return `${inner}${render(x, inner, inner.length, last ? 0 : 1)}${last ? '' : ','}`;
    });
    return `[\n${items.join('\n')}\n${indent}]`;
  }
  if (isObject(v)) {
    const entries = Object.entries(v).filter(([, x]) => x !== undefined);
    if (entries.length === 0) return '{}';
    const lines = entries.map(([k, x], i) => {
      const last = i === entries.length - 1;
      const key = `${JSON.stringify(k)}: `;
      return `${inner}${key}${render(x, inner, inner.length + key.length, last ? 0 : 1)}${last ? '' : ','}`;
    });
    return `{\n${lines.join('\n')}\n${indent}}`;
  }
  return JSON.stringify(v);
}

// ---------------------------------------------------------------------------------------------
// CSV (RFC 4180): quoted fields with embedded commas, quotes and line breaks; CRLF or LF; an
// optional UTF-8 byte-order mark.

export interface CsvRecord {
  /** The line the record starts on (1-based). */
  line: number;
  cells: string[];
}

export function parseCsv(input: string): CsvRecord[] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let closed = false; // just after a closing quote
  let line = 1;
  let recordLine = 1;
  const endRecord = () => {
    cells.push(cell);
    if (cells.some((c) => c !== '')) records.push({ line: recordLine, cells });
    cells = [];
    cell = '';
    closed = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else if (c === '\r' && text[i + 1] === '\n') {
        // A quoted line break is kept as a plain \n.
      } else {
        if (c === '\n') line++;
        cell += c;
      }
    } else if (c === ',') {
      cells.push(cell);
      cell = '';
      closed = false;
    } else if (c === '\r' || c === '\n') {
      endRecord();
      if (c === '\r' && text[i + 1] === '\n') i++;
      line++;
      recordLine = line;
    } else if (closed) {
      throw new AuthorError(`line ${line}: there is text after a closing quote`);
    } else if (c === '"') {
      if (cell !== '') throw new AuthorError(`line ${line}: a quote may only start a field`);
      quoted = true;
    } else {
      cell += c;
    }
  }
  if (quoted) throw new AuthorError(`line ${recordLine}: a quoted field is never closed`);
  if (cell !== '' || cells.length > 0 || closed) endRecord();
  return records;
}

export function writeCsv(rows: ReadonlyArray<ReadonlyArray<string>>): string {
  const quote = (c: string) => (/[",\r\n]/.test(c) || c !== c.trim() ? `"${c.replace(/"/g, '""')}"` : c);
  return rows.map((r) => `${r.map(quote).join(',')}\n`).join('');
}

// ---------------------------------------------------------------------------------------------
// intake.csv

export const CSV_COLUMNS = [
  'station',
  'slug',
  'aliases',
  'category',
  'tags',
  'order',
  'external_id',
  'official_page',
  'country',
  'region',
  'catalogue_status',
  'url',
  'label',
  'transport',
  'codec',
  'priority',
  'provenance',
  'found_at',
  'found_on',
  'provenance_detail',
  'enabled',
  'disabled_reason',
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

const SOURCE_COLUMNS: readonly CsvColumn[] = [
  'label',
  'transport',
  'codec',
  'priority',
  'provenance',
  'found_at',
  'found_on',
  'provenance_detail',
  'enabled',
  'disabled_reason',
];

interface IntakeRow {
  line: number;
  values: Partial<Record<CsvColumn, string>>;
}

/** Reads intake.csv text into rows of trimmed values; every problem found is reported at once. */
export function readIntake(text: string): IntakeRow[] {
  const records = parseCsv(text);
  const header = records.shift();
  if (!header) throw new AuthorError(`${INTAKE_FILE} is empty: it needs a header row.`);
  const problems: string[] = [];
  const columns = header.cells.map((c) => c.trim().toLowerCase());
  const seen = new Set<string>();
  for (const c of columns) {
    if (!(CSV_COLUMNS as readonly string[]).includes(c))
      problems.push(`Unknown column "${c}". The columns are: ${CSV_COLUMNS.join(', ')}.`);
    if (seen.has(c)) problems.push(`The column "${c}" appears twice.`);
    seen.add(c);
  }
  if (!seen.has('station')) problems.push('The required column "station" is missing.');
  if (problems.length) throw new AuthorError(problems.map((p) => `${INTAKE_FILE}: ${p}`).join('\n'));
  const rows: IntakeRow[] = [];
  for (const r of records) {
    if (r.cells.length !== columns.length) {
      problems.push(
        `${INTAKE_FILE} line ${r.line}: has ${r.cells.length} fields but the header has ${columns.length}.`,
      );
      continue;
    }
    const values: Partial<Record<CsvColumn, string>> = {};
    columns.forEach((c, i) => {
      const v = r.cells[i]!.trim();
      if (v !== '') values[c as CsvColumn] = v;
    });
    rows.push({ line: r.line, values });
  }
  if (problems.length) throw new AuthorError(problems.join('\n'));
  return rows;
}

const cellOf = (v: unknown): string =>
  v === null || v === undefined
    ? ''
    : Array.isArray(v)
      ? v.map(String).join('|')
      : typeof v === 'object'
        ? JSON.stringify(v)
        : String(v);

// ---------------------------------------------------------------------------------------------
// Reading a pack folder as plain JSON (a new pack's stations.json may still be empty, which
// loadPack() would refuse).

interface RawPack {
  pack: Json;
  stationsFile: Json;
  stations: Json[];
  sourcesFile: Json | null;
  sources: Json[];
}

function readJsonFile(path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new AuthorError(`${path} could not be read.`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new AuthorError(`${path} is not valid JSON: ${(err as Error).message}`);
  }
}

function readRawPack(dir: string): RawPack {
  const pack = readJsonFile(join(dir, 'pack.json'));
  if (!isObject(pack) || typeof pack.id !== 'string') throw new AuthorError(`${dir}/pack.json has no "id".`);
  const stationsFile = readJsonFile(join(dir, 'stations.json'));
  if (
    !isObject(stationsFile) ||
    !Array.isArray(stationsFile.stations) ||
    !stationsFile.stations.every(isObject)
  )
    throw new AuthorError(`${dir}/stations.json must hold a "stations" list.`);
  const sourcesPath = join(dir, 'sources.json');
  let sourcesFile: Json | null = null;
  if (existsSync(sourcesPath)) {
    const raw = readJsonFile(sourcesPath);
    if (!isObject(raw) || !Array.isArray(raw.sources) || !raw.sources.every(isObject))
      throw new AuthorError(`${dir}/sources.json must hold a "sources" list.`);
    sourcesFile = raw;
  }
  return {
    pack,
    stationsFile,
    stations: stationsFile.stations as Json[],
    sourcesFile,
    sources: (sourcesFile?.sources as Json[] | undefined) ?? [],
  };
}

// ---------------------------------------------------------------------------------------------
// export

/** intake.csv text for a pack: one row per source, plus one row with no url per station without sources. */
export function exportIntake(dir: string): { csv: string; rows: number } {
  const raw = readRawPack(dir);
  const rows: string[][] = [[...CSV_COLUMNS]];
  for (const st of raw.stations) {
    const station: Partial<Record<CsvColumn, string>> = {
      station: cellOf(st.displayName),
      slug: cellOf(st.slug),
      aliases: cellOf(st.aliases),
      category: cellOf(st.category),
      tags: cellOf(st.tags),
      order: cellOf(st.order),
      external_id: cellOf(st.externalId),
      official_page: cellOf(st.officialPage),
      country: cellOf(st.country),
      region: cellOf(st.region),
      catalogue_status: cellOf(st.catalogueStatus),
    };
    const sources = raw.sources.filter((s) => s.station === st.slug);
    const lines = sources.length ? sources : [null];
    for (const src of lines) {
      const values: Partial<Record<CsvColumn, string>> = { ...station };
      if (src) {
        Object.assign(values, {
          url: cellOf(src.url),
          label: cellOf(src.label),
          transport: cellOf(src.transportHint),
          codec: cellOf(src.codecHint),
          priority: cellOf(src.priority),
          provenance: cellOf(src.provenance),
          provenance_detail: cellOf(src.provenanceDetail),
          enabled: cellOf(src.enabled),
          disabled_reason: cellOf(src.disabledReason),
        });
      }
      rows.push(CSV_COLUMNS.map((c) => values[c] ?? ''));
    }
  }
  return { csv: writeCsv(rows), rows: rows.length - 1 };
}

/** Whether intake.csv holds rows beyond its header (or can't be read), which a new export would replace. */
function intakeHasRows(text: string): boolean {
  try {
    return parseCsv(text).length > 1;
  } catch {
    return true;
  }
}

/**
 * Writes `exportIntake`'s intake.csv into the pack folder. An intake.csv that already holds rows may
 * have edits `generate` hasn't read yet, so it is replaced only when it says the same thing already,
 * or with `force`. The file is written whole and then renamed into place, so it is never half-written.
 */
export function writeIntake(dir: string, opts: { force?: boolean } = {}): { path: string; rows: number } {
  const r = exportIntake(dir);
  const path = join(dir, INTAKE_FILE);
  if (existsSync(path) && !opts.force) {
    const current = readFileSync(path, 'utf8');
    if (current !== r.csv && intakeHasRows(current))
      throw new AuthorError(
        `${path} already has rows, which may hold edits that generate hasn't read yet. Run generate first, or run export again with --force to replace them with what stations.json and sources.json hold.`,
      );
  }
  const tmp = join(dir, `.${INTAKE_FILE}.${process.pid}.tmp`);
  writeFileSync(tmp, r.csv);
  renameSync(tmp, path);
  return { path, rows: r.rows };
}

// ---------------------------------------------------------------------------------------------
// generate

export interface GenerateResult {
  /** Whether stations.json or sources.json changed (and so the version). */
  changed: boolean;
  version: string | null;
  addedStations: string[];
  addedSources: string[];
  renamedStations: string[];
  updatedStations: number;
  updatedSources: number;
  warnings: string[];
  /** Files written. */
  written: string[];
}

interface StationGroup {
  /** The existing station, or null for a new one. */
  existing: Json | null;
  /** The slug: existing, given in the CSV, or assigned later for a new station. */
  slug: string | null;
  matchedBy: 'slug' | 'name' | 'alias' | null;
  rows: IntakeRow[];
}

function slugPart(text: string, max: number): string {
  return normalizeName(text).replace(/\s+/g, '-').slice(0, max).replace(/-+$/, '');
}

function unique(base: string, taken: ReadonlySet<string>, max: number): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, max - String(n).length - 1).replace(/-+$/, '')}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** A slug for a new station: lower case, a–z, 0–9 and `-`, at most 32 characters, unused in the pack. */
export function stationSlug(displayName: string, taken: ReadonlySet<string>): string {
  return unique(slugPart(displayName, MAX_SLUG) || 'station', taken, MAX_SLUG);
}

/** An ID for a new source: `<pack-id>-<station-slug>-<suffix>`, unique across the pack. */
export function sourceId(
  packId: string,
  stationSlug: string,
  hints: { label?: string | null; codec?: string | null; transport?: string | null },
  taken: ReadonlySet<string>,
): string {
  const prefix = stationSlug.startsWith(`${packId}-`) ? stationSlug : `${packId}-${stationSlug}`;
  const suffix =
    slugPart(hints.label ?? '', 24) ||
    slugPart(hints.codec ?? '', 24) ||
    (hints.transport === 'hls' ? 'hls' : '');
  if (suffix) return unique(`${prefix}-${suffix}`, taken, MAX_SOURCE_ID);
  for (let n = 1; ; n++) if (!taken.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

const split = (v: string | undefined): string[] =>
  (v ?? '')
    .split('|')
    .map((x) => x.trim())
    .filter(Boolean);

/** Sets `obj[key]` unless its current value (or the schema default when absent) is already `value`. */
function setField(obj: Json, key: string, value: unknown, fallback: unknown): boolean {
  const current = key in obj ? obj[key] : fallback;
  if (sameJson(current, value)) return false;
  obj[key] = value;
  return true;
}

function validDate(v: string): boolean {
  if (!DATE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

function checkRow(row: IntakeRow, problems: string[]): void {
  const v = row.values;
  const at = `${INTAKE_FILE} line ${row.line}`;
  if (!v.station) problems.push(`${at}: "station" (the display name) is empty.`);
  if (v.slug && !SLUG.test(v.slug))
    problems.push(`${at}: slug "${v.slug}" may only use a–z, 0–9 and "-", at most 32 characters.`);
  for (const c of ['order', 'priority'] as const)
    if (v[c] !== undefined && !/^\d+$/.test(v[c])) problems.push(`${at}: ${c} must be a whole number.`);
  if (v.country && !/^[A-Za-z]{2}$/.test(v.country))
    problems.push(`${at}: country must be a two-letter code such as GB.`);
  if (v.catalogue_status && !['active', 'missing_from_official', 'retired'].includes(v.catalogue_status))
    problems.push(`${at}: catalogue_status must be active, missing_from_official or retired.`);
  if (v.transport && !['http-continuous', 'hls'].includes(v.transport))
    problems.push(`${at}: transport must be http-continuous, hls or empty.`);
  if (v.provenance && !['official-player', 'curated'].includes(v.provenance))
    problems.push(`${at}: provenance must be official-player or curated.`);
  if (v.found_on && !validDate(v.found_on))
    problems.push(`${at}: found_on must be a date written YYYY-MM-DD.`);
  if (v.enabled && !['true', 'false'].includes(v.enabled.toLowerCase()))
    problems.push(`${at}: enabled must be true or false.`);
  if (v.url) {
    if (!/^https?:\/\//i.test(v.url)) problems.push(`${at}: url must start with https:// or http://.`);
    if (!v.provenance)
      problems.push(`${at}: a row with a url needs provenance (official-player or curated).`);
  } else {
    const stray = SOURCE_COLUMNS.filter((c) => v[c] !== undefined);
    if (stray.length) problems.push(`${at}: ${stray.join(', ')} given without a url.`);
  }
}

/** The one non-empty value a column has across a station's rows; a disagreement is a problem. */
function stationValue(group: StationGroup, column: CsvColumn, problems: string[]): string | undefined {
  let found: { value: string; line: number } | undefined;
  for (const r of group.rows) {
    const v = r.values[column];
    if (v === undefined) continue;
    if (!found) found = { value: v, line: r.line };
    else if (found.value !== v)
      problems.push(
        `${INTAKE_FILE} lines ${found.line} and ${r.line}: different ${column} for the same station ("${found.value}", "${v}").`,
      );
  }
  return found?.value;
}

const FOUND_DETAIL = /Linked from (.+?) on (\d{4}-\d{2}-\d{2})/;

/**
 * Rebuilds a pack's stations.json, sources.json and the sources table of SOURCE_PROVENANCE.md from
 * its intake.csv. The JSON is the source of truth for IDs: no existing slug or source ID is ever
 * changed or removed. An empty cell keeps an existing value (edit the JSON to clear one). The
 * result is checked with the pack loader's own rules first; on any problem nothing is written.
 *
 * A change bumps `version`. Given `published` (the version already published, or null for a pack
 * that never was), the bump is made once against it, so running generate again while working on
 * the same change keeps the version; a new pack keeps the date it was started with.
 */
export function generatePack(
  dir: string,
  opts: { now?: Date; published?: { version: string | null } } = {},
): GenerateResult {
  const now = opts.now ?? new Date();
  const raw = readRawPack(dir);
  const packId = raw.pack.id as string;
  const intakePath = join(dir, INTAKE_FILE);
  if (!existsSync(intakePath)) throw new AuthorError(`${intakePath} does not exist. Run "export" first.`);
  const rows = readIntake(readFileSync(intakePath, 'utf8'));

  const problems: string[] = [];
  for (const r of rows) checkRow(r, problems);
  if (problems.length) throw new AuthorError(problems.join('\n'));

  const stations: Json[] = structuredClone(raw.stations);
  const sources: Json[] = structuredClone(raw.sources);
  const bySlug = new Map(stations.map((s) => [s.slug as string, s]));
  const byLabel = new Map<string, { station: Json; kind: 'name' | 'alias' }>();
  for (const s of stations) {
    for (const a of Array.isArray(s.aliases) ? (s.aliases as string[]) : [])
      byLabel.set(normalizeName(a), { station: s, kind: 'alias' });
    byLabel.set(normalizeName(String(s.displayName)), { station: s, kind: 'name' });
  }

  // Group the rows by station: explicit slugs first, then names and aliases.
  const groups: StationGroup[] = [];
  const groupBySlug = new Map<string, StationGroup>();
  const groupByNewName = new Map<string, StationGroup>();
  for (const r of rows.filter((x) => x.values.slug)) {
    const slug = r.values.slug!;
    let g = groupBySlug.get(slug);
    if (!g) {
      const existing = bySlug.get(slug) ?? null;
      g = { existing, slug, matchedBy: existing ? 'slug' : null, rows: [] };
      groupBySlug.set(slug, g);
      groups.push(g);
      if (!existing) groupByNewName.set(normalizeName(r.values.station!), g);
    }
    g.rows.push(r);
  }
  for (const r of rows.filter((x) => !x.values.slug)) {
    const key = normalizeName(r.values.station!);
    const hit = byLabel.get(key);
    let g: StationGroup | undefined;
    if (hit) {
      const slug = hit.station.slug as string;
      g = groupBySlug.get(slug);
      if (!g) {
        g = { existing: hit.station, slug, matchedBy: hit.kind, rows: [] };
        groupBySlug.set(slug, g);
        groups.push(g);
      }
    } else {
      g = groupByNewName.get(key);
      if (!g) {
        g = { existing: null, slug: null, matchedBy: null, rows: [] };
        groupByNewName.set(key, g);
        groups.push(g);
      }
    }
    g.rows.push(r);
  }

  const result: GenerateResult = {
    changed: false,
    version: (raw.pack.version as string | null | undefined) ?? null,
    addedStations: [],
    addedSources: [],
    renamedStations: [],
    updatedStations: 0,
    updatedSources: 0,
    warnings: [],
    written: [],
  };

  // Stations.
  const takenSlugs = new Set(stations.map((s) => s.slug as string));
  for (const g of groups) if (g.slug) takenSlugs.add(g.slug);
  let nextOrder = Math.max(0, ...stations.map((s) => (typeof s.order === 'number' ? s.order : 0)));
  for (const g of groups) {
    // Rows that give the slug name the station; rows matched by name or alias only point to it.
    const named = [...new Set(g.rows.filter((r) => r.values.slug).map((r) => r.values.station!))];
    const names = [...new Set(g.rows.map((r) => r.values.station!))];
    const v = (c: CsvColumn) => stationValue(g, c, problems);
    const fields = {
      externalId: v('external_id'),
      category: v('category'),
      tags: v('tags'),
      order: v('order'),
      officialPage: v('official_page'),
      country: v('country')?.toUpperCase(),
      region: v('region'),
      catalogueStatus: v('catalogue_status'),
    };
    const aliases = g.rows.flatMap((r) => split(r.values.aliases));
    if (named.length > 1) {
      problems.push(
        `${INTAKE_FILE} lines ${g.rows.map((r) => r.line).join(', ')}: one station has different names (${named.map((n) => `"${n}"`).join(', ')}).`,
      );
      continue;
    }
    let station = g.existing;
    let touched = false;
    if (!station) {
      const displayName = named[0] ?? names[0]!;
      const slug = g.slug ?? stationSlug(displayName, takenSlugs);
      takenSlugs.add(slug);
      g.slug = slug;
      station = {
        slug,
        displayName,
        externalId: fields.externalId ?? null,
        aliases: [],
        category: fields.category ?? null,
        tags: split(fields.tags),
        order: fields.order !== undefined ? Number(fields.order) : ++nextOrder,
        officialPage: fields.officialPage ?? null,
        catalogueStatus: fields.catalogueStatus ?? 'active',
        country: fields.country ?? null,
        region: fields.region ?? null,
      };
      if (typeof station.order === 'number' && station.order > nextOrder) nextOrder = station.order;
      stations.push(station);
      result.addedStations.push(slug);
    } else {
      const oldName = String(station.displayName);
      let newName: string | null = null;
      if (named.length) newName = named[0]!;
      else newName = names.find((n) => normalizeName(n) === normalizeName(oldName)) ?? null;
      if (newName !== null && newName !== oldName) {
        station.displayName = newName;
        touched = true;
        const current = Array.isArray(station.aliases) ? (station.aliases as string[]) : [];
        const keep = current.filter((a) => normalizeName(a) !== normalizeName(newName));
        if (normalizeName(oldName) !== normalizeName(newName)) {
          keep.push(oldName);
          result.renamedStations.push(`${station.slug}: "${oldName}" → "${newName}"`);
        }
        station.aliases = keep;
      }
      if (fields.externalId !== undefined)
        touched = setField(station, 'externalId', fields.externalId, null) || touched;
      if (fields.category !== undefined)
        touched = setField(station, 'category', fields.category, null) || touched;
      if (fields.tags !== undefined) touched = setField(station, 'tags', split(fields.tags), []) || touched;
      if (fields.order !== undefined)
        touched = setField(station, 'order', Number(fields.order), undefined) || touched;
      if (fields.officialPage !== undefined)
        touched = setField(station, 'officialPage', fields.officialPage, null) || touched;
      if (fields.country !== undefined)
        touched = setField(station, 'country', fields.country, null) || touched;
      if (fields.region !== undefined) touched = setField(station, 'region', fields.region, null) || touched;
      if (fields.catalogueStatus !== undefined)
        touched = setField(station, 'catalogueStatus', fields.catalogueStatus, 'active') || touched;
    }
    // Aliases are only ever added.
    const current = Array.isArray(station.aliases) ? [...(station.aliases as string[])] : [];
    const known = new Set([...current, String(station.displayName)].map(normalizeName));
    for (const a of aliases) {
      if (known.has(normalizeName(a))) continue;
      known.add(normalizeName(a));
      current.push(a);
    }
    if (!sameJson(current, station.aliases ?? [])) {
      station.aliases = current;
      touched = true;
    }
    if (touched && g.existing) result.updatedStations++;
  }
  if (problems.length) throw new AuthorError(problems.join('\n'));

  // Sources.
  const byUrl = new Map(sources.map((s) => [s.url as string, s]));
  const takenIds = new Set(sources.map((s) => s.id as string));
  const csvUrls = new Map<string, number>();
  const tableHints = new Map<string, { foundAt?: string; foundOn?: string }>();
  const stationOf = new Map(stations.map((s) => [s.slug as string, s]));
  for (const g of groups) {
    const slug = g.slug!;
    for (const r of g.rows) {
      const v = r.values;
      if (!v.url) continue;
      const at = `${INTAKE_FILE} line ${r.line}`;
      const earlier = csvUrls.get(v.url);
      if (earlier !== undefined) {
        problems.push(`${at}: the url is already on line ${earlier}.`);
        continue;
      }
      csvUrls.set(v.url, r.line);
      const enabled = v.enabled === undefined ? undefined : v.enabled.toLowerCase() === 'true';
      const existing = byUrl.get(v.url);
      if (existing) {
        if (existing.station !== slug) {
          problems.push(
            `${at}: this url already belongs to station "${existing.station}" (source "${existing.id}"). Move a source by editing sources.json.`,
          );
          continue;
        }
        let touched = false;
        if (v.label !== undefined) touched = setField(existing, 'label', v.label, null) || touched;
        if (v.priority !== undefined)
          touched = setField(existing, 'priority', Number(v.priority), 100) || touched;
        if (v.transport !== undefined)
          touched = setField(existing, 'transportHint', v.transport, null) || touched;
        if (v.codec !== undefined) touched = setField(existing, 'codecHint', v.codec, null) || touched;
        if (v.provenance !== undefined)
          touched = setField(existing, 'provenance', v.provenance, undefined) || touched;
        if (v.provenance_detail !== undefined)
          touched = setField(existing, 'provenanceDetail', v.provenance_detail, undefined) || touched;
        if (enabled !== undefined) {
          touched = setField(existing, 'enabled', enabled, true) || touched;
          if (enabled && v.disabled_reason === undefined)
            touched = setField(existing, 'disabledReason', null, null) || touched;
        }
        if (v.disabled_reason !== undefined)
          touched = setField(existing, 'disabledReason', v.disabled_reason, null) || touched;
        if (touched) result.updatedSources++;
        tableHints.set(existing.id as string, { foundAt: v.found_at, foundOn: v.found_on });
        continue;
      }
      let detail = v.provenance_detail;
      if (!detail) {
        if (!v.found_at || !v.found_on) {
          problems.push(`${at}: a new source needs provenance_detail, or both found_at and found_on.`);
          continue;
        }
        detail = `Linked from ${v.found_at} on ${v.found_on}.`;
      }
      const id = sourceId(packId, slug, { label: v.label, codec: v.codec, transport: v.transport }, takenIds);
      takenIds.add(id);
      const position = sources.filter((s) => s.station === slug).length + 1;
      const src: Json = {
        id,
        station: slug,
        url: v.url,
        label: v.label ?? null,
        priority: v.priority !== undefined ? Number(v.priority) : position * 10,
        transportHint: v.transport ?? null,
        codecHint: v.codec ?? null,
        provenance: v.provenance,
        provenanceDetail: detail,
        enabled: enabled ?? true,
        disabledReason: enabled === false ? (v.disabled_reason ?? null) : null,
      };
      let insertAt = -1;
      sources.forEach((s, i) => {
        if (s.station === slug) insertAt = i;
      });
      if (insertAt < 0) sources.push(src);
      else sources.splice(insertAt + 1, 0, src);
      byUrl.set(v.url, src);
      tableHints.set(id, { foundAt: v.found_at, foundOn: v.found_on });
      result.addedSources.push(id);
    }
  }
  if (problems.length) throw new AuthorError(problems.join('\n'));

  for (const s of raw.stations)
    if (!groupBySlug.has(s.slug as string))
      result.warnings.push(`Station "${s.slug}" (${s.displayName}) is not in ${INTAKE_FILE}; it was kept.`);
  for (const s of raw.sources)
    if (!csvUrls.has(s.url as string))
      result.warnings.push(`Source "${s.id}" is not in ${INTAKE_FILE}; it was kept.`);
  for (const s of sources)
    if (s.enabled === false && !s.disabledReason)
      result.warnings.push(`Source "${s.id}" is disabled without a disabled_reason.`);

  if (stations.length === 0)
    throw new AuthorError(
      `${INTAKE_FILE} has no stations yet: add at least one row, then run generate again.`,
    );

  // Assemble, version and check the whole pack before writing anything.
  result.changed = !sameJson(stations, raw.stations) || !sameJson(sources, raw.sources);
  let pack: Json = { ...raw.pack };
  if (result.changed) {
    const published = opts.published;
    if (!published) result.version = nextVersion(result.version, now);
    else if (published.version === null) result.version = result.version ?? todayVersion(now);
    else if (!result.version || compareVersions(result.version, published.version) <= 0)
      result.version = nextVersion(published.version, now);
    if ('version' in pack) pack.version = result.version;
    else {
      // Put a new version field straight after the name, where the template has it.
      const ordered: Json = {};
      for (const [k, val] of Object.entries(pack)) {
        ordered[k] = val;
        if (k === 'name') ordered.version = result.version;
      }
      if (!('version' in ordered)) ordered.version = result.version;
      pack = ordered;
    }
  }
  const stationsFile: Json = { ...raw.stationsFile, stations };
  const writeSources = raw.sourcesFile !== null || sources.length > 0;
  const sourcesFile: Json = { ...(raw.sourcesFile ?? { schemaVersion: 1 }), sources };
  try {
    parsePack({ pack, stations: stationsFile, sources: writeSources ? sourcesFile : undefined }, dir);
  } catch (err) {
    throw new AuthorError(
      `The result would not be a valid pack, so nothing was written:\n${(err as Error).message}`,
    );
  }

  const mdPath = join(dir, PROVENANCE_FILE);
  const mdOld = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : null;
  const mdNew = updateProvenanceTable(mdOld, packId, String(pack.name), sources, stationOf, tableHints);

  const writes: Array<[string, string]> = [];
  if (result.changed) {
    writes.push([join(dir, 'stations.json'), formatJson(stationsFile)]);
    if (writeSources) writes.push([join(dir, 'sources.json'), formatJson(sourcesFile)]);
    writes.push([join(dir, 'pack.json'), formatJson(pack)]);
  }
  if (mdNew !== mdOld) writes.push([mdPath, mdNew]);
  for (const [path, text] of writes) {
    writeFileSync(path, text);
    result.written.push(path);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// SOURCE_PROVENANCE.md sources table

const TABLE_HEADER = ['Source ID', 'Station', 'Found at', 'Date', 'Provenance'];

/** A table row's cells: `\|` is a pipe inside a cell and `\\` a backslash (the reverse of `markdownTable`). */
export function tableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '');
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    const next = body[i + 1];
    if (ch === '\\' && (next === '\\' || next === '|')) {
      cell += next;
      i++;
    } else if (ch === '|') {
      cells.push(cell.trim());
      cell = '';
    } else cell += ch;
  }
  // A row ends with "|"; anything after the last one is a cell of its own.
  if (cell.trim()) cells.push(cell.trim());
  return cells;
}

/** Renders a Markdown table padded the way Biome formats one. */
export function markdownTable(header: readonly string[], rows: ReadonlyArray<ReadonlyArray<string>>): string {
  // Backslashes first, so an escaped pipe can't be undone by a backslash already in the text.
  const esc = (c: string) =>
    c
      .replace(/[\r\n]+/g, ' ')
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|');
  const all = [header, ...rows].map((r) => r.map(esc));
  const widths = header.map((_, i) => Math.max(3, ...all.map((r) => (r[i] ?? '').length)));
  const line = (r: readonly string[]) => `| ${widths.map((w, i) => (r[i] ?? '').padEnd(w)).join(' | ')} |`;
  return [
    line(all[0]!),
    `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`,
    ...all.slice(1).map(line),
  ].join('\n');
}

function updateProvenanceTable(
  md: string | null,
  packId: string,
  packName: string,
  sources: readonly Json[],
  stations: ReadonlyMap<string, Json>,
  hints: ReadonlyMap<string, { foundAt?: string; foundOn?: string }>,
): string {
  let text = md ?? `# Source provenance: ${packName} (\`${packId}\`)\n`;
  let start = text.indexOf(TABLE_START);
  let end = start < 0 ? -1 : text.indexOf(TABLE_END, start);
  if (start < 0 || end < 0) {
    text = `${text.replace(/\s*$/, '')}\n\n## Sources\n\n${TABLE_START}\n${TABLE_END}\n`;
    start = text.indexOf(TABLE_START);
    end = text.indexOf(TABLE_END, start);
  }
  const previous = new Map<string, { foundAt: string; date: string }>();
  for (const l of text.slice(start + TABLE_START.length, end).split('\n')) {
    if (!l.trim().startsWith('|')) continue;
    const [id, , foundAt, date] = tableCells(l);
    if (!id || id === TABLE_HEADER[0] || /^:?-+:?$/.test(id)) continue;
    previous.set(id.replace(/`/g, ''), { foundAt: foundAt ?? '', date: date ?? '' });
  }
  const rows = sources.map((s) => {
    const id = String(s.id);
    const hint = hints.get(id);
    const prev = previous.get(id);
    const detail = String(s.provenanceDetail);
    const parsed = FOUND_DETAIL.exec(detail);
    const foundAt =
      hint?.foundAt || prev?.foundAt || parsed?.[1] || /https?:\/\/[^\s)]+/.exec(detail)?.[0] || '—';
    const date = hint?.foundOn || prev?.date || parsed?.[2] || /\d{4}-\d{2}-\d{2}/.exec(detail)?.[0] || '—';
    const station = stations.get(String(s.station))!;
    return [`\`${id}\``, String(station.displayName), foundAt, date, String(s.provenance)];
  });
  const table = markdownTable(TABLE_HEADER, rows);
  return `${text.slice(0, start + TABLE_START.length)}\n${table}\n${text.slice(end)}`;
}

// ---------------------------------------------------------------------------------------------
// new

export interface NewPackResult {
  dir: string;
  idsFile: string | null;
  nextSteps: string[];
}

function provenanceSkeleton(id: string): string {
  return [
    `# Source provenance: ${id} (\`${id}\`)`,
    '',
    'This file records where every station and source in this pack came from, what was checked and what was not.',
    'Every source ID in `sources.json` must appear in this file. See `catalog/packs/_template/` in the Radio Bot repository for a worked example.',
    '',
    '## Station list',
    '',
    '- **Where.** Where the station names came from, and when.',
    '- **What was added by hand.** Which fields were written for this pack rather than taken from an official source.',
    '',
    '## How the sources were found',
    '',
    '1. Which official page or player each stream address was taken from, and how.',
    '',
    '## What was not verified',
    '',
    '- What nobody has checked yet.',
    '',
    '## Sources',
    '',
    TABLE_START,
    markdownTable(TABLE_HEADER, []),
    TABLE_END,
    '',
  ].join('\n');
}

/** Starts a new pack folder from the template. */
export function newPack(
  id: string,
  opts: { root?: string; idsFile?: string | null; now?: Date } = {},
): NewPackResult {
  if (!PACK_ID.test(id))
    throw new AuthorError(
      `"${id}" is not a valid pack ID: use lower-case letters, digits and "-", starting with a letter or digit, at most 32 characters.`,
    );
  if (id === CUSTOM_PROVIDER)
    throw new AuthorError(`"${CUSTOM_PROVIDER}" is reserved and can't be a pack ID.`);
  const root = resolve(opts.root ?? join('catalog', 'packs'));
  const dir = join(root, id);
  if (existsSync(dir)) throw new AuthorError(`${dir} already exists.`);
  const defaultIds = join(root, '..', 'pack-ids.json');
  const idsFile = opts.idsFile ? resolve(opts.idsFile) : existsSync(defaultIds) ? defaultIds : null;
  if (idsFile) {
    const ids = readJsonFile(idsFile);
    if (!isObject(ids) || !Array.isArray(ids.ids))
      throw new AuthorError(`${idsFile} must hold an "ids" list.`);
    if (ids.ids.includes(id))
      throw new AuthorError(
        `The pack ID "${id}" is already taken (it is in ${idsFile}). Pack IDs are never reused.`,
      );
  }
  const template = TEMPLATE_DIR();
  if (!existsSync(join(template, 'pack.json')))
    throw new AuthorError(`The template pack is missing: ${template}`);

  mkdirSync(root, { recursive: true });
  cpSync(template, dir, { recursive: true });
  try {
    rmSync(join(dir, 'README.md'), { force: true });
    rmSync(join(dir, 'evidence'), { recursive: true, force: true });
    mkdirSync(join(dir, 'evidence'));
    writeFileSync(join(dir, 'evidence', '.gitkeep'), '');

    const pack = readJsonFile(join(dir, 'pack.json')) as Json;
    Object.assign(pack, {
      id,
      name: id,
      description: '',
      version: todayVersion(opts.now),
      owner: null,
      countries: [],
      regions: [],
      languages: [],
      minBotVersion: null,
      disclaimer: null,
      brandLabels: [],
      categories: [],
      sync: null,
      snapshotDate: null,
    });
    writeFileSync(join(dir, 'pack.json'), formatJson(pack));
    writeFileSync(join(dir, 'stations.json'), formatJson({ schemaVersion: 1, stations: [] }));
    writeFileSync(join(dir, 'sources.json'), formatJson({ schemaVersion: 1, sources: [] }));
    writeFileSync(join(dir, PROVENANCE_FILE), provenanceSkeleton(id));
    writeFileSync(join(dir, INTAKE_FILE), writeCsv([[...CSV_COLUMNS]]));
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  const nextSteps = [
    idsFile
      ? `Add "${id}" to ${idsFile}: every pack ID is recorded there, and is never reused (this tool doesn't edit that file).`
      : `Add "${id}" to the library's pack-ids.json: every pack ID is recorded there, and is never reused.`,
    `Fill in pack.json: name, description, owner, countries, regions, languages, categories and brandLabels. ${join(template, 'README.md')} explains every field.`,
    `Put one row per stream in ${join(dir, INTAKE_FILE)}, and one row with an empty url for a station that has no stream yet. The pack is not valid until it has at least one station.`,
    `Run: ${script('pack-author.ts')} generate ${arg(dir)} (in a git checkout of a pack library, add --base origin/main so the version is bumped only once)`,
    `Describe how the sources were found in ${PROVENANCE_FILE}, and put a probe report in evidence/: ${probeCommand(dir, id)}`,
    `Check: ${script('validate-catalogue.ts')} --pack ${arg(dir)} --strict`,
  ];
  return { dir, idsFile, nextSteps };
}

// Commands as they run from the current folder: a pack library next to the bot gets
// `node ../radiobot/scripts/…`. Forward slashes and quotes work in Bash and PowerShell alike.
function arg(p: string): string {
  const s = (relative(process.cwd(), p) || '.').replace(/\\/g, '/');
  return /\s/.test(s) ? `"${s}"` : s;
}
function script(name: string): string {
  return `node ${arg(rootPath('scripts', name))}`;
}

/** The command that checks every enabled source of a pack and writes the probe report strict mode reads. */
export function probeCommand(dir: string, id: string): string {
  return `${script('validate-catalogue.ts')} --pack ${arg(dir)} --probe --pack-id ${id} --json ${arg(join(dir, 'evidence', 'probe-YYYY-MM-DD.json'))}`;
}

// ---------------------------------------------------------------------------------------------
// Strict checks for library packs (validate-catalogue --strict)

const SIGNED_PARAMS = new Set([
  'token',
  'sig',
  'signature',
  'expires',
  'exp',
  'key',
  'auth',
  'hdnts',
  'hdnea',
  'policy',
  'key-pair-id',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp']);

/** Why a URL looks signed or expiring, or null if it doesn't. */
export function signedUrlReason(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  for (const [name, value] of parsed.searchParams) {
    const n = name.toLowerCase();
    if (SIGNED_PARAMS.has(n) || n.startsWith('x-amz-')) return `it has a "${name}" parameter`;
    if (/^[A-Za-z0-9_-]{32,}$/.test(value)) return `its "${name}" parameter looks like a token`;
  }
  return null;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The extra rules for packs published in a library; each problem is one plain-English line. */
export function strictProblems(pack: StationPack): string[] {
  const { meta, dir } = pack;
  const p: string[] = [];
  const at = `Pack "${meta.id}"`;
  if (!meta.version) p.push(`${at}: pack.json needs a "version" (the date it changed, such as 2026.11.03).`);
  if (!meta.owner) p.push(`${at}: pack.json needs an "owner".`);
  if (meta.countries.length === 0) p.push(`${at}: pack.json needs at least one country in "countries".`);
  if (meta.languages.length === 0) p.push(`${at}: pack.json needs at least one language in "languages".`);

  const mdPath = join(dir, PROVENANCE_FILE);
  const md = existsSync(mdPath) ? readFileSync(mdPath, 'utf8') : null;
  if (md === null) p.push(`${at}: ${PROVENANCE_FILE} is missing.`);
  for (const s of pack.sources) {
    if (md !== null && !new RegExp(`(?<![a-z0-9-])${escapeRegExp(s.id)}(?![a-z0-9-])`).test(md))
      p.push(`${at}: source "${s.id}" is not mentioned in ${PROVENANCE_FILE}.`);
    const signed = signedUrlReason(s.url);
    if (signed) p.push(`${at}: the URL of source "${s.id}" looks signed or expiring (${signed}).`);
    if (!s.id.startsWith(`${meta.id}-`) && !s.id.startsWith(`${s.station}-`))
      p.push(`${at}: source ID "${s.id}" must start with "${meta.id}-" or "${s.station}-".`);
  }
  for (const file of walk(dir))
    if (IMAGE_EXTENSIONS.has(extname(file).toLowerCase()))
      p.push(`${at}: packs may not hold images or logos (${file}).`);
  const report = readNewestReport(dir, meta.id);
  if (report === null)
    p.push(
      `${at}: evidence/ needs at least one .json probe report. Write one with: ${probeCommand(dir, meta.id)}`,
    );
  else if (typeof report.problem === 'string') p.push(`${at}: ${report.problem}`);
  else {
    const ids = new Set(pack.sources.map((s) => s.id));
    const ours = report.probes.filter((r) => ids.has(r.sourceId));
    const where = `evidence/${report.name}`;
    if (report.probes.some((r) => r.outcome.failureCode === 'FFMPEG_SPAWN'))
      p.push(
        `${at}: ${where} records that FFmpeg could not run, so it says nothing about the streams. Fix the set-up and run the live check again.`,
      );
    else if (ours.length === 0)
      p.push(
        `${at}: ${where} holds no probe of this pack's sources. Run the live check with --pack-id ${meta.id}: ${probeCommand(dir, meta.id)}`,
      );
    else if (!ours.some((r) => r.outcome.success))
      p.push(
        `${at}: no source played in ${where}. A pack needs at least one source that passed the live check.`,
      );
  }
  return p;
}

/** Reason codes (src/shared/errors.ts) of a failure that usually passes: a timeout or a network fault. */
const TEMPORARY_FAILURES: ReadonlySet<string> = new Set([
  'HTTP_TIMEOUT',
  'PROBE_TIMEOUT',
  'HTTP_ERROR',
  'DNS_FAILED',
]);

/**
 * What to do about an enabled source that failed a live check, by how it failed. A refusal is the
 * host's decision, so the source is switched off. A missing address may be a mount being moved,
 * so it is switched off only if a check at least 7 days later finds it still gone. A timeout, a
 * server error (HTTP 5xx) or a network fault usually passes, and the bot backs off and pauses a
 * source that keeps failing by itself, so the source stays on and is checked again another day.
 */
export function failureAdvice(code: string | null | undefined, detail?: string | null): string {
  const status = Number(/\bHTTP (\d{3})\b/.exec(detail ?? '')?.[1] ?? 0);
  if (code === 'ACCESS_DENIED')
    return 'The host refuses access (HTTP 401, 403 or 451): switch it off with that as the reason.';
  if (code === 'NOT_FOUND')
    return 'Nothing is at that address (HTTP 404 or 410): leave it on for now, and switch it off only if it is still gone in a check at least 7 days later.';
  if (TEMPORARY_FAILURES.has(code ?? '') || (code === 'HTTP_STATUS' && status >= 500))
    return 'This is usually temporary (a timeout, a server error or a network fault): leave it on and check it again another day. The bot backs off from a source that keeps failing by itself.';
  return 'Find out why. If it can’t play, switch it off with the reason; otherwise check it again.';
}

/** Things worth a look in a library pack that don't stop it being published. */
export function strictWarnings(pack: StationPack): string[] {
  const report = readNewestReport(pack.dir, pack.meta.id);
  if (report === null || typeof report.problem === 'string') return [];
  const enabled = new Set(pack.sources.filter((s) => s.enabled).map((s) => s.id));
  return report.probes
    .filter((r) => enabled.has(r.sourceId) && !r.outcome.success)
    .map(
      (r) =>
        `Pack "${pack.meta.id}": source "${r.sourceId}" is enabled but failed the live check in evidence/${report.name} (${r.outcome.failureCode ?? 'no code'}). ${failureAdvice(r.outcome.failureCode, r.outcome.failureDetail)}`,
    );
}

const probeReportSchema = z.object({
  probes: z.array(
    z.object({
      sourceId: z.string(),
      outcome: z.object({
        success: z.boolean(),
        failureCode: z.string().nullable().optional(),
        failureDetail: z.string().nullable().optional(),
      }),
    }),
  ),
});
type ProbeReport = z.infer<typeof probeReportSchema>;

/** A pack's newest evidence/*.json file (latest date in its name, then name), read as a probe report. */
function readNewestReport(
  dir: string,
  id: string,
): ({ name: string; problem?: undefined } & ProbeReport) | { name: string; problem: string } | null {
  const evidence = join(dir, 'evidence');
  if (!existsSync(evidence)) return null;
  const key = (f: string) => `${/(\d{4}-\d{2}-\d{2})/.exec(f)?.[1] ?? '0000-00-00'} ${f}`;
  const name = readdirSync(evidence)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .sort((a, b) => key(a).localeCompare(key(b)))
    .at(-1);
  if (name === undefined) return null;
  try {
    return { name, ...probeReportSchema.parse(JSON.parse(readFileSync(join(evidence, name), 'utf8'))) };
  } catch {
    return {
      name,
      problem: `evidence/${name} is not a probe report: write one with ${probeCommand(dir, id)}`,
    };
  }
}

// ---------------------------------------------------------------------------------------------
// build-library

const ownerSchema = z.object({
  name: z.string().min(1).max(100),
  kind: z.enum(PACK_OWNER_KINDS),
  brand: z.string().min(1).max(100).nullable().default(null),
});

const withdrawnSchema = z.object({
  schemaVersion: z.literal(1),
  packs: z.array(
    z.object({
      id: z.string().regex(PACK_ID),
      reason: z.string().min(1).max(300),
      date: z.string().regex(DATE),
      name: z.string().min(1).max(80),
      description: z.string().max(500).optional(),
      version: z.string().regex(PACK_VERSION).optional(),
      owner: ownerSchema.nullable().optional(),
      countries: z.array(z.string().regex(/^[A-Z]{2}$/)).optional(),
      regions: z.array(z.string().max(60)).optional(),
      languages: z.array(z.string().max(20)).optional(),
      stations: z.number().int().min(0).optional(),
      sources: z.number().int().min(0).optional(),
      minBotVersion: z.string().max(20).nullable().optional(),
    }),
  ),
});

const collectionFileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/),
  name: z.string().min(1).max(80),
  description: z.string().max(300).default(''),
  packs: z.array(z.string().regex(PACK_ID)).max(500),
});

function zodProblem(where: string, err: z.ZodError): string {
  const i = err.issues[0]!;
  return `${where} is not valid: ${i.path.join('.') || '(root)'}: ${i.message}`;
}

export interface BuildLibraryOptions {
  packsRoot: string;
  outDir: string;
  baseUrl: string;
  collectionsDir?: string | null;
  withdrawnFile?: string | null;
  now?: Date;
  /** The largest index allowed (MAX_INDEX_BYTES, what a bot accepts); tests pass a smaller one. */
  maxIndexBytes?: number;
}

/** The newest `YYYY-MM-DD` date in the names of a pack's evidence/*.json files, if any. */
export function lastCheckedDate(dir: string): string | null {
  const evidence = join(dir, 'evidence');
  if (!existsSync(evidence)) return null;
  const dates = readdirSync(evidence)
    .filter((f) => f.toLowerCase().endsWith('.json'))
    .map((f) => /(\d{4}-\d{2}-\d{2})/.exec(f)?.[1])
    .filter((d): d is string => d !== undefined && validDate(d))
    .sort();
  return dates.at(-1) ?? null;
}

/** Writes a library's bundles and index.json from a folder of pack folders. */
export function buildLibrary(opts: BuildLibraryOptions): { index: LibraryIndex; files: string[] } {
  const packsRoot = resolve(opts.packsRoot);
  const outDir = resolve(opts.outDir);
  const base = opts.baseUrl.endsWith('/') ? opts.baseUrl : `${opts.baseUrl}/`;
  const problems: string[] = [];
  if (!existsSync(packsRoot)) throw new AuthorError(`${packsRoot} does not exist.`);

  for (const name of readdirSync(packsRoot)) {
    const p = join(packsRoot, name);
    if (name.startsWith('.') || name.startsWith('_') || !statSync(p).isDirectory()) continue;
    if (!existsSync(join(p, 'pack.json'))) problems.push(`${p} has no pack.json.`);
  }

  const loaded: StationPack[] = [];
  for (const dir of discoverPackDirs(packsRoot)) {
    let pack: StationPack;
    try {
      pack = loadPack(dir, 'installed');
    } catch (err) {
      problems.push((err as Error).message);
      continue;
    }
    if (basename(dir) !== pack.meta.id)
      problems.push(`${dir}: the folder must be named after the pack ID ("${pack.meta.id}").`);
    if (!pack.meta.version) problems.push(`${dir}: pack.json needs a "version".`);
    const conflict = packConflict(loaded, pack);
    if (conflict) problems.push(conflict);
    loaded.push(pack);
  }

  let withdrawn: z.infer<typeof withdrawnSchema>['packs'] = [];
  const defaultWithdrawn = join(packsRoot, '..', 'withdrawn.json');
  const withdrawnFile = opts.withdrawnFile
    ? resolve(opts.withdrawnFile)
    : existsSync(defaultWithdrawn)
      ? defaultWithdrawn
      : null;
  if (withdrawnFile) {
    const r = withdrawnSchema.safeParse(readJsonFile(withdrawnFile));
    if (!r.success) problems.push(zodProblem(withdrawnFile, r.error));
    else withdrawn = r.data.packs;
  }
  const available = new Set(loaded.map((p) => p.meta.id));
  const withdrawnIds = new Set<string>();
  for (const w of withdrawn) {
    if (available.has(w.id))
      problems.push(`"${w.id}" is in ${withdrawnFile} but its pack folder is still there.`);
    if (withdrawnIds.has(w.id)) problems.push(`"${w.id}" is in ${withdrawnFile} twice.`);
    withdrawnIds.add(w.id);
  }
  if (problems.length) throw new AuthorError(problems.join('\n'));

  const entries: LibraryPack[] = [];
  const bundles: Array<{ id: string; path: string; bytes: Buffer; sha256: string }> = [];
  for (const pack of loaded) {
    const [packJson, stationsJson, sourcesJson] = PACK_FILE_NAMES.map((n) => {
      const p = join(pack.dir, n);
      return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as unknown) : undefined;
    });
    const bundle = { schemaVersion: 1, pack: packJson, stations: stationsJson, sources: sourcesJson };
    const bytes = Buffer.from(JSON.stringify(bundle), 'utf8');
    if (bytes.length > MAX_BUNDLE_BYTES) {
      problems.push(`Pack "${pack.meta.id}" is too large for a library (${bytes.length} bytes).`);
      continue;
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const m = pack.meta;
    bundles.push({ id: m.id, path: join(outDir, `${m.id}.json`), bytes, sha256 });
    entries.push({
      id: m.id,
      name: m.name,
      description: m.description,
      version: m.version!,
      owner: m.owner,
      countries: m.countries,
      regions: m.regions,
      languages: m.languages,
      stations: pack.stations.length,
      sources: pack.sources.length,
      lastChecked: lastCheckedDate(pack.dir) ?? m.snapshotDate ?? null,
      minBotVersion: m.minBotVersion,
      status: 'available',
      withdrawnReason: null,
      file: `${base}${m.id}.json`,
      sha256,
      bytes: bytes.length,
    });
  }
  for (const w of withdrawn) {
    entries.push({
      id: w.id,
      name: w.name,
      description: w.description ?? '',
      version: w.version ?? w.date.replace(/-/g, '.'),
      owner: w.owner ?? null,
      countries: w.countries ?? [],
      regions: w.regions ?? [],
      languages: w.languages ?? [],
      stations: w.stations ?? 0,
      sources: w.sources ?? 0,
      lastChecked: null,
      minBotVersion: w.minBotVersion ?? null,
      status: 'withdrawn',
      withdrawnReason: w.reason,
      file: null,
      sha256: null,
      bytes: null,
    });
  }
  entries.sort((a, b) => a.id.localeCompare(b.id));

  const collections: LibraryCollection[] = [];
  if (opts.collectionsDir) {
    const cdir = resolve(opts.collectionsDir);
    if (!existsSync(cdir)) problems.push(`${cdir} does not exist.`);
    else {
      for (const f of readdirSync(cdir)
        .filter((x) => x.endsWith('.json'))
        .sort()) {
        const where = join(cdir, f);
        const r = collectionFileSchema.safeParse(readJsonFile(where));
        if (!r.success) {
          problems.push(zodProblem(where, r.error));
          continue;
        }
        for (const id of r.data.packs)
          if (!available.has(id)) problems.push(`${where}: "${id}" is not an available pack.`);
        collections.push(r.data);
      }
    }
  }
  const countries = [...new Set(loaded.flatMap((p) => p.meta.countries))];
  const byCountry = countries
    .map((code) => {
      const name = countryName(code);
      return {
        id: `country-${code.toLowerCase()}`,
        name,
        description: `${name}: every pack with stations there.`,
        packs: loaded
          .filter((p) => p.meta.countries.includes(code))
          .map((p) => p.meta.id)
          .sort(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const c of byCountry) {
    if (collections.some((x) => x.id === c.id))
      problems.push(`The collection ID "${c.id}" is reserved for the automatic country collection.`);
    collections.push(c);
  }
  const ids = new Set<string>();
  for (const c of collections) {
    if (ids.has(c.id)) problems.push(`Two collections use the ID "${c.id}".`);
    ids.add(c.id);
  }

  const index = {
    schemaVersion: 1 as const,
    generatedAt: (opts.now ?? new Date()).toISOString(),
    packs: entries,
    collections,
  };
  const checked = libraryIndexSchema.safeParse(index);
  if (!checked.success) problems.push(zodProblem('The library index', checked.error));
  // A bot refuses an index larger than this, so a library that outgrew it would install nothing.
  const indexText = `${JSON.stringify(index, null, 2)}\n`;
  const indexBytes = Buffer.byteLength(indexText, 'utf8');
  const maxIndexBytes = opts.maxIndexBytes ?? MAX_INDEX_BYTES;
  if (indexBytes > maxIndexBytes)
    problems.push(
      `The library index would be ${indexBytes} bytes, more than the ${maxIndexBytes} a bot accepts. Shorten descriptions, or split the library.`,
    );
  if (problems.length) throw new AuthorError(problems.join('\n'));

  mkdirSync(outDir, { recursive: true });
  const files: string[] = [];
  for (const b of bundles) {
    writeFileSync(b.path, b.bytes);
    try {
      checkBundle(readFileSync(b.path), { id: b.id, sha256: b.sha256 });
    } catch (err) {
      throw new AuthorError(`The bundle for "${b.id}" did not pass its own check: ${(err as Error).message}`);
    }
    files.push(b.path);
  }
  const indexPath = join(outDir, 'index.json');
  writeFileSync(indexPath, indexText);
  files.push(indexPath);
  return { index: checked.data!, files };
}

// ---------------------------------------------------------------------------------------------
// diff-check

/** What is wrong with changing a pack from `oldDir` to `newDir` (empty when the change is fine). */
export function diffCheck(oldDir: string, newDir: string): { problems: string[]; notes: string[] } {
  const problems: string[] = [];
  const notes: string[] = [];
  if (!existsSync(join(newDir, 'pack.json'))) {
    problems.push(
      `${newDir} has no pack.json. Packs are never deleted: withdraw one in withdrawn.json instead.`,
    );
    return { problems, notes };
  }
  let next: StationPack;
  try {
    next = loadPack(newDir);
  } catch (err) {
    return { problems: [(err as Error).message], notes };
  }
  if (!next.meta.version) problems.push(`Pack "${next.meta.id}": pack.json needs a "version".`);
  if (!existsSync(join(oldDir, 'pack.json'))) {
    notes.push(`"${next.meta.id}" is a new pack.`);
    return { problems, notes };
  }
  let prev: StationPack;
  try {
    prev = loadPack(oldDir);
  } catch (err) {
    return { problems: [...problems, `The old pack could not be read: ${(err as Error).message}`], notes };
  }
  const id = prev.meta.id;
  if (next.meta.id !== id)
    problems.push(`The pack ID changed from "${id}" to "${next.meta.id}". Pack IDs are permanent.`);
  const slugs = new Set(next.stations.map((s) => s.slug));
  for (const s of prev.stations)
    if (!slugs.has(s.slug))
      problems.push(
        `Station "${s.slug}" was removed. Stations are never removed: set catalogueStatus to "retired".`,
      );
  const sourceIds = new Set(next.sources.map((s) => s.id));
  for (const s of prev.sources)
    if (!sourceIds.has(s.id))
      problems.push(
        `Source "${s.id}" was removed. Sources are never removed: set enabled to false with a disabledReason.`,
      );
  if (prev.contentHash === next.contentHash) notes.push(`Pack "${id}" is unchanged.`);
  else if (next.meta.version) {
    if (prev.meta.version && compareVersions(next.meta.version, prev.meta.version) <= 0)
      problems.push(
        `Pack "${id}" changed but its version did not go up (${prev.meta.version} → ${next.meta.version}). Set it to today's date, such as ${todayVersion()}.`,
      );
    else notes.push(`Pack "${id}" changed: version ${prev.meta.version ?? 'none'} → ${next.meta.version}.`);
  }
  return { problems, notes };
}

/**
 * The version of the pack in `dir` as it is in git at `ref` (such as origin/main), or null when the
 * pack isn't there: a pack that has never been published.
 */
export function publishedVersion(dir: string, ref: string): { version: string | null } {
  const r = spawnSync('git', ['-C', dir, 'show', `${ref}:./pack.json`], { encoding: 'utf8' });
  if (r.status === 0) {
    try {
      const v = (JSON.parse(r.stdout) as Json).version;
      return { version: typeof v === 'string' ? v : null };
    } catch {
      throw new AuthorError(`pack.json at ${ref} could not be read.`);
    }
  }
  if (/does not exist in|exists on disk, but not in/.test(r.stderr ?? '')) return { version: null };
  throw new AuthorError(
    `Could not read the published pack from git at "${ref}": ${(r.stderr || r.error?.message || 'git failed').trim()}`,
  );
}

// ---------------------------------------------------------------------------------------------
// CLI

const USAGE = `Usage:
  node scripts/pack-author.ts new <pack-id> [--root <folder>] [--ids <pack-ids.json>]
  node scripts/pack-author.ts export <pack-dir> [--force]
  node scripts/pack-author.ts generate <pack-dir> [--base <git-ref>]
  node scripts/pack-author.ts build-library <packs-root> <out-dir> --base-url <url> [--collections <dir>] [--withdrawn <file>]
  node scripts/pack-author.ts diff-check <old-pack-dir> <new-pack-dir>
`;

function parseArgs(
  args: readonly string[],
  positionals: number,
  options: readonly string[],
  flags: readonly string[] = [],
): { pos: string[]; opt: Map<string, string>; flag: Set<string> } {
  const pos: string[] = [];
  const opt = new Map<string, string>();
  const flag = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (flags.includes(a)) flag.add(a);
    else if (a.startsWith('--')) {
      if (!options.includes(a)) throw new AuthorError(`Unknown option ${a}.\n${USAGE}`);
      const v = args[i + 1];
      if (v === undefined || v.startsWith('--')) throw new AuthorError(`${a} needs a value.`);
      opt.set(a, v);
      i++;
    } else pos.push(a);
  }
  if (pos.length !== positionals) throw new AuthorError(USAGE);
  return { pos, opt, flag };
}

export function main(argv: readonly string[]): number {
  const out = (s: string) => process.stdout.write(`${s}\n`);
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'new': {
        const { pos, opt } = parseArgs(rest, 1, ['--root', '--ids']);
        const r = newPack(pos[0]!, { root: opt.get('--root'), idsFile: opt.get('--ids') ?? null });
        out(`Created the pack folder ${r.dir}.\n\nNext steps:`);
        for (const [i, s] of r.nextSteps.entries()) out(`  ${i + 1}. ${s}`);
        return 0;
      }
      case 'export': {
        const { pos, flag } = parseArgs(rest, 1, [], ['--force']);
        const r = writeIntake(resolve(pos[0]!), { force: flag.has('--force') });
        out(`Wrote ${r.path}: ${r.rows} rows.`);
        return 0;
      }
      case 'generate': {
        const { pos, opt } = parseArgs(rest, 1, ['--base']);
        const dir = resolve(pos[0]!);
        const base = opt.get('--base');
        const r = generatePack(dir, { published: base ? publishedVersion(dir, base) : undefined });
        for (const w of r.warnings) out(`Warning: ${w}`);
        if (r.addedStations.length) out(`New stations: ${r.addedStations.join(', ')}`);
        if (r.addedSources.length) out(`New sources: ${r.addedSources.join(', ')}`);
        for (const n of r.renamedStations) out(`Renamed (old name kept as an alias): ${n}`);
        if (r.updatedStations || r.updatedSources)
          out(`Updated ${r.updatedStations} stations and ${r.updatedSources} sources.`);
        out(
          r.changed
            ? `The pack changed; its version is now ${r.version}.`
            : 'The stations and sources are unchanged.',
        );
        for (const f of r.written) out(`Wrote ${f}`);
        return 0;
      }
      case 'build-library': {
        const { pos, opt } = parseArgs(rest, 2, ['--base-url', '--collections', '--withdrawn']);
        const baseUrl = opt.get('--base-url');
        if (!baseUrl) throw new AuthorError(`--base-url is required.\n${USAGE}`);
        const r = buildLibrary({
          packsRoot: pos[0]!,
          outDir: pos[1]!,
          baseUrl,
          collectionsDir: opt.get('--collections') ?? null,
          withdrawnFile: opt.get('--withdrawn') ?? null,
        });
        const available = r.index.packs.filter((p) => p.status === 'available').length;
        out(
          `Built the library in ${resolve(pos[1]!)}: ${available} packs, ${r.index.packs.length - available} withdrawn, ${r.index.collections.length} collections.`,
        );
        return 0;
      }
      case 'diff-check': {
        const { pos } = parseArgs(rest, 2, []);
        const r = diffCheck(resolve(pos[0]!), resolve(pos[1]!));
        for (const n of r.notes) out(n);
        for (const p of r.problems) process.stderr.write(`${p}\n`);
        return r.problems.length ? 1 : 0;
      }
      default:
        process.stderr.write(USAGE);
        return 1;
    }
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}

// Run as a command, not when imported (by validate-catalogue.ts or the tests). Paths are compared
// ignoring case because Windows doesn't keep the drive letter's case consistent.
const invoked = resolve(process.argv[1] ?? '.').toLowerCase();
if (invoked === fileURLToPath(import.meta.url).toLowerCase()) process.exitCode = main(process.argv.slice(2));
