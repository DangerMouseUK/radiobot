import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LatencySeries,
  RateMeter,
  regionHint,
  summarise,
  tcpPing,
} from '../../src/observability/netstats.ts';
import { MAX_QUEUE_LENGTH } from '../../src/persistence/repositories/guilds.ts';
import { memoryDb } from '../helpers.ts';

describe('rate meter', () => {
  it('reports rolling kbps over complete seconds', () => {
    let t = 1_000_000;
    const m = new RateMeter(60, () => t);
    for (let s = 0; s < 10; s++) {
      m.add(16_000); // 128 kbps
      t += 1000;
    }
    expect(m.kbps(10)).toBeCloseTo(128, 0);
    t += 30_000; // silence
    expect(m.kbps(10)).toBe(0);
    expect(m.kbps(59)).toBeCloseTo((10 * 128) / 40, 0);
    const young = new RateMeter(60, () => t);
    young.add(16_000);
    t += 1000;
    expect(young.kbps(59)).toBeCloseTo(128, 0);
  });
});

describe('latency summaries', () => {
  it('computes min/avg/max and jitter as mean neighbour difference', () => {
    const s = summarise([20, 22, 21, 25])!;
    expect(s.minMs).toBe(20);
    expect(s.maxMs).toBe(25);
    expect(s.avgMs).toBe(22);
    expect(s.jitterMs).toBeCloseTo((2 + 1 + 4) / 3, 1);
    expect(summarise([])).toBeNull();
    const series = new LatencySeries(3);
    for (const v of [1, 2, 3, 4, undefined, -1, Number.NaN]) series.add(v);
    expect(series.summary()!.samples).toBe(3);
  });
});

describe('region hints from host names', () => {
  it.each([
    ['n04-eu1.stream.example.net', 'Europe'],
    ['c-lhr05-1a2b3c.discord.media:443', 'London'],
    ['c-iad07-abcd.discord.media', 'Ashburn (US East)'],
    ['edge-us-east-1.example.net', 'US East'],
    ['stream.example.com', null],
    [null, null],
  ])('%s → %s', (host, hint) => {
    expect(regionHint(host)).toBe(hint);
  });
});

describe('TCP round trip', () => {
  let server: Server;
  let port: number;
  beforeAll(async () => {
    server = createServer((sock) => sock.destroy());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.close();
  });

  it('measures handshakes without sending data', async () => {
    const r = await tcpPing('127.0.0.1', port, 3);
    expect(r?.samples).toBe(3);
    expect(r!.avgMs).toBeGreaterThanOrEqual(0);
  });

  it('returns null when nothing answers', async () => {
    expect(await tcpPing('127.0.0.1', 1, 2, 500)).toBeNull();
  });
});

describe('station queue', () => {
  function setup() {
    const repos = memoryDb();
    for (const slug of ['a', 'b', 'c']) {
      repos.stations.upsertProviderStation({
        id: `x:${slug}`,
        provider: 'x',
        slug,
        externalId: null,
        displayName: slug.toUpperCase(),
        aliases: [],
        tags: [],
        category: null,
        sortOrder: 1,
        officialPageUrl: null,
        officialLastSeenAt: null,
        catalogueStatus: 'active',
        description: null,
      });
    }
    return repos;
  }

  it('queues in order, removes by position and skips (dequeues) first-in-first-out', () => {
    const { guilds } = setup();
    expect(guilds.enqueue('g', 'x:a', 'u1')).toBe(1);
    expect(guilds.enqueue('g', 'x:b', 'u1')).toBe(2);
    expect(guilds.enqueue('g', 'x:c', null)).toBe(3);
    expect(guilds.removeFromQueue('g', 2)?.stationId).toBe('x:b');
    expect(guilds.removeFromQueue('g', 9)).toBeNull();
    expect(guilds.dequeue('g')?.stationId).toBe('x:a');
    expect(guilds.listQueue('g').map((e) => e.stationId)).toEqual(['x:c']);
    expect(guilds.listQueue('other')).toEqual([]);
    expect(guilds.clearQueue('g')).toBe(1);
    expect(guilds.dequeue('g')).toBeNull();
  });

  it('caps the queue and is removed with the guild or the station', () => {
    const { guilds, stations } = setup();
    for (let n = 0; n < MAX_QUEUE_LENGTH; n++) expect(guilds.enqueue('g', 'x:a', null)).toBe(n + 1);
    expect(guilds.enqueue('g', 'x:a', null)).toBeNull();
    guilds.purgeGuild('g');
    expect(guilds.listQueue('g')).toEqual([]);
    guilds.enqueue('h', 'x:b', null);
    stations.deleteGuildCustomStations('h');
    expect(guilds.listQueue('h')).toHaveLength(1);
  });
});
