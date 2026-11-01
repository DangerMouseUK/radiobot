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

/** URL-safe slug, e.g. "FG USHUAÏA IBIZA" -> "fg-ushuaia-ibiza". */
/** Longest station slug; keeps station ids short enough for signed component ids. */
export const MAX_SLUG_LENGTH = 32;

/** Leaves room for a de-duplication suffix such as "-12" within MAX_SLUG_LENGTH. */
export function slugify(input: string): string {
  return normalizeName(input)
    .replace(/\s+/g, '-')
    .slice(0, MAX_SLUG_LENGTH - 4);
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] ?? 0) + 1,
        (cur[j - 1] ?? 0) + 1,
        (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/** 0..1 similarity based on edit distance of normalised strings. */
export function similarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
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
