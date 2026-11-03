/**
 * Validates every station pack and, with --probe, inspects sources live.
 *
 *   node dist/scripts/validate-catalogue.js                       # validate all packs (built-in + EXTRA_PACKS_DIR)
 *   node dist/scripts/validate-catalogue.js --pack ./my-pack      # validate one pack folder
 *   node dist/scripts/validate-catalogue.js --probe mypack:my-station [other:station ...]
 *   node dist/scripts/validate-catalogue.js --probe --pack-id mypack  # every enabled source in one pack (slow; be gentle)
 *   add --compare to run a ~40 s audio comparison between sources of each probed station
 *   add --json <file> to write the evidence report
 *   add --strict to apply the extra rules for packs published in a pack library (see strictProblems()
 *   in scripts/pack-author.ts): version, owner, countries, languages, provenance, a probe report with
 *   a successful probe, no signed URLs or images
 *
 * Probes run one at a time per host (PRD §7.3 budgets). Audio samples stay in memory only. Before
 * the first probe, FFmpeg and FFprobe are checked: FFMPEG_PATH/FFPROBE_PATH if set, otherwise the
 * ones on PATH, otherwise the ffmpeg-static/ffprobe-static dev dependencies. Without them nothing is
 * contacted.
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { checkFfmpeg, type FfmpegPaths, ProcessRegistry } from '../src/audio/ffmpeg.ts';
import { loadPack, PackRegistry, type StationPack } from '../src/catalogue/packs.ts';
import { rootPath } from '../src/shared/paths.ts';
import { compareSources, correlationEvidence } from '../src/streams/identity.ts';
import { codecLabel, type ProbeOutcome, probeSource } from '../src/streams/probe.ts';
import { SafeHttpClient } from '../src/streams/safe-fetch.ts';
import { UrlPolicy } from '../src/streams/url-policy.ts';
import { strictProblems, strictWarnings } from './pack-author.ts';

const args = process.argv.slice(2);
const flag = (f: string) => args.includes(f);
const optionValue = (f: string) => {
  const i = args.indexOf(f);
  return i >= 0 ? (args[i + 1] ?? null) : null;
};
const jsonOut = optionValue('--json');
const packDir = optionValue('--pack');
const packId = optionValue('--pack-id');
const stationFilter = args.filter((a) => /^[a-z0-9][a-z0-9-]*:[a-z0-9-]+$/.test(a));

let packs: readonly StationPack[];
try {
  // Without --pack, the template pack is checked too: the bot ships no packs, and the template is
  // what new packs start from (and what the smoke test seeds).
  packs = packDir
    ? [loadPack(packDir)]
    : [
        ...PackRegistry.load(process.env.EXTRA_PACKS_DIR || null).packs,
        loadPack(rootPath('catalog', 'packs', '_template')),
      ];
} catch (err) {
  process.stderr.write(`Invalid pack: ${(err as Error).message}\n`);
  process.exit(1);
}
for (const p of packs) {
  const enabled = p.sources.filter((s) => s.enabled);
  const withSource = new Set(enabled.map((s) => s.stationId));
  process.stdout.write(
    `Pack "${p.meta.id}" (${p.meta.name}) OK: ${p.stations.length} stations, ${p.sources.length} sources ` +
      `(${enabled.length} enabled), ${withSource.size} stations with at least one enabled source.\n`,
  );
  const missing = p.stations.filter((s) => !withSource.has(s.id));
  if (missing.length)
    process.stdout.write(`  No enabled source: ${missing.map((s) => s.displayName).join(', ')}\n`);
}

if (flag('--strict')) {
  for (const warning of packs.flatMap((p) => strictWarnings(p)))
    process.stdout.write(`Warning: ${warning}\n`);
  const problems = packs.flatMap((p) => strictProblems(p));
  for (const problem of problems) process.stderr.write(`${problem}\n`);
  if (problems.length) {
    process.stderr.write(
      `Strict checks failed: ${problems.length} problem${problems.length === 1 ? '' : 's'}.\n`,
    );
    process.exit(1);
  }
  process.stdout.write('Strict checks passed.\n');
}

if (!flag('--probe')) process.exit(0);
if (stationFilter.length === 0 && !packId) {
  process.stderr.write(
    'Name stations to probe (e.g. mypack:my-station) or a whole pack with --pack-id <id>.\n',
  );
  process.exit(2);
}

/** The FFmpeg builds to try, in order. Paths set in the environment are the only choice. */
function ffmpegCandidates(): FfmpegPaths[] {
  const { FFMPEG_PATH, FFPROBE_PATH } = process.env;
  if (FFMPEG_PATH || FFPROBE_PATH)
    return [{ ffmpeg: FFMPEG_PATH || 'ffmpeg', ffprobe: FFPROBE_PATH || 'ffprobe' }];
  const list: FfmpegPaths[] = [{ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }];
  try {
    // Dev dependencies: present in a clone after `pnpm install`, absent from the Docker image.
    const require = createRequire(import.meta.url);
    const ffmpeg = require('ffmpeg-static') as string | null;
    const ffprobe = (require('ffprobe-static') as { path: string }).path;
    if (ffmpeg) list.push({ ffmpeg, ffprobe });
  } catch {
    /* not installed */
  }
  return list;
}

