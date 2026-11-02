/**
 * Smoke test of a build: runs the parts of the bot that unit tests reach only from source, from
 * whichever tree this file was started in (`scripts/` from source, `dist/scripts/` once built,
 * or inside the Docker image), with that tree's own Node and FFmpeg. No network, no Discord.
 *
 *   node dist/scripts/smoke.js          # FFMPEG_PATH / FFPROBE_PATH, else ffmpeg / ffprobe on PATH
 *
 * Opens a temporary database (migrations run) and seeds the bundled packs, checkpoints it on the
 * worker thread, parses a small synthetic station list on the parse worker, encodes two seconds of
 * a synthetic tone to Ogg Opus with the live encoder's arguments, and checks a heartbeat with the
 * healthcheck script. Prints one line per step; exits 1 at the first step that fails.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEncodeArgs, planEncoder } from '../src/audio/encoder.ts';
import { checkFfmpeg, ProcessRegistry, runWithInput } from '../src/audio/ffmpeg.ts';
import { PackRegistry, seedPacks } from '../src/catalogue/packs.ts';
import { parseOfficialListInWorker } from '../src/catalogue/sync.ts';
import { type HealthSnapshot, HeartbeatWriter, heartbeatPath } from '../src/observability/health.ts';
import { createLogger } from '../src/observability/logger.ts';
import { WalCheckpointer } from '../src/persistence/checkpoint.ts';
import { Db, loadMigrations } from '../src/persistence/db.ts';
import { StationRepository } from '../src/persistence/repositories/stations.ts';
import { siblingModule } from '../src/shared/workers.ts';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
const registry = new ProcessRegistry();
const logger = createLogger('warn');
const dir = mkdtempSync(join(tmpdir(), 'radio-bot-smoke-'));
const dbPath = join(dir, 'radio-bot.sqlite');
let db: Db | null = null;
let failed = false;

function check(ok: boolean, what: string): void {
  if (!ok) throw new Error(what);
}

async function step(name: string, fn: () => Promise<string> | string): Promise<void> {
  let detail: string;
  try {
    detail = await fn();
  } catch (err) {
    throw new Error(`${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  process.stdout.write(`ok   ${name}${detail ? ` (${detail})` : ''}\n`);
}

/** Runs the healthcheck script next to this one, as Docker's HEALTHCHECK does. */
function healthcheck(): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [fileURLToPath(siblingModule(import.meta.url, 'healthcheck'))],
      { env: { ...process.env, DATABASE_PATH: dbPath }, timeout: 30_000, windowsHide: true },
      (err, stdout) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, out: stdout.trim() });
      },
    );
  });
}

const RUN = { owner: 'smoke', kind: 'smoke', timeoutMs: 30_000 };

