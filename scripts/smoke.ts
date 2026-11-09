/**
 * Smoke test of a build: runs the parts of the bot that unit tests reach only from source, from
 * whichever tree this file was started in (`scripts/` from source, `dist/scripts/` once built,
 * or inside the Docker image), with that tree's own Node and FFmpeg. No network, no Discord.
 *
 *   node dist/scripts/smoke.js          # FFMPEG_PATH / FFPROBE_PATH, else ffmpeg / ffprobe on PATH
 *
 * Opens a temporary database (migrations run) and seeds the template pack (the bot ships no
 * station packs; catalog/packs/_template is a complete example), loads it again on the pack worker
 * thread as an installed pack would be, checkpoints the database on the
 * worker thread, parses a small synthetic station list on the parse worker, has the voice worker
 * load the voice libraries and make a DAVE session, checks both voice encryption modes and that
 * FFmpeg has libopus, encodes two seconds of a synthetic tone to Ogg Opus with the live encoder's
 * arguments, and checks a heartbeat with the Node healthcheck and, on Linux, the image's shell
 * healthcheck (scripts/healthcheck.sh). Prints one line per step; exits 1 at the first step that fails.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEncodeArgs, planEncoder } from '../src/audio/encoder.ts';
import { checkFfmpeg, ProcessRegistry, runWithInput } from '../src/audio/ffmpeg.ts';
import { loadPackInWorker } from '../src/catalogue/pack-manager.ts';
import { loadPack, PackRegistry, seedPacks } from '../src/catalogue/packs.ts';
import { parseOfficialListInWorker } from '../src/catalogue/sync.ts';
import { type HealthSnapshot, HeartbeatWriter, heartbeatPath } from '../src/observability/health.ts';
import { createLogger } from '../src/observability/logger.ts';
import { WalCheckpointer } from '../src/persistence/checkpoint.ts';
import { Db, loadMigrations } from '../src/persistence/db.ts';
import { StationRepository } from '../src/persistence/repositories/stations.ts';
import { rootPath } from '../src/shared/paths.ts';
import { siblingModule } from '../src/shared/workers.ts';
import { checkVoiceEncryption } from '../src/voice/encryption.ts';
import { VoiceThread } from '../src/voice/voice-thread.ts';

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

type CheckRun = () => Promise<{ code: number; out: string }>;

/** Runs a healthcheck against this test's heartbeat file, as Docker's HEALTHCHECK does. */
function healthcheck(file: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { env: { ...process.env, DATABASE_PATH: dbPath }, timeout: 30_000, windowsHide: true },
      (err, stdout) => {
        const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        resolve({ code, out: stdout.trim() });
      },
    );
  });
}

/** The Node healthcheck next to this script (`radio-bot status`, bare-metal installs). */
const nodeHealthcheck: CheckRun = () =>
  healthcheck(process.execPath, [fileURLToPath(siblingModule(import.meta.url, 'healthcheck'))]);
/** The image's HEALTHCHECK, scripts/healthcheck.sh. */
const shellHealthcheck: CheckRun = () => healthcheck('sh', [rootPath('scripts', 'healthcheck.sh')]);

/** Writes a healthy heartbeat, then one from a bot that isn't connected: the check must tell them apart. */
async function checkHeartbeatWith(run: CheckRun): Promise<string> {
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
  const healthy = await run();
  check(healthy.code === 0, `the healthcheck failed: ${healthy.out}`);
  await writer.write({ ...snap, discordReady: false });
  const unhealthy = await run();
  check(unhealthy.code === 1, `the healthcheck passed a bot that is not connected: ${unhealthy.out}`);
  return healthy.out;
}

const RUN = { owner: 'smoke', kind: 'smoke', timeoutMs: 30_000 };

try {
  const template = rootPath('catalog', 'packs', '_template');
  await step('database: migrations and the template pack', () => {
    db = new Db(dbPath);
    db.migrate();
    const latest = loadMigrations().at(-1)!.version;
    check(db.schemaVersion() === latest, `schema version ${db.schemaVersion()}, expected ${latest}`);
    const packs = new PackRegistry([...PackRegistry.load(null).packs, loadPack(template)]);
    const seed = db.transaction(() => seedPacks(new StationRepository(db!), packs));
    check(seed.stationsInserted > 0, 'the template pack has no stations');
    return `schema v${latest}, ${seed.packs} pack(s), ${seed.stationsInserted} stations`;
  });

  await step('station pack check on the pack worker thread', async () => {
    const pack = await loadPackInWorker(template);
    check(pack.stations.length > 0 && pack.contentHash.length === 64, 'the worker returned no pack');
    return `${pack.meta.id}: ${pack.stations.length} stations`;
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

  await step('voice worker thread: the voice libraries and a DAVE session', async () => {
    const voice = new VoiceThread({ logger });
    try {
      await voice.start();
      const r = await voice.selfTest();
      check(r.ok, `the self-test failed: ${r.error ?? 'no reason given'}`);
      return `DAVE protocol ${r.daveProtocolVersion}, heap ${r.heapUsedMb} MB`;
    } finally {
      await voice.stop();
    }
  });

  await step('voice encryption: AES-256-GCM and XChaCha20-Poly1305', async () => {
    const support = await checkVoiceEncryption();
    check(support.aes256gcm, 'OpenSSL has no aes-256-gcm');
    check(support.xchacha20, `XChaCha20-Poly1305 is unavailable: ${support.error ?? 'no reason given'}`);
    return '';
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

  await step('heartbeat and healthcheck', () => checkHeartbeatWith(nodeHealthcheck));
  // The image runs on Linux, and the script needs GNU find's fractional -mmin, so it is checked on
  // Linux only (CI, and inside the image).
  await step("the image's shell healthcheck", () =>
    process.platform === 'linux' ? checkHeartbeatWith(shellHealthcheck) : 'skipped: Linux only',
  );
} catch (err) {
  process.stdout.write(`FAIL ${err instanceof Error ? err.message : String(err)}\n`);
  failed = true;
} finally {
  registry.killAll();
  (db as Db | null)?.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
