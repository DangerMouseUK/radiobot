/**
 * Official-list adapters for pack synchronisation (FR-002). An adapter turns the text of a
 * pack's `sync.url` into station names and stable IDs. Adapters read names only; they never
 * harvest stream URLs. To support a new station group's official list, add a function here
 * and reference its key from that pack's pack.json.
 */

export interface OfficialEntry {
  externalId: string | null;
  name: string;
}

export type SyncAdapter = (text: string) => OfficialEntry[];

/** Extracts one JSON value starting at `start` by bracket matching (string-aware). */
export function extractJsonValue(text: string, start: number): string | null {
  const open = text[start];
  if (open !== '{' && open !== '[') return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));

/**
 * radiofg.com webradio list. Reads only `webradios[].label` and `.id` from the page's
 * `var apidata` object; the short-lived signed play URLs on the same page are ignored and
 * never stored. Falls back to the header dropdown markup.
 */
export function parseRadioFgApidata(html: string): OfficialEntry[] {
  const marker = html.indexOf('var apidata');
  if (marker >= 0) {
    const brace = html.indexOf('{', marker);
    const json = brace >= 0 ? extractJsonValue(html, brace) : null;
    if (json) {
      try {
        const data = JSON.parse(json) as {
          webradios?: Array<{ id?: unknown; label?: unknown; displayOnWebsite?: unknown }>;
        };
        const list = (data.webradios ?? [])
          .filter((w) => typeof w.label === 'string' && w.label.trim() && w.displayOnWebsite !== false)
          .map((w) => ({
            externalId: typeof w.id === 'string' ? w.id.slice(0, 64) : null,
            name: decodeEntities(String(w.label)).trim().slice(0, 100),
          }));
        if (list.length > 0) return list;
      } catch {
        /* fall through to HTML parsing */
      }
    }
  }
  const nav = /<nav[^>]*HeaderSources[\s\S]*?<\/nav>/i.exec(html)?.[0] ?? '';
  const names = [...nav.matchAll(/<button[^>]*dropdown-item[^>]*>([^<]{1,100})<\/button>/gi)].map((m) =>
    decodeEntities(m[1]!).trim(),
  );
  return [...new Set(names)].filter(Boolean).map((name) => ({ externalId: null, name }));
}

/**
 * A simple JSON list: `[{ "id": "...", "name": "..." }, ...]` or `{ "stations": [...] }`.
 * Useful for station groups that publish a machine-readable list.
 */
export function parseJsonNameList(text: string): OfficialEntry[] {
  const data = JSON.parse(text) as unknown;
  const list = Array.isArray(data) ? data : (data as { stations?: unknown[] })?.stations;
  if (!Array.isArray(list)) return [];
  return list
    .map((e) => e as { id?: unknown; name?: unknown })
    .filter((e) => typeof e.name === 'string' && e.name.trim())
    .map((e) => ({
      externalId: typeof e.id === 'string' || typeof e.id === 'number' ? String(e.id).slice(0, 64) : null,
      name: String(e.name).trim().slice(0, 100),
    }));
}

export const SYNC_ADAPTERS: Record<string, SyncAdapter> = {
  'radiofg-apidata': parseRadioFgApidata,
  'json-name-list': parseJsonNameList,
};
