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

const NAMED_ENTITIES: Record<string, string> = { amp: '&', apos: "'", quot: '"', lt: '<', gt: '>' };

/**
 * Decodes the few HTML entities found in station names, in a single pass so that decoded
 * text is never decoded again (`&amp;quot;` is `&quot;`, not `"`). Numeric entities outside
 * the Unicode range are left as they are.
 */
export const decodeEntities = (s: string): string =>
  s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(amp|apos|quot|lt|gt));/gi, (entity, dec, hex, name) => {
    if (name) return NAMED_ENTITIES[(name as string).toLowerCase()]!;
    const code = dec ? Number(dec) : Number.parseInt(hex as string, 16);
    return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });

/**
 * A webradio list embedded in a station website's page. Reads only `webradios[].label` and
 * `.id` from the page's
 * `var apidata` object; the short-lived signed play URLs on the same page are ignored and
 * never stored. Falls back to the header dropdown markup.
 */
export function parseWebradioApidata(html: string): OfficialEntry[] {
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
  'webradio-apidata': parseWebradioApidata,
  'json-name-list': parseJsonNameList,
};

/**
 * Whether `name` is one of the adapters above. Only their own keys count: a name such as
 * `constructor` or `toString` is found on every object, but it isn't an adapter.
 */
export function isSyncAdapter(name: string): boolean {
  return Object.hasOwn(SYNC_ADAPTERS, name);
}

export interface ParseRequest {
  adapter: string;
  bytes: Uint8Array;
  /** Entries beyond this are not returned (one more is, so the caller can tell the list was too long). */
  maxEntries: number;
}

export type ParseReply = { ok: true; entries: OfficialEntry[] } | { ok: false; error: string };

/**
 * Decodes a fetched list and runs its adapter. This is what the sync's worker thread does (see
 * sync-parse-worker.ts): it never throws, and returns only names and IDs.
 */
export function parseOfficialList(req: ParseRequest): ParseReply {
  try {
    const adapter = isSyncAdapter(req.adapter) ? SYNC_ADAPTERS[req.adapter] : undefined;
    if (!adapter) throw new Error(`Unknown sync adapter "${req.adapter}".`);
    const text = Buffer.from(req.bytes.buffer, req.bytes.byteOffset, req.bytes.byteLength).toString('utf8');
    const entries = adapter(text).slice(0, req.maxEntries + 1);
    return { ok: true, entries: entries.map((e) => ({ externalId: e.externalId, name: e.name })) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
