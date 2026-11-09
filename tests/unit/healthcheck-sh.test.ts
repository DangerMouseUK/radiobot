import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type HealthSnapshot, writeHeartbeat } from '../../src/observability/health.ts';
import { checkHeartbeat } from '../../src/observability/heartbeat-check.ts';
import { rootPath } from '../../src/shared/paths.ts';

// scripts/healthcheck.sh is the Docker image's HEALTHCHECK: the same rules as checkHeartbeat(), with
// no Node start. These tests keep the two in step.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'radiobot-healthcheck-'));
  dirs.push(d);
  return d;
};

const beat = (o: Partial<HealthSnapshot> = {}, ageMs = 0): HealthSnapshot => ({
  at: new Date(Date.now() - ageMs).toISOString(),
  pid: 1,
  discordReady: true,
  activeStreams: 0,
  ffmpegProcesses: 0,
  dbOk: true,
  ffmpegOk: true,
  ...o,
});

/** Writes a heartbeat as the bot does, with the file's modified time set to its `at`. */
async function write(path: string, snap: HealthSnapshot): Promise<void> {
  await writeHeartbeat(path, snap);
  const at = new Date(snap.at);
  utimesSync(path, at, at);
}

describe('the heartbeat file', () => {
  it('is one line of JSON with no spaces, which the shell healthcheck relies on', async () => {
    const path = join(tempDir(), 'health.json');
    await writeHeartbeat(path, beat({ discordReady: false, ffmpegOk: false }));
    const text = readFileSync(path, 'utf8');
    expect(text).not.toMatch(/\n/);
    expect(text).toMatch(/^\{.*\}$/);
    for (const field of ['"dbOk":true', '"discordReady":false', '"ffmpegOk":false'])
      expect(text).toContain(field);
  });
});

// The image is Linux, and the script uses GNU find's fractional -mmin (BSD find, on macOS, rounds).
describe.runIf(process.platform === 'linux')('scripts/healthcheck.sh', () => {
  const script = rootPath('scripts', 'healthcheck.sh');
  const run = (env: Record<string, string>, cwd?: string) => {
    const r = spawnSync('sh', [script], {
      cwd,
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
      timeout: 10_000,
    });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  const cases: { name: string; snap?: Partial<HealthSnapshot>; ageMs?: number; out: string }[] = [
    { name: 'a fresh, healthy heartbeat', out: 'healthy: ok' },
    { name: 'a heartbeat 60 s old', ageMs: 60_000, out: 'healthy: ok' },
    { name: 'a heartbeat 100 s old', ageMs: 100_000, out: 'unhealthy: heartbeat is more than 90 s old' },
    { name: 'a failed database check', snap: { dbOk: false }, out: 'unhealthy: database check failed' },
    {
      name: 'a bot not connected to Discord',
      snap: { discordReady: false },
      out: 'unhealthy: not connected to Discord',
    },
    {
      name: 'FFmpeg without libopus',
      snap: { ffmpegOk: false },
      out: 'unhealthy: ffmpeg unavailable or missing libopus',
    },
    { name: 'an older heartbeat with no ffmpegOk', snap: { ffmpegOk: undefined }, out: 'healthy: ok' },
  ];

  for (const c of cases) {
    it(`agrees with checkHeartbeat() on ${c.name}`, async () => {
      const dir = tempDir();
      const path = join(dir, 'health.json');
      await write(path, beat(c.snap, c.ageMs));
      const node = checkHeartbeat(path);
      const r = run({ DATABASE_PATH: join(dir, 'radio-bot.sqlite') });
      expect(r.err).toBe('');
      expect(r.out).toBe(`${c.out}\n`);
      expect(r.code).toBe(node.healthy ? 0 : 1);
      // The reasons match too, except for the age, which the script doesn't work out.
      if (!c.ageMs || node.healthy)
        expect(r.out).toBe(`${node.healthy ? 'healthy' : 'unhealthy'}: ${node.reason}\n`);
    });
  }

  it('reports a missing or unreadable heartbeat', async () => {
    const dir = tempDir();
    const env = { DATABASE_PATH: join(dir, 'radio-bot.sqlite') };
    expect(run(env)).toEqual({ code: 1, out: 'unhealthy: no heartbeat file\n', err: '' });
    writeFileSync(join(dir, 'health.json'), '');
    expect(run(env)).toEqual({ code: 1, out: 'unhealthy: no heartbeat file\n', err: '' });
    writeFileSync(join(dir, 'health.json'), 'not json');
    expect(run(env)).toEqual({ code: 1, out: 'unhealthy: no heartbeat file\n', err: '' });
  });

  it('defaults to ./data/health.json in the working directory, as the Node check does', async () => {
    const dir = tempDir();
    expect(run({}, dir).out).toBe('unhealthy: no heartbeat file\n');
    mkdirSync(join(dir, 'data'));
    await write(join(dir, 'data', 'health.json'), beat());
    expect(run({}, dir)).toEqual({ code: 0, out: 'healthy: ok\n', err: '' });
  });
});
