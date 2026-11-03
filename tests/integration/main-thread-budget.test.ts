/**
 * The main-thread budget (AGENTS.md, "The stream comes first"): while a stream plays through the
 * real pipeline and the voice library's packet timer, the heaviest things a listener or a timer
 * can ask for must not hold up the event loop long enough to be heard. Runs /radio stats, browse,
 * source ranking across the whole catalogue, a sync of a large synthetic station list and a live
 * install of a second pack of the largest size from a local pack library, with
 * a large synthetic pack loaded next to the bundled one, and measures the event-loop delay.
 *
 * The bound is generous on purpose (CI runners are shared and noisy): the target is under 10 ms per
 * stretch of work, and this only fails on a stall that would cut the audio.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  NoSubscriberBehavior,
  StreamType,
} from '@discordjs/voice';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planEncoder } from '../../src/audio/encoder.ts';
import { ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import { AudioPipeline } from '../../src/audio/pipeline.ts';
import { PackManager } from '../../src/catalogue/pack-manager.ts';
import { PackStore } from '../../src/catalogue/pack-store.ts';
import { CatalogueSync } from '../../src/catalogue/sync.ts';
import { visibleStations } from '../../src/discord/context.ts';
import { openSourceInput } from '../../src/streams/input.ts';
import { selectSource } from '../../src/streams/ranking.ts';
import { SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import { UrlPolicy } from '../../src/streams/url-policy.ts';
import { silentLogger } from '../helpers.ts';
import { GUILD, setup, V1 } from '../unit/controller-harness.ts';
import { binaries, generateFixtures, startTestRadio, type TestRadio } from './fixture-server.ts';

/** Longest event-loop stall allowed while the stream plays. A gap of about 55 ms is audible. */
const MAX_DELAY_MS = 50;
/** The schema's limit for one pack: the largest catalogue a single pack can bring. */
const STATIONS = 2000;

let radio: TestRadio;
let root: string;
/** A local pack library serving one index and one bundle: the second big pack. */
let library: Server;
let libraryUrl: string;
const registry = new ProcessRegistry();

/** A pack of STATIONS synthetic stations with two sources each and an official list to sync with. */
function writeBigPack(dir: string, id = 'bigpack'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'pack.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id === 'bigpack' ? 'Big Pack' : 'Second Big Pack',
      version: '2026.11.03',
      categories: [{ id: 'pop', name: 'Pop' }],
      sync: { adapter: 'json-name-list', url: 'https://lists.example.org/stations.json' },
    }),
  );
  const stations = Array.from({ length: STATIONS }, (_, i) => ({
    slug: `station-${i}`,
    displayName: `Synthetic Station ${i}`,
    order: i,
    category: i % 3 === 0 ? 'pop' : null,
  }));
  writeFileSync(join(dir, 'stations.json'), JSON.stringify({ schemaVersion: 1, stations }));
  const sources = stations.flatMap((s) =>
    ['main', 'backup'].map((label) => ({
      id: `${id}-${s.slug}-${label}`,
      station: s.slug,
      url: `https://radio.example.org/${id}/${s.slug}/${label}.mp3`,
      label,
      provenance: 'curated',
      provenanceDetail: 'Synthetic test data.',
    })),
  );
  writeFileSync(join(dir, 'sources.json'), JSON.stringify({ schemaVersion: 1, sources }));
}

/**
 * The official list: most stations as they are, a tenth renamed slightly (fuzzy matching), a tenth
 * gone and as many new names, so every part of the sync's matching has real work to do.
 */
function officialList(): Buffer {
  const list: Array<{ name: string }> = [];
  for (let i = 0; i < STATIONS; i++) {
    if (i % 10 === 1) list.push({ name: `Synthetic Station ${i} FM` });
    else if (i % 10 !== 2) list.push({ name: `Synthetic Station ${i}` });
  }
  for (let i = 0; i < STATIONS / 10; i++) list.push({ name: `Brand New Radio ${i}` });
  return Buffer.from(JSON.stringify(list));
}

