/** Lower-cases, strips diacritics and collapses punctuation for matching. */
export function normalizeName(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** URL-safe slug, e.g. "Radio Ibiza Ünïque" -> "radio-ibiza-unique". */
/** Longest station slug; keeps station ids short enough for signed component ids. */
export const MAX_SLUG_LENGTH = 32;

/** Leaves room for a de-duplication suffix such as "-12" within MAX_SLUG_LENGTH. */
export function slugify(input: string): string {
  return normalizeName(input)
    .replace(/\s+/g, '-')
    .slice(0, MAX_SLUG_LENGTH - 4);
}

/** Two rows of the edit-distance table, reused between calls (search compares many names per keystroke). */
let rowA = new Int32Array(64);
let rowB = new Int32Array(64);

/**
 * Edit distance. With `max`, it stops as soon as the distance must exceed `max` and returns
 * `max + 1`: search only needs to know whether a name is close enough.
 */
export function levenshtein(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  if (rowA.length <= b.length) {
    rowA = new Int32Array(b.length + 1);
    rowB = new Int32Array(b.length + 1);
  }
  let prev = rowA;
  let cur = rowB;
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    const t = prev;
    prev = cur;
    cur = t;
  }
  return Math.min(prev[b.length]!, max + 1);
}

/** 0..1 similarity based on edit distance of normalised strings. */
export function similarity(a: string, b: string): number {
  return normalizedSimilarity(normalizeName(a), normalizeName(b));
}

/** `similarity` for names already passed through `normalizeName`. */
export function normalizedSimilarity(na: string, nb: string): number {
  const max = Math.max(na.length, nb.length);
  return max === 0 ? 1 : 1 - levenshtein(na, nb) / max;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = Math.max(0, max - 1);
  // Never split a surrogate pair (an emoji, for example) into an unpaired half.
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut--;
  return `${text.slice(0, cut)}…`;
}