const registry = new ProcessRegistry();
let found: { paths: FfmpegPaths; info: Awaited<ReturnType<typeof checkFfmpeg>> } | null = null;
for (const paths of ffmpegCandidates()) {
  try {
    found = { paths, info: await checkFfmpeg(registry, paths) };
    break;
  } catch {
    /* try the next one */
  }
}
if (!found) {
  process.stderr.write(
    'FFmpeg and FFprobe are needed for --probe, and none could be run. Install FFmpeg, run `pnpm install` ' +
      'in the bot (it brings ffmpeg-static and ffprobe-static), or set FFMPEG_PATH and FFPROBE_PATH. ' +
      'Nothing was contacted and no report was written.\n',
  );
  registry.killAll();
  process.exit(2);
}
process.stdout.write(`Using ${found.info.ffprobeVersion} (${found.paths.ffprobe}).\n`);

const sources = packs.flatMap((p) => p.sources);
const policy = new UrlPolicy({ allowInsecureHttp: true });
// The same User-Agent the bot sends: Lavf/<version> of the FFmpeg in use (invariant 5).
const client = new SafeHttpClient(
  policy,
  undefined,
  process.env.STREAM_USER_AGENT || found.info.libavformat || undefined,
);
const deps = {
  client,
  registry,
  ffmpegPath: found.paths.ffmpeg,
  ffprobePath: found.paths.ffprobe,
};
const targets = sources.filter(
  (s) =>
    s.enabled &&
    (stationFilter.includes(s.stationId) || (packId !== null && s.stationId.startsWith(`${packId}:`))),
);

interface Row {
  stationId: string;
  sourceId: string;
  outcome: ProbeOutcome;
}
const rows: Row[] = [];
for (const s of targets) {
  const outcome = await probeSource(deps, s.url);
  rows.push({ stationId: s.stationId, sourceId: s.id, outcome });
  const o = outcome;
  process.stdout.write(
    `${s.stationId.padEnd(34)} ${s.id.padEnd(44)} ` +
      (o.success
        ? `${o.transport.padEnd(15)} ${codecLabel(o.codec, o.profile).padEnd(8)} measured=${o.measuredBitrateKbps ?? '?'}kbps codec=${o.codecBitrateKbps ?? '?'} adv=${o.advertisedBitrateKbps ?? '?'} ${o.sampleRateHz ?? '?'}Hz ch=${o.channels ?? '?'} icy-name=${JSON.stringify(o.icyName)} start=${o.startupMs}ms`
        : `FAILED ${o.failureCode}: ${o.failureDetail}`) +
      '\n',
  );
}

const comparisons: Array<{ stationId: string; a: string; b: string; result: unknown }> = [];
if (flag('--compare')) {
  const byStation = new Map<string, Row[]>();
  for (const r of rows.filter((x) => x.outcome.success))
    byStation.set(r.stationId, [...(byStation.get(r.stationId) ?? []), r]);
  for (const [stationId, list] of byStation) {
    const [first, ...rest] = list;
    if (!first) continue;
    for (const other of rest) {
      const a = sources.find((s) => s.id === first.sourceId)!;
      const b = sources.find((s) => s.id === other.sourceId)!;
      try {
        const r = await compareSources(deps, a.url, b.url);
        const ev = correlationEvidence(r, first.sourceId);
        comparisons.push({ stationId, a: a.id, b: b.id, result: { ...r, verdict: ev.verdict } });
        process.stdout.write(
          `compare ${a.id} vs ${b.id}: score=${r.score} lag=${r.lagSeconds}s prominence=${r.prominence} → ${ev.verdict}\n`,
        );
      } catch (err) {
        process.stdout.write(`compare ${a.id} vs ${b.id}: failed (${(err as Error).message})\n`);
      }
    }
  }
}

if (jsonOut) {
  writeFileSync(
    jsonOut,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), probes: rows, comparisons }, null, 2)}\n`,
  );
  process.stdout.write(`Evidence written to ${jsonOut}\n`);
}
registry.killAll();
