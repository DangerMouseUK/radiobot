import { normalizeName, similarity } from '../shared/text.ts';
import type { Station } from './types.ts';

export interface SearchHit {
  station: Station;
  score: number;
  /** True for an unambiguous identity match (id, slug, display name or alias). */
  exact: boolean;
}

function words(s: string): string[] {
  return normalizeName(s).split(' ').filter(Boolean);
}

export function scoreStation(station: Station, query: string): SearchHit | null {
  const q = normalizeName(query);
  if (!q) return { station, score: 1, exact: false };
  const raw = query.trim().toLowerCase();
  if (raw === station.id.toLowerCase() || raw === station.slug || q === normalizeName(station.slug)) {
    return { station, score: 1000, exact: true };
  }
  const name = normalizeName(station.displayName);
  const aliases = station.aliases.map(normalizeName);
  if (q === name) return { station, score: 950, exact: true };
  if (aliases.includes(q)) return { station, score: 900, exact: true };
  const tags = station.tags.map(normalizeName);
  const qWords = q.split(' ');
  const nameWords = [...words(station.displayName), ...aliases.flatMap((a) => a.split(' '))];
  let score = 0;
  if (name.startsWith(q)) score = Math.max(score, 700 - (name.length - q.length));
  if (qWords.every((w) => nameWords.some((nw) => nw.startsWith(w))))
    score = Math.max(score, 600 - name.length);
  if (tags.includes(q)) score = Math.max(score, 500);
  if (qWords.every((w) => tags.some((t) => t.split(' ').some((tw) => tw.startsWith(w)))))
    score = Math.max(score, 420);
  if (name.includes(q)) score = Math.max(score, 400);
  if (station.category && normalizeName(station.category).includes(q)) score = Math.max(score, 350);
  const sim = Math.max(similarity(q, name), ...aliases.map((a) => similarity(q, a)), 0);
  if (sim >= 0.6) score = Math.max(score, Math.round(300 * sim));
  return score > 0 ? { station, score, exact: false } : null;
}

/** Ranked, partial/fuzzy station search (FR-001). Pack stations sort before custom ones on ties. */
export function searchStations(stations: Station[], query: string, limit = 25): SearchHit[] {
  return stations
    .map((s) => scoreStation(s, query))
    .filter((h): h is SearchHit => h !== null)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(a.station.provider === 'custom') - Number(b.station.provider === 'custom') ||
        a.station.sortOrder - b.station.sortOrder ||
        a.station.displayName.localeCompare(b.station.displayName),
    )
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
  const hits = searchStations(stations, query, 10);
  if (hits.length === 0) return { kind: 'none' };
  const exact = hits.filter((h) => h.exact);
  if (exact.length >= 1) {
    const top = exact[0]!;
    if (exact.length === 1 || exact[1]!.score < top.score) return { kind: 'match', station: top.station };
    return { kind: 'ambiguous', candidates: exact.map((h) => h.station) };
  }
  // A single name/word match that clearly dominates everything else (e.g. "ushuaia ibiza").
  const [top, next] = hits;
  if (top && top.score >= 500 && (!next || next.score < 450)) return { kind: 'match', station: top.station };
  return { kind: 'ambiguous', candidates: hits.slice(0, 10).map((h) => h.station) };
}
