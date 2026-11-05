/**
 * The main-thread budget (AGENTS.md, "The stream comes first"): while a stream plays through the
 * real pipeline and the voice library's packet timer, the heaviest things a listener or a timer
 * can ask for must not hold up the event loop long enough to be heard. Runs /radio stats, browse,
 * source ranking across the whole catalogue, a sync of a large synthetic station list and a live
 * install of a second pack of the largest size from a local pack library, an update of it that
 * drops thousands of sources, /radio list, station suggestions, the hourly clean-up of tens of
 * thousands of old check results and the bot owner's "Check all sources again" over every source, with
 * a large synthetic pack loaded next to the bundled one, and measures the event-loop delay and the
 * longest stretch of synchronous work (between two turns of the event loop) in each step.
 *
 * The bound is generous on purpose (CI runners are shared and noisy): the target is under 10 ms per
 * stretch of work, and this only fails on a stall that would cut the audio. Vitest runs this file
 * on its own, after every other (vitest.config.ts), so other test processes don't count as delay.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
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
import { warmLocaleData } from '../../src/catalogue/pack-library.ts';
import { PackManager } from '../../src/catalogue/pack-manager.ts';
import { PackStore } from '../../src/catalogue/pack-store.ts';
import { prepareStations } from '../../src/catalogue/search.ts';
import { CatalogueSync } from '../../src/catalogue/sync.ts';
import { visibleStations } from '../../src/discord/context.ts';
import { yieldToEventLoop } from '../../src/shared/async.ts';
import { openSourceInput } from '../../src/streams/input.ts';
import { emptyOutcome } from '../../src/streams/probe.ts';
import { selectSource } from '../../src/streams/ranking.ts';
import { SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import { UrlPolicy } from '../../src/streams/url-policy.ts';
import { silentLogger } from '../helpers.ts';
import { GUILD, setup, suggest, V1 } from '../unit/controller-harness.ts';
import { binaries, generateFixtures, startTestRadio, type TestRadio } from './fixture-server.ts';

/** Longest event-loop stall allowed while the stream plays. A gap of about 55 ms is audible. */
const MAX_DELAY_MS = 50;
/** The delay histogram's timer interval. */
const RESOLUTION_MS = 5;
/** The schema's limit for one pack: the largest catalogue a single pack can bring. */
const STATIONS = 2000;
/** Checks the full source check makes before it is stopped. */
const FULL_CHECKS = 300;
/** Old check results the hourly clean-up deletes: as after a whole catalogue was checked a month ago. */
const AGED_RESULTS = 20_000;

let radio: TestRadio;
let root: string;
/** A local pack library serving one index and one bundle: the second big pack. */
let library: Server;
let libraryUrl: string;
/** Which version the library offers: 0, then 1 for the update. */
let published = 0;
const registry = new ProcessRegistry();

/**
 * A pack of STATIONS synthetic stations with two sources each (only the main one when `mainOnly`,
 * as in a newer version that drops every backup) and an official list to sync with.
 */
