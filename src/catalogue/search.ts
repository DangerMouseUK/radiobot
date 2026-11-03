import { compareText, levenshtein, normalizeName } from '../shared/text.ts';
import type { Station } from './types.ts';

export interface SearchHit {
  station: Station;
  score: number;
  /** True for an unambiguous identity match (id, slug, display name or alias). */
  exact: boolean;
}

/** A station's names, normalised once. */
interface Prepared {
  id: string;
  slug: string;
  name: string;
  aliases: string[];
  nameWords: string[];
  tags: string[];
  tagWords: string[][];
  category: string | null;
}

/**
 * Station rows are shared and read-only (the repository caches them until the next write), so
 * each one's normalised names are worked out once, not on every keystroke of a suggestion.
 */
const prepared = new WeakMap<Station, Prepared>();

function prepare(station: Station): Prepared {
  let p = prepared.get(station);
  if (!p) {
    const name = normalizeName(station.displayName);
    const aliases = station.aliases.map(normalizeName);
    const tags = station.tags.map(normalizeName);
    p = {
      id: station.id.toLowerCase(),
      slug: normalizeName(station.slug),
      name,
      aliases,
      nameWords: [...name.split(' ').filter(Boolean), ...aliases.flatMap((a) => a.split(' '))],
      tags,
      tagWords: tags.map((t) => t.split(' ')),
      category: station.category ? normalizeName(station.category) : null,
    };
    prepared.set(station, p);
  }
  return p;
}

/**
 * Works out the stations' normalised names ahead of the first search: a few milliseconds for a
 * couple of thousand stations, which start-up pays rather than a listener while a stream plays.
 */
export function prepareStations(stations: readonly Station[]): void {
  for (const s of stations) prepare(s);
}

/** Edit-distance similarity of two already-normalised strings; null when it can't reach `min`. */
function similarityAtLeast(a: string, b: string, min: number): number | null {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  // The distance is at least the difference in length, so most names are ruled out without it.
  if (1 - Math.abs(a.length - b.length) / max < min) return null;
  const sim = 1 - levenshtein(a, b, Math.floor((1 - min) * max + 1e-9)) / max;
  return sim >= min ? sim : null;
}

/** An exact identity match (ID, slug, name or alias), or null. */
function exactScore(station: Station, q: string, raw: string): SearchHit | null {
  const p = prepare(station);
  if (raw === p.id || raw === station.slug || q === p.slug) return { station, score: 1000, exact: true };
  if (q === p.name) return { station, score: 950, exact: true };
  if (p.aliases.includes(q)) return { station, score: 900, exact: true };
  return null;
}

/** Ties: pack stations before custom ones, then catalogue order, then name. */
function rankTie(a: SearchHit, b: SearchHit): number {
  return (
    Number(a.station.provider === 'custom') - Number(b.station.provider === 'custom') ||
    a.station.sortOrder - b.station.sortOrder ||
    compareText(a.station.displayName, b.station.displayName)
  );
}

function score(station: Station, q: string, raw: string): SearchHit | null {
  if (!q) return { station, score: 1, exact: false };
  const exact = exactScore(station, q, raw);
  if (exact) return exact;
  const p = prepare(station);
  const qWords = q.split(' ');
  let score = 0;
  if (p.name.startsWith(q)) score = Math.max(score, 700 - (p.name.length - q.length));
  if (qWords.every((w) => p.nameWords.some((nw) => nw.startsWith(w))))
    score = Math.max(score, 600 - p.name.length);
  if (p.tags.includes(q)) score = Math.max(score, 500);
  if (qWords.every((w) => p.tagWords.some((tw) => tw.some((x) => x.startsWith(w)))))
    score = Math.max(score, 420);
  if (p.name.includes(q)) score = Math.max(score, 400);
  if (p.category?.includes(q)) score = Math.max(score, 350);
  let sim = similarityAtLeast(q, p.name, 0.6) ?? 0;
  for (const a of p.aliases) sim = Math.max(sim, similarityAtLeast(q, a, 0.6) ?? 0);
  if (sim >= 0.6) score = Math.max(score, Math.round(300 * sim));
  return score > 0 ? { station, score, exact: false } : null;
}

export function scoreStation(station: Station, query: string): SearchHit | null {
  return score(station, normalizeName(query), query.trim().toLowerCase());
}

/** Ranked, partial/fuzzy station search (FR-001). Pack stations sort before custom ones on ties. */
export function searchStations(stations: Station[], query: string, limit = 25): SearchHit[] {
  const q = normalizeName(query);
  const raw = query.trim().toLowerCase();
  return stations
    .map((s) => score(s, q, raw))
    .filter((h): h is SearchHit => h !== null)
    .sort((a, b) => b.score - a.score || rankTie(a, b))
    .slice(0, limit);
}

export type Resolution =
  | { kind: 'match'; station: Station }
  | { kind: 'ambiguous'; candidates: Station[] }
  | { kind: 'none' };

/**
 * Resolves user input to exactly one station or refuses. Similar names are never resolved
 * silently (e.g. "jazz" does not pick Jazz FM over Jazz FM Classics): only exact identity
 * matches, or a single clearly dominant hit, are accepted.
 */
export function resolveStation(stations: Station[], query: string): Resolution {
  // A name typed or picked exactly is the common case: settle it without fuzzy-scoring every
  // station. Exact hits (900+) always outrank fuzzy ones (700 at most), so the outcome is the same.
  const q = normalizeName(query);
  const raw = query.trim().toLowerCase();
  if (q) {
    const exact = stations
      .map((s) => exactScore(s, q, raw))
      .filter((h): h is SearchHit => h !== null)
      .sort((a, b) => b.score - a.score || rankTie(a, b));
    if (exact.length >= 1) {
      const top = exact[0]!;
      if (exact.length === 1 || exact[1]!.score < top.score) return { kind: 'match', station: top.station };
      return { kind: 'ambiguous', candidates: exact.slice(0, 10).map((h) => h.station) };
    }
  }
  const hits = searchStations(stations, query, 10);
  if (hits.length === 0) return { kind: 'none' };
  const exact = hits.filter((h) => h.exact);
  if (exact.length >= 1) {
    const top = exact[0]!;
    if (exact.length === 1 || exact[1]!.score < top.score) return { kind: 'match', station: top.station };
    return { kind: 'ambiguous', candidates: exact.map((h) => h.station) };
  }
  // A single name/word match that clearly dominates everything else (e.g. "my station").
  const [top, next] = hits;
  if (top && top.score >= 500 && (!next || next.score < 450)) return { kind: 'match', station: top.station };
  return { kind: 'ambiguous', candidates: hits.slice(0, 10).map((h) => h.station) };
}