try {
  await step('database: migrations and bundled packs', () => {
    db = new Db(dbPath);
    db.migrate();
    const latest = loadMigrations().at(-1)!.version;
    check(db.schemaVersion() === latest, `schema version ${db.schemaVersion()}, expected ${latest}`);
    const packs = PackRegistry.load(null);
    const seed = db.transaction(() => seedPacks(new StationRepository(db!), packs));
    check(packs.packs.length > 0, 'no station packs were found');
    return `schema v${latest}, ${seed.packs} pack(s), ${seed.stationsInserted} stations`;
  });

  await step('WAL checkpoint on the worker thread', async () => {
    const checkpointer = new WalCheckpointer({ db: db!, logger });
    check(await checkpointer.start(), 'the checkpoint worker did not start');
    const reply = await checkpointer.checkpoint();
    await checkpointer.stop();
    check(reply?.ok === true, `the checkpoint failed: ${reply?.error ?? 'no reply'}`);
    return `${reply!.checkpointedFrames}/${reply!.walFrames} frames`;
  });

  await step('station list parsed on the worker thread', async () => {
    const list = Array.from({ length: 200 }, (_, i) => ({ id: `s${i}`, name: `Smoke Station ${i}` }));
    const entries = await parseOfficialListInWorker(
      'json-name-list',
      Buffer.from(JSON.stringify({ stations: list })),
    );
    check(entries.length === list.length, `${entries.length} entries, expected ${list.length}`);
    check(entries[199]?.name === 'Smoke Station 199', 'the entries came back wrong');
    return `${entries.length} entries`;
  });

  await step('FFmpeg with libopus', async () => {
    const info = await checkFfmpeg(registry, { ffmpeg, ffprobe });
    check(info.libopus, 'FFmpeg has no libopus encoder');
    return info.ffmpegVersion;
  });

  await step('encode: 2 s tone to Ogg Opus with the live encoder arguments', async () => {
    // The source: two seconds of a 440 Hz tone as a 128 kbps MP3 stream, made by FFmpeg itself.
    const source = await runWithInput(
      registry,
      ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=2:sample_rate=44100',
        '-ac',
        '2',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '128k',
        '-f',
        'mp3',
        'pipe:1',
      ],
      Buffer.alloc(0),
      RUN,
    );
    check(source.code === 0 && source.stdout.length > 10_000, `no source audio: ${source.stderr}`);
    const plan = planEncoder({
      qualityMode: 'maximum',
      manualBitrateKbps: null,
      sourceBitrate: { kbps: 128, evidence: 'measured' },
      channelBitrateBps: null,
      sourceSampleRateHz: 44_100,
      sourceChannels: 2,
    });
    const out = await runWithInput(registry, ffmpeg, buildEncodeArgs(plan), source.stdout, RUN);
    check(out.code === 0, `the encoder failed: ${out.stderr}`);
    check(out.stdout.subarray(0, 4).toString('latin1') === 'OggS', 'the output is not an Ogg stream');
    check(out.stdout.includes('OpusHead'), 'the output has no Opus header');
    const probe = await runWithInput(
      registry,
      ffprobe,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'pipe',
        '-count_packets',
        '-show_entries',
        'stream=codec_name,sample_rate,channels,nb_read_packets',
        '-of',
        'json',
        'pipe:0',
      ],
      out.stdout,
      RUN,
    );
    const info = JSON.parse(probe.stdout.toString()) as {
      streams?: Array<{
        codec_name?: string;
        sample_rate?: string;
        channels?: number;
        nb_read_packets?: string;
      }>;
    };
    const s = info.streams?.[0];
    // A piped Ogg stream has no duration of its own; every packet is one frame of plan.frameMs.
    const seconds = (Number(s?.nb_read_packets) * plan.frameMs) / 1000;
    check(s?.codec_name === 'opus', `codec ${s?.codec_name}, expected opus`);
    check(s?.sample_rate === '48000' && s.channels === 2, 'the output is not 48 kHz stereo');
    check(seconds > 1.8 && seconds < 2.3, `${seconds} s of audio, expected about 2`);
    return `${plan.targetKbps} kbps, ${seconds.toFixed(2)} s, ${out.stdout.length} bytes`;
  });

  await step('heartbeat and healthcheck', async () => {
    const writer = new HeartbeatWriter(heartbeatPath(dbPath), (err) => {
      throw err;
    });
    const snap: HealthSnapshot = {
      at: new Date().toISOString(),
      pid: process.pid,
      discordReady: true,
      activeStreams: 0,
      ffmpegProcesses: registry.active,
      dbOk: true,
      ffmpegOk: true,
    };
    await writer.write(snap);
    const healthy = await healthcheck();
    check(healthy.code === 0, `the healthcheck failed: ${healthy.out}`);
    // And it must notice a problem: a heartbeat from a bot that isn't connected.
    await writer.write({ ...snap, discordReady: false });
    const unhealthy = await healthcheck();
    check(unhealthy.code === 1, `the healthcheck passed a bot that is not connected: ${unhealthy.out}`);
    return healthy.out;
  });
} catch (err) {
  process.stdout.write(`FAIL ${err instanceof Error ? err.message : String(err)}\n`);
  failed = true;
} finally {
  registry.killAll();
  (db as Db | null)?.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