function writeBigPack(dir: string, id = 'bigpack', version = '2026.11.03', mainOnly = false): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'pack.json'),
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: id === 'bigpack' ? 'Big Pack' : 'Second Big Pack',
      version,
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
    (mainOnly ? ['main'] : ['main', 'backup']).map((label) => ({
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
  /** The library's index and bundle for one version of the second pack. */
  const publish = (version: string, mainOnly: boolean) => {
    const second = join(mkdtempSync(join(tmpdir(), 'radiobot-budget-lib-')), 'bigpack2');
    writeBigPack(second, 'bigpack2', version, mainOnly);
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
    const file = `bigpack2-${version}.json`;
    const index = JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      packs: [
        {
          id: 'bigpack2',
          name: 'Second Big Pack',
          version,
          stations: STATIONS,
          sources: mainOnly ? STATIONS : STATIONS * 2,
          file,
          sha256: createHash('sha256').update(bundle).digest('hex'),
          bytes: bundle.length,
        },
      ],
    });
    return { index, file, bundle };
  };
  const versions = [publish('2026.11.03', false), publish('2026.11.04', true)];
  library = createServer((req, res) => {
    const name = req.url?.slice(1);
    const index = versions[published]!.index;
    const bundle = versions.find((v) => v.file === name)?.bundle;
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
    // What createApp does at start-up, before anything plays.
    warmLocaleData();
    prepareStations(t.stations.listBuiltinStations());
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
    // A month-old check result for every source, twice over, for the hourly clean-up to delete.
    const aged = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const sourceIds = t.stations.listAllSources().map((s) => s.id);
    t.db.transaction(() => {
      for (let i = 0; i < AGED_RESULTS; i++) {
        t.db.run(
          `INSERT INTO source_probe_results (source_id, started_at, duration_ms, kind, success, probe_version)
           VALUES (?, ?, 10, 'basic', 1, 1)`,
          [sourceIds[i % sourceIds.length]!, aged],
        );
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

    // The longest stretch of synchronous work in each step: the time between two turns of the event
    // loop, seen from a callback that runs once a turn. It also keeps the loop from sleeping, so a
    // coarse system timer (15.6 ms on Windows) isn't counted as delay.
    let step = 'start';
    const stretches: Record<string, number> = {};
    let lastTurn = performance.now();
    let tracing = true;
    const turn = () => {
      const now = performance.now();
      stretches[step] = Math.max(stretches[step] ?? 0, now - lastTurn);
      lastTurn = now;
      if (tracing) setImmediate(turn);
    };
    setImmediate(turn);
    const delay = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
    delay.enable();
    // The histogram records the time between two of its ticks, so it needs a tick before the first
    // step and one after the last: a stall right after enable() or right before disable() is missed.
    await sleep(4 * RESOLUTION_MS);
    const playedBefore = resource.playbackDuration;
    const startedAt = performance.now();
    let played = 0;
    let elapsed = 0;
    const timings: Record<string, number> = {};
    const time = async (name: string, fn: () => Promise<unknown> | unknown) => {
      // Each command reaches the bot as an event of its own, so the loop turns between them.
      await yieldToEventLoop();
      step = name;
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
        await time('list', () => t.command(t.people.member, { sub: 'list' }));
        // Opening the station option with nothing typed, then the first letter: almost every
        // station matches one letter.
        await time('suggest: empty', async () => {
          expect(await suggest(t, 'play', 'station', '')).toHaveLength(25);
        });
        await time('suggest: one letter', async () => {
          expect(await suggest(t, 'play', 'station', 's')).toHaveLength(25);
        });
        // The settings card, its default-station form (a menu built from the catalogue) and a typed
        // station name, which is matched against every station.
        await time('settings card', () => t.command(t.people.admin, { sub: 'config' }));
        await time('settings: station form', () =>
          t.click(t.people.admin, t.ids.make(t.guild.id, 'cfg', 'station:playing')),
        );
        await time('settings: typed station', async () => {
          const i = await t.submit(
            t.people.admin,
            t.ids.make(t.guild.id, 'cfgm', 'station:playing'),
            { name: 'synthetic 19' },
            true,
            { pick: [] },
          );
          expect(i.violations).toEqual([]);
        });
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
      // The bot's operator updates it to a version without its backup sources: thousands of
      // sources switched off, in slices.
      await time('pack update', async () => {
        published = 1;
        await packManager.index(true);
        const r = await packManager.install('bigpack2');
        expect(r.previousVersion).toBe('2026.11.03');
        expect(t.ctx.stations.getSource('bigpack2-station-7-backup')?.enabled).toBe(false);
      });
      // The hourly clean-up of check results older than PROBE_HISTORY_DAYS.
      await time('probe history clean-up', async () => {
        const r = await t.stations.pruneProbeHistory({
          keep: 30,
          days: 30,
          pause: yieldToEventLoop,
          trimEverySource: true,
        });
        expect(r.deleted).toBeGreaterThanOrEqual(AGED_RESULTS);
      });
      // The bot owner's "Check all sources again" across every source of all three packs: listing
      // them, then a few hundred checks recorded as real ones are (each check itself is replaced),
      // then Stop. Listing and checking are timed apart, since one grows with the catalogue.
      await time('full check: listing', async () => {
        t.probe.impl = async () => {
          await yieldToEventLoop();
          return {
            ...emptyOutcome(Date.now()),
            success: true,
            transport: 'http-continuous',
            container: 'mp3',
            codec: 'mp3',
            sampleRateHz: 44_100,
            channels: 2,
            measuredBitrateKbps: 128,
            bitrateEvidence: 'measured',
          };
        };
        expect(t.ctx.fullCheck.start()).not.toBeNull();
        while (t.ctx.fullCheck.state?.total === 0) await yieldToEventLoop();
      });
      await time('full check: checks', async () => {
        while ((t.ctx.fullCheck.state?.done ?? 0) < FULL_CHECKS) await sleep(RESOLUTION_MS);
        await t.ctx.fullCheck.stop();
        // Both big packs, less the backup sources the update switched off.
        expect(t.ctx.fullCheck.state?.total).toBeGreaterThan(3 * STATIONS);
      });
      await sleep(4 * RESOLUTION_MS);
    } finally {
      delay.disable();
      tracing = false;
      played = resource.playbackDuration - playedBefore;
      elapsed = performance.now() - startedAt;
      player.stop(true);
      pipeline.stop();
    }

    const maxMs = delay.max / 1e6;
    const p99Ms = delay.percentile(99) / 1e6;
    const list = (ms: Record<string, number>) =>
      Object.entries(ms)
        .map(([k, v]) => `${k} ${v.toFixed(1)} ms`)
        .join(', ');
    // Shown with the test output, so a slow step can be found without a profiler.
    console.info(
      `event-loop delay: max ${maxMs.toFixed(1)} ms, p99 ${p99Ms.toFixed(1)} ms; ${played} ms played in ${elapsed.toFixed(0)} ms\n` +
        `longest stretch without a turn: ${list(stretches)}\nlongest time taken (turns included): ${list(timings)}`,
    );
    // The audio kept flowing the whole time: the player sent (nearly) a packet per 20 ms throughout.
    expect(played).toBeGreaterThan(0.8 * elapsed);
    expect(maxMs).toBeLessThan(MAX_DELAY_MS);
    expect(Math.max(...Object.values(stretches))).toBeLessThan(MAX_DELAY_MS);
  }, 120_000);
});
