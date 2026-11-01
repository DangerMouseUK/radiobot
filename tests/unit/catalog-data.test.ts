import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILTIN_PACKS_DIR, discoverPackDirs, loadPack, PackRegistry } from '../../src/catalogue/packs.ts';
import { ComponentIds } from '../../src/discord/components/custom-id.ts';

/**
 * Data checks on the shipped packs, read straight from the JSON (independent of the loader),
 * so a bad edit to catalog/packs is caught even where the schema is permissive.
 */
interface RawStation {
  slug: string;
  displayName: string;
  category?: string | null;
  order: number;
}
interface RawSource {
  id: string;
  station: string;
  url: string;
  transportHint?: string | null;
  enabled?: boolean;
  disabledReason?: string | null;
  provenance: string;
  provenanceDetail: string;
}

const packDirs = discoverPackDirs(BUILTIN_PACKS_DIR());
const read = <T>(dir: string, file: string): T => JSON.parse(readFileSync(join(dir, file), 'utf8')) as T;

describe('built-in packs', () => {
  it('ship at least the FG pack and load together without conflicts', () => {
    expect(packDirs.map((d) => d.split(/[\\/]/).pop())).toContain('fg');
    const registry = new PackRegistry(packDirs.map(loadPack));
    expect(registry.enabledPacks().length).toBeGreaterThan(0);
  });
});

describe.each(packDirs.map((d) => [d.split(/[\\/]/).pop()!, d]))('pack data: %s', (_name, dir) => {
  const meta = read<{ id: string; categories: Array<{ id: string }>; snapshotDate: string | null }>(
    dir,
    'pack.json',
  );
  const stations = read<{ stations: RawStation[] }>(dir, 'stations.json').stations;
  const sources = read<{ sources: RawSource[] }>(dir, 'sources.json').sources;
  const slugs = new Set(stations.map((s) => s.slug));

  it('has unique station slugs and unique station order values', () => {
    expect(slugs.size).toBe(stations.length);
    expect(new Set(stations.map((s) => s.order)).size).toBe(stations.length);
  });

  it('has unique source ids and URLs, each source pointing at an existing station', () => {
    expect(new Set(sources.map((s) => s.id)).size).toBe(sources.length);
    expect(new Set(sources.map((s) => s.url)).size).toBe(sources.length);
    for (const s of sources) {
      expect(slugs.has(s.station), s.id).toBe(true);
      expect(s.id.startsWith(`${s.station}-`), `${s.id} is named after its station`).toBe(true);
    }
  });

  it('gives every station at least one enabled source', () => {
    const withEnabled = new Set(sources.filter((s) => s.enabled !== false).map((s) => s.station));
    expect(stations.filter((s) => !withEnabled.has(s.slug)).map((s) => s.slug)).toEqual([]);
  });

  it('uses https and records provenance for every source', () => {
    for (const s of sources) {
      expect(s.url.startsWith('https://'), s.id).toBe(true);
      expect(['official-player', 'curated']).toContain(s.provenance);
      expect(s.provenanceDetail.trim().length, s.id).toBeGreaterThan(10);
    }
  });

  it('explains every disabled source and only disabled ones', () => {
    for (const s of sources) {
      if (s.enabled === false) expect(s.disabledReason?.trim(), s.id).toBeTruthy();
      else expect(s.disabledReason ?? null, s.id).toBeNull();
    }
  });

  it('labels enabled HLS sources as HLS and direct sources as direct', () => {
    for (const s of sources.filter((x) => x.enabled !== false)) {
      const isPlaylist = /\.m3u8(\?|$)/.test(s.url);
      expect(s.transportHint === 'hls', s.id).toBe(isPlaylist);
    }
  });

  it('declares every category it uses and uses every category it declares', () => {
    const declared = new Set(meta.categories.map((c) => c.id));
    const used = new Set(stations.map((s) => s.category).filter((c): c is string => Boolean(c)));
    expect([...used].filter((c) => !declared.has(c))).toEqual([]);
    expect([...declared].filter((c) => !used.has(c))).toEqual([]);
  });

  it('keeps station ids short enough for signed button ids', () => {
    // Station ids travel in component custom ids (Favourite, Sources, Inspect, Re-scan buttons).
    const ids = new ComponentIds('secret');
    for (const s of stations) {
      const id = `${meta.id}:${s.slug}`;
      for (const action of ['fav', 'srcs', 'insp', 'rescan', 'play']) {
        for (const ttl of [15 * 60_000, null]) {
          const custom = ids.make('123456789012345678', action, id, ttl);
          expect(ids.parse('123456789012345678', custom)).toEqual({ action, arg: id, expired: false });
        }
      }
    }
  });
});

describe.each(
  packDirs.flatMap((dir) => {
    const evDir = join(dir, 'evidence');
    return existsSync(evDir)
      ? readdirSync(evDir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => [`${basename(dir)}/${f}`, dir, f] as const)
      : [];
  }),
)('probe evidence %s', (_name, dir, file) => {
  const meta = read<{ id: string }>(dir, 'pack.json');
  const sources = new Map(
    read<{ sources: RawSource[] }>(dir, 'sources.json').sources.map((s) => [s.id, `${meta.id}:${s.station}`]),
  );
  const evidence = read<{
    generatedAt: string;
    probes: Array<{ stationId: string; sourceId: string }>;
    comparisons?: Array<{ stationId: string; a: string; b: string }>;
  }>(join(dir, 'evidence'), file);

  it('refers only to sources that exist, under the right station', () => {
    expect(Number.isNaN(Date.parse(evidence.generatedAt))).toBe(false);
    expect(evidence.probes.length).toBeGreaterThan(0);
    for (const p of evidence.probes) expect(sources.get(p.sourceId), p.sourceId).toBe(p.stationId);
    for (const c of evidence.comparisons ?? []) {
      expect(sources.get(c.a), c.a).toBe(c.stationId);
      expect(sources.get(c.b), c.b).toBe(c.stationId);
    }
  });
});
