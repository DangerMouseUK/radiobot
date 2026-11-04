import { describe, expect, it, vi } from 'vitest';
import { CustomStationService } from '../../src/catalogue/custom-provider.ts';
import type { StationSource } from '../../src/catalogue/types.ts';
import { RadioError } from '../../src/shared/errors.ts';
import type { ProbeReport, SourceService } from '../../src/streams/source-service.ts';
import { UrlPolicy } from '../../src/streams/url-policy.ts';
import { memoryDb } from '../helpers.ts';

const G = '123456789012345678';

/** A SourceService stand-in: no network, outcome chosen per URL. */
function setup(opts: { maxPerGuild?: number; failUrls?: string[]; throwUrls?: string[] } = {}) {
  const repos = memoryDb();
  const probed: string[] = [];
  const sources = {
    probe: async (sourceId: string): Promise<ProbeReport> => {
      const source = repos.stations.getSource(sourceId) as StationSource;
      probed.push(source.url);
      if (opts.throwUrls?.includes(source.url)) throw new RadioError('PROBE_TIMEOUT', 'timed out');
      const failed = opts.failUrls?.includes(source.url);
      return {
        source,
        outcome: {
          success: !failed,
          failureCode: failed ? 'HTTP_STATUS' : null,
          failureDetail: failed ? 'HTTP 404' : null,
        },
        identity: { status: 'verified' },
      } as unknown as ProbeReport;
    },
  } as unknown as SourceService;
  const service = new CustomStationService(
    repos.stations,
    sources,
    new UrlPolicy({ allowInsecureHttp: false }),
    opts.maxPerGuild ?? 3,
  );
  return { ...repos, service, probed };
}

describe('adding custom stations (FR-011)', () => {
  it('stores a cleaned, guild-scoped station with one custom-user source', async () => {
    const t = setup();
    const { station } = await t.service.add(G, 'u1', {
      name: '  My\u0000 Radio\n ',
      url: ' https://ice.example.org/live.mp3 ',
      website: 'https://example.org',
      description: 'Jazz all day',
      category: '  jazz ',
      language: 'en',
    });
    expect(station).toMatchObject({
      provider: 'custom',
      guildId: G,
      displayName: 'My Radio',
      slug: 'my-radio',
      websiteUrl: 'https://example.org/',
      category: 'jazz',
    });
    expect(station.id).toMatch(/^custom:[a-z0-9x]{8}$/);
    const [src] = t.stations.listSources(station.id);
    expect(src).toMatchObject({ url: 'https://ice.example.org/live.mp3', provenance: 'custom-user' });
    expect(src!.id).toMatch(/^src-[a-z0-9x]{8}$/);
  });

  it('gives duplicate names distinct slugs', async () => {
    const t = setup();
    const a = await t.service.add(G, 'u', { name: 'Same', url: 'https://a.example.org/s' });
    const b = await t.service.add(G, 'u', { name: 'same', url: 'https://b.example.org/s' });
    expect([a.station.slug, b.station.slug]).toEqual(['same', 'same-2']);
  });

  it('rejects bad names, unsafe URLs and bad websites before probing anything', async () => {
    const t = setup();
    await expect(t.service.add(G, 'u', { name: ' x ', url: 'https://a.example.org/' })).rejects.toThrow(
      /2–60 characters/,
    );
    await expect(
      t.service.add(G, 'u', { name: 'Plain', url: 'http://a.example.org/' }),
    ).rejects.toMatchObject({
      code: 'URL_SCHEME_NOT_ALLOWED',
    });
    await expect(t.service.add(G, 'u', { name: 'Local', url: 'https://10.0.0.1/' })).rejects.toMatchObject({
      code: 'ADDRESS_BLOCKED',
    });
    await expect(
      t.service.add(G, 'u', { name: 'Site', url: 'https://a.example.org/', website: 'javascript:alert(1)' }),
    ).rejects.toThrow(/plain http\(s\) link/);
    expect(t.probed).toEqual([]);
    expect(t.stations.countCustomStations(G)).toBe(0);
  });

  it('enforces the per-server limit', async () => {
    const t = setup({ maxPerGuild: 1 });
    await t.service.add(G, 'u', { name: 'One', url: 'https://a.example.org/1' });
    await expect(
      t.service.add(G, 'u', { name: 'Two', url: 'https://a.example.org/2' }),
    ).rejects.toMatchObject({
      code: 'CUSTOM_STATION_LIMIT',
    });
    expect(t.service.maxPerGuild).toBe(1);
  });

  it('adds nothing when the stream fails its inspection or the probe throws', async () => {
    const t = setup({ failUrls: ['https://dead.example.org/'], throwUrls: ['https://slow.example.org/'] });
    await expect(
      t.service.add(G, 'u', { name: 'Dead', url: 'https://dead.example.org/' }),
    ).rejects.toMatchObject({
      code: 'HTTP_STATUS',
      userMessage: expect.stringMatching(/nothing was added/),
    });
    await expect(
      t.service.add(G, 'u', { name: 'Slow', url: 'https://slow.example.org/' }),
    ).rejects.toMatchObject({
      code: 'PROBE_TIMEOUT',
    });
    expect(t.stations.countCustomStations(G)).toBe(0);
    expect(t.stations.listAllSources()).toEqual([]);
  });

  it('leaves no station behind when storing its stream fails', async () => {
    const t = setup();
    t.stations.listStations(G); // cached, so a leftover would show in the cache too
    vi.spyOn(t.stations, 'insertSource').mockImplementation(() => {
      throw new Error('disk full');
    });
    await expect(
      t.service.add(G, 'u', { name: 'Mine', url: 'https://ice.example.org/a.mp3' }),
    ).rejects.toThrow('disk full');
    expect(t.stations.countCustomStations(G)).toBe(0);
    expect(t.stations.listStations(G)).toEqual([]);
    expect(t.probed).toEqual([]);
  });
});

