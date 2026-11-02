import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeHeartbeat } from '../../src/observability/health.ts';
import { Db } from '../../src/persistence/db.ts';
import { projectRoot } from '../../src/shared/paths.ts';

/** Runs an operator script from source (Node strips the types) with a clean environment. */
function run(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [join(projectRoot(), 'scripts', script), ...args], {
    cwd: projectRoot(),
    env: { PATH: process.env.PATH ?? '', SYSTEMROOT: process.env.SYSTEMROOT ?? '', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'radiobot-scripts-'));
  dirs.push(d);
  return d;
};

describe('scripts/validate-catalogue', () => {
  it('validates the built-in packs offline', () => {
    const r = run('validate-catalogue.ts');
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Pack "fg" \(Radio FG\) OK: 63 stations, \d+ sources/);
    expect(r.out).toMatch(/63 stations with at least one enabled source/);
    expect(r.out).not.toMatch(/No enabled source/);
  });

  it('fails with a message for a broken pack folder', () => {
    const dir = join(tempDir(), 'broken');
    mkdirSync(dir);
    writeFileSync(join(dir, 'pack.json'), '{"schemaVersion":1,"id":"Bad Id","name":"x"}');
    const r = run('validate-catalogue.ts', ['--pack', dir]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/Invalid pack: .*pack\.json is invalid/);
  });

  it('validates a single pack folder and lists stations without an enabled source', () => {
    const dir = join(tempDir(), 'mypack');
    mkdirSync(dir);
    writeFileSync(join(dir, 'pack.json'), '{"schemaVersion":1,"id":"mypack","name":"My Pack"}');
    writeFileSync(
      join(dir, 'stations.json'),
      JSON.stringify({
        schemaVersion: 1,
        stations: [
          { slug: 'my-station', displayName: 'My Station', order: 1 },
          { slug: 'quiet', displayName: 'Quiet Station', order: 2 },
        ],
      }),
    );
    writeFileSync(
      join(dir, 'sources.json'),
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            id: 'my-station-a',
            station: 'my-station',
            url: 'https://radio.example.org/a',
            provenance: 'curated',
            provenanceDetail: 'Listed on the station website.',
          },
        ],
      }),
    );
    const r = run('validate-catalogue.ts', ['--pack', dir]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      'Pack "mypack" (My Pack) OK: 2 stations, 1 sources (1 enabled), 1 stations with at least one enabled source.\n' +
        '  No enabled source: Quiet Station\n',
    );
  });

  it('refuses to probe without a target', () => {
    const r = run('validate-catalogue.ts', ['--probe']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Name stations to probe/);
  });
});

describe('scripts/healthcheck', () => {
  it('exits 1 without a heartbeat and 0 with a fresh one', () => {
    const dir = tempDir();
    const env = { DATABASE_PATH: join(dir, 'radio-bot.sqlite') };
    const missing = run('healthcheck.ts', [], env);
    expect(missing.code).toBe(1);
    expect(missing.out).toBe('unhealthy: no heartbeat file\n');
    writeHeartbeat(join(dir, 'health.json'), {
      at: new Date().toISOString(),
      pid: 1,
      discordReady: true,
      activeStreams: 0,
      ffmpegProcesses: 0,
      dbOk: true,
    });
    const ok = run('healthcheck.ts', [], env);
    expect(ok.code).toBe(0);
    expect(ok.out).toBe('healthy: ok\n');
  });
});

describe('scripts/register-commands', () => {
  // Only the configuration check runs here: it fails before any request could reach Discord.
  it('stops with the configuration errors when the token and application ID are missing', () => {
    const r = run('register-commands.ts', ['123456789012345678']);
    expect(r.code).not.toBe(0);
    expect(r.out).toBe('');
    expect(r.err).toMatch(/Invalid configuration/);
    expect(r.err).toMatch(/- DISCORD_TOKEN: /);
    expect(r.err).toMatch(/- DISCORD_APPLICATION_ID: /);
  });
});

describe('scripts/backup', () => {
  it('writes a manual backup next to the database', () => {
    const dir = tempDir();
    const dbPath = join(dir, 'radio-bot.sqlite');
    const db = new Db(dbPath);
    db.migrate();
    db.close();
    const r = run('backup.ts', [], { DATABASE_PATH: dbPath });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Backup written: .*radio-bot-manual-.*\.sqlite\n$/);
    expect(readdirSync(join(dir, 'backups')).filter((f) => f.startsWith('radio-bot-manual-'))).toHaveLength(
      1,
    );
  });

  it('fails instead of backing up a new empty database when the path is wrong', () => {
    const dir = tempDir();
    const r = run('backup.ts', [], { DATABASE_PATH: join(dir, 'missing.sqlite') });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/No database at .*missing\.sqlite/);
    expect(readdirSync(dir)).toEqual([]);
  });
});