beforeAll(async () => {
  radio = await startTestRadio(generateFixtures());
  root = mkdtempSync(join(tmpdir(), 'radiobot-budget-'));
  writeBigPack(join(root, 'bigpack'));
  const second = join(mkdtempSync(join(tmpdir(), 'radiobot-budget-lib-')), 'bigpack2');
  writeBigPack(second, 'bigpack2');
  const read = (name: string) => JSON.parse(readFileSync(join(second, name), 'utf8'));
  const bundle = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      pack: read('pack.json'),
      stations: read('stations.json'),
      sources: read('sources.json'),
    }),
  );
  rmSync(second, { recursive: true, force: true });
  const index = JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    packs: [
      {
        id: 'bigpack2',
        name: 'Second Big Pack',
        version: '2026.11.03',
        stations: STATIONS,
        sources: STATIONS * 2,
        file: 'bigpack2.json',
        sha256: createHash('sha256').update(bundle).digest('hex'),
        bytes: bundle.length,
      },
    ],
  });
  library = createServer((req, res) => {
    res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(req.url === '/index.json' ? index : bundle);
  });
  await new Promise<void>((r) => library.listen(0, '127.0.0.1', () => r()));
  libraryUrl = `http://127.0.0.1:${(library.address() as AddressInfo).port}/index.json`;
}, 120_000);
afterAll(async () => {
  registry.killAll();
  await radio?.close();
  await new Promise<void>((r) => (library ? library.close(() => r()) : r()));
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('main-thread budget while a stream plays', () => {
  it('keeps every stall under the audible gap through stats, browse, ranking and a large sync', async () => {
    const t = setup({ extraPacksDir: root });
    const all = visibleStations(t.ctx, GUILD);
    expect(all.length).toBeGreaterThan(STATIONS);
    // Half the sources look checked and healthy, so ranking and coverage take their longer paths.
    const now = new Date().toISOString();
    t.db.transaction(() => {
      for (const s of t.stations.listAllSources().filter((_, i) => i % 2 === 0)) {
        t.stations.applyProbePatch(s.id, {
          lastProbeAt: now,
          verificationState: 'eligible',
          identityStatus: 'verified',
          codec: 'mp3',
          measuredBitrateKbps: 128,
        });
      }
    });
    const bundled = all.filter((s) => s.provider !== 'bigpack');
    const sync = new CatalogueSync(
      t.ctx.stations,
      t.ctx.meta,
      { fetchBytes: async () => ({ bytes: officialList() }) } as unknown as SafeHttpClient,
      t.ctx.packs,
      silentLogger(),
    );
    const http = new SafeHttpClient(
      new UrlPolicy({ allowInsecureHttp: true, testAllowedAddresses: ['127.0.0.1'] }),
    );
    const packManager = new PackManager({
      registry: t.ctx.packs,
      store: new PackStore(join(root, 'installed-packs')),
      stations: t.ctx.stations,
      transaction: (fn) => t.db.transaction(fn),
      http,
      logger: silentLogger(),
      background: (fn) => fn(),
      onChange: () => {},
      onGone: () => {},
      libraryUrl,
    });
    // Something is playing in this server, so /radio stats builds its full view.
    const session = t.sessions.ensure(GUILD);
    Object.assign(session, { connected: true, channelId: V1, stationId: all[0]!.id });
    session.fullStatus = {
      state: 'PLAYING',
      stationId: all[0]!.id,
      channelId: V1,
      source: t.ctx.sources.sourcesFor(all[0]!.id)[0] ?? null,
    };
    session.live = {
      connectedSince: Date.now(),
      input: {
        requestedHost: 'radio.example.org',
        finalHost: 'radio.example.org',
        remoteAddress: null,
        remotePort: null,
        redirects: [],
        transport: 'http-continuous',
        segmentHost: null,
        segmentsFetched: 0,
        segmentFailures: 0,
        skippedSegments: 0,
        kbps10s: 128,
        kbps60s: 128,
        bytes: 1048576,
      },
      output: { targetKbps: 128, channelBitrateKbps: 64, kbps10s: 128, kbps60s: 128, bytes: 1 },
      voice: null,
    };

    // The real audio path: the fixture station → SafeHttpClient → FFmpeg → Ogg Opus → the voice
    // library's player, which takes one packet every 20 ms on this thread as it would for Discord.
    const client = new SafeHttpClient(
      new UrlPolicy({ allowInsecureHttp: true, testAllowedAddresses: ['127.0.0.1'] }),
    );
    const input = await openSourceInput(client, `${radio.base}/mp3`);
    const plan = planEncoder({
      qualityMode: 'maximum',
      manualBitrateKbps: null,
      sourceBitrate: { kbps: 128, evidence: 'measured' },
      channelBitrateBps: null,
      sourceSampleRateHz: 44_100,
      sourceChannels: 2,
    });
    const pipeline = new AudioPipeline(input, plan, {
      registry,
      ffmpegPath: binaries().ffmpeg,
      owner: 'budget',
    });
    const resource = createAudioResource(pipeline.output, { inputType: StreamType.OggOpus });
    const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Play } });
    player.on('error', () => {});
    player.play(resource);
    await new Promise<void>((resolve) => player.once(AudioPlayerStatus.Playing, () => resolve()));

    const delay = monitorEventLoopDelay({ resolution: 5 });
    delay.enable();
    const playedBefore = resource.playbackDuration;
    const startedAt = performance.now();
    let played = 0;
    let elapsed = 0;
    const timings: Record<string, number> = {};
    const time = async (name: string, fn: () => Promise<unknown> | unknown) => {
      const started = performance.now();
      await fn();
      timings[name] = Math.max(timings[name] ?? 0, performance.now() - started);
    };
    try {
      for (let round = 0; round < 3; round++) {
        await time('stats', async () => {
          const i = await t.command(t.people.admin, { sub: 'stats' });
          expect(i.violations).toEqual([]);
          expect(i.text).toMatch(/Big Pack/);
        });
        await time('browse', () => t.command(t.people.member, { sub: 'browse' }));
        await time('browse search', () =>
          t.command(t.people.member, { sub: 'browse', strings: { search: 'synthetic 19' } }),
        );
        // Every source of every bundled station ranked in one stretch, with no break in between.
        await time('ranking', () => {
          for (const st of bundled) selectSource(t.ctx.sources.sourcesFor(st.id), null);
        });
      }
      await time('sync', async () => {
        const report = await sync.sync('bigpack', 'admin');
        expect(report.error).toBeNull();
        // The new names, plus renames too close to several missing names to be taken as renames.
        expect(report.added.length + report.renamed.length).toBe(STATIONS / 5);
      });
      // An admin installs a pack of the largest size while the stream plays: download, check on the
      // worker thread, write in slices, then browse sees it.
      await time('pack install', async () => {
        const r = await packManager.install('bigpack2');
        expect(r.stations).toBe(STATIONS);
        expect(t.ctx.packs.isEnabled('bigpack2')).toBe(true);
      });
      await time('browse after install', () => t.command(t.people.member, { sub: 'browse' }));
    } finally {
      delay.disable();
      played = resource.playbackDuration - playedBefore;
      elapsed = performance.now() - startedAt;
      player.stop(true);
      pipeline.stop();
    }

    const maxMs = delay.max / 1e6;
    const p99Ms = delay.percentile(99) / 1e6;
    // Shown with the test output, so a slow step can be found without a profiler.
    console.info(
      `event-loop delay: max ${maxMs.toFixed(1)} ms, p99 ${p99Ms.toFixed(1)} ms; ${played} ms played in ${elapsed.toFixed(0)} ms; longest runs: ${Object.entries(
        timings,
      )
        .map(([k, v]) => `${k} ${v.toFixed(0)} ms`)
        .join(', ')}`,
    );
    // The audio kept flowing the whole time: the player sent (nearly) a packet per 20 ms throughout.
    expect(played).toBeGreaterThan(0.8 * elapsed);
    expect(maxMs).toBeLessThan(MAX_DELAY_MS);
  }, 120_000);
});