describe('editing and removing custom stations', () => {
  it('only edits this server’s custom stations', async () => {
    const t = setup();
    const { station } = await t.service.add(G, 'u', { name: 'Mine', url: 'https://a.example.org/' });
    await expect(t.service.edit('999999999999999999', station.id, { name: 'Theirs' })).rejects.toThrow(
      /not one of this server/,
    );
    await expect(t.service.edit(G, 'demo:demo-radio', { name: 'Hijack' })).rejects.toThrow(
      /not one of this server/,
    );
    const r = await t.service.edit(G, station.id, { name: 'Renamed', description: null });
    expect(r.station.displayName).toBe('Renamed');
    expect(r.report).toBeNull();
    await expect(t.service.edit(G, station.id, { name: 'x' })).rejects.toThrow(/2–60 characters/);
  });

  it('re-inspects a changed URL and keeps the old one when the new one fails', async () => {
    const t = setup({ failUrls: ['https://broken.example.org/'] });
    const { station } = await t.service.add(G, 'u', { name: 'Mine', url: 'https://old.example.org/' });
    const ok = await t.service.edit(G, station.id, { url: 'https://new.example.org/' });
    expect(ok.report?.outcome.success).toBe(true);
    expect(t.stations.listSources(station.id)[0]!.url).toBe('https://new.example.org/');
    await expect(t.service.edit(G, station.id, { url: 'https://broken.example.org/' })).rejects.toThrow(
      /old URL was kept/,
    );
    expect(t.stations.listSources(station.id)[0]!.url).toBe('https://new.example.org/');
    await expect(t.service.edit(G, station.id, { url: 'ftp://x.example.org/' })).rejects.toMatchObject({
      code: 'URL_SCHEME_NOT_ALLOWED',
    });
  });

  it('applies an edit all-or-nothing when the new URL is rejected', async () => {
    const t = setup({ failUrls: ['https://broken.example.org/'], throwUrls: ['https://slow.example.org/'] });
    const { station } = await t.service.add(G, 'u', { name: 'Mine', url: 'https://old.example.org/' });
    for (const url of ['https://broken.example.org/', 'https://slow.example.org/', 'ftp://x.example.org/']) {
      await expect(t.service.edit(G, station.id, { name: 'Renamed', url })).rejects.toThrow();
      expect(t.stations.getStation(station.id)!.displayName).toBe('Mine');
      expect(t.stations.listSources(station.id)[0]!.url).toBe('https://old.example.org/');
    }
    await expect(
      t.service.edit(G, station.id, { name: 'Renamed', website: 'javascript:alert(1)' }),
    ).rejects.toThrow();
    expect(t.stations.getStation(station.id)!.displayName).toBe('Mine');
  });

  it('restores the old source exactly, evidence and override included, when a new URL fails', async () => {
    const t = setup({ failUrls: ['https://broken.example.org/'], throwUrls: ['https://slow.example.org/'] });
    const { station } = await t.service.add(G, 'u', { name: 'Mine', url: 'https://old.example.org/' });
    const sourceId = t.stations.listSources(station.id)[0]!.id;
    t.stations.setIdentityOverride(sourceId, 'verified');
    t.stations.recordFailure(sourceId, 'STREAM_EOF');
    const before = t.stations.getSource(sourceId);
    for (const url of ['https://broken.example.org/', 'https://slow.example.org/']) {
      await expect(t.service.edit(G, station.id, { url })).rejects.toThrow();
      expect(t.stations.getSource(sourceId)).toEqual(before);
    }
  });

  it('removes only this server’s stations', async () => {
    const t = setup();
    const { station } = await t.service.add(G, 'u', { name: 'Mine', url: 'https://a.example.org/' });
    expect(t.service.remove('999999999999999999', station.id)).toBe(false);
    expect(t.service.remove(G, station.id)).toBe(true);
    expect(t.stations.getStation(station.id)).toBeNull();
  });
});
