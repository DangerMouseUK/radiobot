/**
 * Runs the operator scripts inside the test process, so their code paths are measured and the
 * parts that would reach the network (live probes, Discord) can be replaced with fakes. The
 * child-process tests in scripts.test.ts cover the same scripts end to end.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeHeartbeat } from '../../src/observability/health.ts';
import { Db } from '../../src/persistence/db.ts';
import type { ProbeOutcome } from '../../src/streams/probe.ts';
import { memoryDb, silentLogger } from '../helpers.ts';

const mocks = vi.hoisted(() => ({
  probe: vi.fn(),
  compare: vi.fn(),
  setPriority: vi.fn(),
  restGet: vi.fn(),
  restPut: vi.fn(),
  tokens: [] as string[],
}));

vi.mock('../../src/streams/probe.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/streams/probe.ts')>()),
  probeSource: mocks.probe,
}));
vi.mock('../../src/streams/identity.ts', async (orig) => ({
  ...(await orig<typeof import('../../src/streams/identity.ts')>()),
  compareSources: mocks.compare,
}));
// The backup script lowers its own priority; inside the test worker that must not happen for real.
vi.mock('node:os', async (orig) => ({
  ...(await orig<typeof import('node:os')>()),
  setPriority: mocks.setPriority,
}));
// No request may reach Discord: REST is replaced by a recorder.
vi.mock('discord.js', async (orig) => {
  const real = await orig<typeof import('discord.js')>();
  class FakeRest {
    setToken(token: string) {
      mocks.tokens.push(token);
      return this;
    }
    get(route: string) {
      return mocks.restGet(route);
    }
    put(route: string, body: unknown) {
      return mocks.restPut(route, body);
    }
  }
  return { ...real, REST: FakeRest };
});

class ExitCalled extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

const SCRIPTS = {
  'validate-catalogue.ts': () => import('../../scripts/validate-catalogue.ts'),
  'healthcheck.ts': () => import('../../scripts/healthcheck.ts'),
  'backup.ts': () => import('../../scripts/backup.ts'),
  'register-commands.ts': () => import('../../scripts/register-commands.ts'),
} as const;

/** Imports a script afresh with the given arguments and captures its output and exit code. */
async function runScript(name: keyof typeof SCRIPTS, args: string[] = []) {
  vi.resetModules();
  const savedArgv = process.argv;
  process.argv = [process.execPath, name, ...args];
  let out = '';
  let err = '';
  const capture =
    (sink: (s: string) => void) =>
    (chunk: string | Uint8Array): boolean => {
      sink(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    };
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(capture((s) => (out += s)) as never);
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(capture((s) => (err += s)) as never);
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as never);
  let code: number | null = null;
  try {
    await SCRIPTS[name]();
  } catch (e) {
    if (e instanceof ExitCalled) code = e.code;
    else throw e;
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
    process.argv = savedArgv;
  }
  return { code, out, err };
}

const dirs: string[] = [];
const savedCwd = process.cwd();
beforeEach(() => {
  mocks.probe.mockReset();
  mocks.compare.mockReset();
  mocks.setPriority.mockReset();
  mocks.restGet.mockReset();
  mocks.restPut.mockReset();
  mocks.tokens.length = 0;
});
afterEach(() => {
  process.chdir(savedCwd);
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'radiobot-scripts-ip-'));
  dirs.push(d);
  return d;
};

const source = (id: string, station: string, extra: object = {}) => ({
  id,
  station,
  url: `https://radio.example.org/${id}`,
  provenance: 'curated',
  provenanceDetail: 'Listed on the station website.',
  ...extra,
});

/** Writes a pack folder named `mypack` with three stations; `three` has only a disabled source. */
function writePack(root: string, id = 'mypack'): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'pack.json'), JSON.stringify({ schemaVersion: 1, id, name: 'My Pack' }));
  writeFileSync(
    join(dir, 'stations.json'),
    JSON.stringify({
      schemaVersion: 1,
      stations: [
        { slug: 'one', displayName: 'Station One', order: 1 },
        { slug: 'two', displayName: 'Station Two', order: 2 },
        { slug: 'three', displayName: 'Station Three', order: 3 },
      ],
    }),
  );
  writeFileSync(
    join(dir, 'sources.json'),
    JSON.stringify({
      schemaVersion: 1,
      sources: [
        source('one-a', 'one'),
        source('one-b', 'one'),
        source('one-c', 'one'),
        source('two-a', 'two'),
        source('three-a', 'three', { enabled: false, disabledReason: 'Host gone.' }),
      ],
    }),
  );
  return dir;
}

const outcome = (o: Partial<ProbeOutcome>): ProbeOutcome =>
  ({
    success: true,
    failureCode: null,
    failureDetail: null,
    startedAt: new Date(0).toISOString(),
    durationMs: 10,
    startupMs: 120,
    transport: 'http-continuous',
    effectiveHost: 'radio.example.org',
    container: 'mp3',
    codec: 'mp3',
    profile: null,
    sampleRateHz: 44_100,
    channels: 2,
    channelLayout: 'stereo',
    advertisedBitrateKbps: 128,
    codecBitrateKbps: 128,
    measuredBitrateKbps: 127,
    networkKbps: 130,
    bitrateEvidence: 'measured',
    sampleSeconds: 8,
    decodedSeconds: 8,
    decodeErrors: 0,
    icyName: 'My Station',
    icyTitle: null,
    headersSummary: {},
    manifestSummary: {},
    ...o,
  }) as ProbeOutcome;

describe('validate-catalogue (in process)', () => {
  it('reports a valid pack and names stations without an enabled source', async () => {
    const dir = writePack(tempDir());
    const r = await runScript('validate-catalogue.ts', ['--pack', dir]);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toBe(
      'Pack "mypack" (My Pack) OK: 3 stations, 5 sources (4 enabled), 2 stations with at least one enabled source.\n' +
        '  No enabled source: Station Three\n',
    );
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it('adds packs from EXTRA_PACKS_DIR to the built-in ones', async () => {
    const extra = tempDir();
    writePack(extra);
    vi.stubEnv('EXTRA_PACKS_DIR', extra);
    const r = await runScript('validate-catalogue.ts');
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^Pack "mypack" \(My Pack\) OK: 3 stations/m);
    // The bundled pack is validated too.
    expect(r.out.match(/^Pack "/gm)!.length).toBeGreaterThan(1);
  });

  it('validates only the bundled packs without EXTRA_PACKS_DIR, even when --pack has no value', async () => {
    vi.stubEnv('EXTRA_PACKS_DIR', '');
    const r = await runScript('validate-catalogue.ts', ['--pack']);
    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toMatch(/^Pack "[a-z0-9-]+" \(.+\) OK: \d+ stations/);
    expect(r.out).not.toContain('mypack');
  });

  it('exits 1 with the reason when a pack folder is invalid or missing', async () => {
    const dir = writePack(tempDir());
    writeFileSync(join(dir, 'stations.json'), '{"schemaVersion":1,"stations":[{"slug":"Bad Slug"}]}');
    const bad = await runScript('validate-catalogue.ts', ['--pack', dir]);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/^Invalid pack: /);
    expect(bad.out).toBe('');
    const missing = await runScript('validate-catalogue.ts', ['--pack', join(tempDir(), 'nowhere')]);
    expect(missing.code).toBe(1);
    expect(missing.err).toMatch(/^Invalid pack: /);
  });

  it('exits 2 when asked to probe without naming stations or a pack', async () => {
    const dir = writePack(tempDir());
    const r = await runScript('validate-catalogue.ts', ['--pack', dir, '--probe']);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/Name stations to probe \(e\.g\. mypack:my-station\)/);
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it('probes only the named stations’ enabled sources and prints each outcome', async () => {
    const dir = writePack(tempDir());
    mocks.probe.mockImplementation(async (_deps: unknown, url: string) =>
      url.endsWith('two-a')
        ? outcome({ success: false, failureCode: 'ACCESS_DENIED', failureDetail: 'HTTP 403' })
        : outcome({}),
    );
    const r = await runScript('validate-catalogue.ts', ['--pack', dir, '--probe', 'mypack:two']);
    expect(r.code).toBeNull();
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    expect(mocks.probe.mock.calls[0]![1]).toBe('https://radio.example.org/two-a');
    expect(r.out).toMatch(/mypack:two\s+two-a\s+FAILED ACCESS_DENIED: HTTP 403\n$/);
    expect(mocks.compare).not.toHaveBeenCalled();
  });

  it('probes a whole pack, compares sources of one station and writes the evidence file', async () => {
    const root = tempDir();
    const dir = writePack(root);
    const jsonPath = join(root, 'evidence.json');
    mocks.probe.mockImplementation(async (_deps: unknown, url: string) =>
      url.endsWith('one-a')
        ? outcome({ profile: 'LC', codec: 'aac', icyName: null })
        : url.endsWith('two-a')
          ? outcome({
              measuredBitrateKbps: null,
              codecBitrateKbps: null,
              advertisedBitrateKbps: null,
              sampleRateHz: null,
              channels: null,
            })
          : outcome({}),
    );
    mocks.compare.mockImplementation(async (_deps: unknown, _a: string, b: string) => {
      if (b.endsWith('one-c')) throw new Error('capture failed');
      return { score: 0.93, lagSeconds: 1.5, prominence: 7.5 };
    });
    const r = await runScript('validate-catalogue.ts', [
      '--pack',
      dir,
      '--probe',
      '--pack-id',
      'mypack',
      '--compare',
      '--json',
      jsonPath,
    ]);
    expect(r.code).toBeNull();
    // Every enabled source of the pack, and never the disabled one.
    expect(mocks.probe.mock.calls.map((c) => c[1])).toEqual([
      'https://radio.example.org/one-a',
      'https://radio.example.org/one-b',
      'https://radio.example.org/one-c',
      'https://radio.example.org/two-a',
    ]);
    expect(r.out).toMatch(
      /one-a\s+http-continuous\s+AAC-LC\s+measured=127kbps codec=128 adv=128 44100Hz ch=2/,
    );
    expect(r.out).toMatch(/icy-name=null start=120ms/);
    expect(r.out).toMatch(/two-a\s+http-continuous\s+MP3\s+measured=\?kbps codec=\? adv=\? \?Hz ch=\?/);
    expect(r.out).toMatch(/compare one-a vs one-b: score=0\.93 lag=1\.5s prominence=7\.5 → supports\n/);
    expect(r.out).toMatch(/compare one-a vs one-c: failed \(capture failed\)\n/);
    expect(r.out).toContain(`Evidence written to ${jsonPath}\n`);
    // Only sources of the same station are compared.
    expect(mocks.compare).toHaveBeenCalledTimes(2);
    const report = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
      generatedAt: string;
      probes: Array<{ stationId: string; sourceId: string }>;
      comparisons: Array<{ stationId: string; a: string; b: string; result: { verdict: string } }>;
    };
    expect(report.probes.map((p) => p.sourceId)).toEqual(['one-a', 'one-b', 'one-c', 'two-a']);
    expect(report.comparisons).toEqual([
      {
        stationId: 'mypack:one',
        a: 'one-a',
        b: 'one-b',
        result: { score: 0.93, lagSeconds: 1.5, prominence: 7.5, verdict: 'supports' },
      },
    ]);
  });

  it('skips the comparison for stations with a single working source', async () => {
    const dir = writePack(tempDir());
    vi.stubEnv('FFMPEG_PATH', undefined);
    vi.stubEnv('FFPROBE_PATH', undefined);
    vi.stubEnv('STREAM_USER_AGENT', 'Lavf/60.16.100');
    mocks.probe.mockImplementation(async (_deps: unknown, url: string) =>
      url.endsWith('one-a') ? outcome({}) : outcome({ success: false, failureCode: 'HTTP_TIMEOUT' }),
    );
    const r = await runScript('validate-catalogue.ts', ['--pack', dir, '--probe', 'mypack:one', '--compare']);
    expect(r.code).toBeNull();
    expect(mocks.probe).toHaveBeenCalledTimes(3);
    // Without FFMPEG_PATH / FFPROBE_PATH the binaries come from PATH; STREAM_USER_AGENT is honoured.
    const deps = mocks.probe.mock.calls[0]![0] as {
      ffmpegPath: string;
      ffprobePath: string;
      client: { userAgent: string };
    };
    expect(deps.ffmpegPath).toBe('ffmpeg');
    expect(deps.ffprobePath).toBe('ffprobe');
    expect(deps.client.userAgent).toBe('Lavf/60.16.100');
    expect(mocks.compare).not.toHaveBeenCalled();
    expect(r.out).not.toMatch(/compare /);
  });
});

describe('healthcheck (in process)', () => {
  const beat = (o: object = {}) => ({
    at: new Date().toISOString(),
    pid: 1,
    discordReady: true,
    activeStreams: 0,
    ffmpegProcesses: 0,
    dbOk: true,
    ...o,
  });

  it('reads health.json next to DATABASE_PATH and exits 0 only when healthy', async () => {
    const dir = tempDir();
    vi.stubEnv('DATABASE_PATH', join(dir, 'radio-bot.sqlite'));
    expect(await runScript('healthcheck.ts')).toEqual({
      code: 1,
      out: 'unhealthy: no heartbeat file\n',
      err: '',
    });
    await writeHeartbeat(join(dir, 'health.json'), beat({ discordReady: false }));
    expect((await runScript('healthcheck.ts')).out).toBe('unhealthy: not connected to Discord\n');
    await writeHeartbeat(join(dir, 'health.json'), beat());
    expect(await runScript('healthcheck.ts')).toEqual({ code: 0, out: 'healthy: ok\n', err: '' });
  });

  it('defaults to ./data/health.json in the working directory', async () => {
    const dir = tempDir();
    vi.stubEnv('DATABASE_PATH', undefined);
    process.chdir(dir);
    expect((await runScript('healthcheck.ts')).code).toBe(1);
    mkdirSync(join(dir, 'data'));
    await writeHeartbeat(join(dir, 'data', 'health.json'), beat());
    expect(await runScript('healthcheck.ts')).toEqual({ code: 0, out: 'healthy: ok\n', err: '' });
  });
});

describe('backup (in process)', () => {
  const makeDb = (path: string) => {
    const db = new Db(path);
    db.migrate();
    db.close();
  };

  it('lowers its priority, then writes a manual backup next to the database', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'radio-bot.sqlite');
    makeDb(dbPath);
    vi.stubEnv('DATABASE_PATH', dbPath);
    const r = await runScript('backup.ts');
    expect(r.code).toBeNull();
    expect(mocks.setPriority).toHaveBeenCalledOnce();
    expect(r.out).toMatch(/^Backup written: .*radio-bot-manual-.*\.sqlite\n$/);
    expect(readdirSync(join(dir, 'backups'))).toHaveLength(1);
  });

  it('still backs up when the host refuses a lower priority', async () => {
    const dir = tempDir();
    const dbPath = join(dir, 'radio-bot.sqlite');
    makeDb(dbPath);
    vi.stubEnv('DATABASE_PATH', dbPath);
    mocks.setPriority.mockImplementation(() => {
      throw new Error('EACCES');
    });
    const r = await runScript('backup.ts');
    expect(r.code).toBeNull();
    expect(r.out).toMatch(/^Backup written: /);
  });

  it('refuses to back up a database that does not exist, including the default path', async () => {
    const dir = tempDir();
    vi.stubEnv('DATABASE_PATH', join(dir, 'missing.sqlite'));
    const r = await runScript('backup.ts');
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/No database at .*missing\.sqlite; check DATABASE_PATH\./);
    expect(readdirSync(dir)).toEqual([]);
    vi.stubEnv('DATABASE_PATH', undefined);
    process.chdir(dir);
    const dflt = await runScript('backup.ts');
    expect(dflt.code).toBe(1);
    expect(dflt.err).toContain('No database at ./data/radio-bot.sqlite');
  });
});

describe('registerGuildCommands (Discord replaced by a recorder)', () => {
  const APP = '123456789012345678';
  const G1 = '111111111111111111';
  const G2 = '222222222222222222';

  it('skips guilds whose stored definition hash is current, unless forced', async () => {
    const { commandsHash, registerGuildCommands } = await import('../../src/discord/register.ts');
    const { buildRadioCommand } = await import('../../src/discord/commands/definitions.ts');
    const { meta } = memoryDb();
    const logger = silentLogger();
    const info = vi.spyOn(logger, 'info');
    mocks.restPut.mockResolvedValue([]);

    expect(await registerGuildCommands('replace-with-your-bot-token', APP, [G1, G2], meta, logger)).toBe(2);
    expect(mocks.tokens).toEqual(['replace-with-your-bot-token']);
    expect(mocks.restPut).toHaveBeenCalledWith(`/applications/${APP}/guilds/${G1}/commands`, {
      body: [buildRadioCommand()],
    });
    expect(meta.get(`commands.hash.${G1}`)).toBe(commandsHash());
    expect(info).toHaveBeenCalledWith({ updated: 2 }, 'slash commands registered');

    // Unchanged definition: nothing is sent and nothing is logged.
    mocks.restPut.mockClear();
    info.mockClear();
    expect(await registerGuildCommands('replace-with-your-bot-token', APP, [G1, G2], meta, logger)).toBe(0);
    expect(mocks.restPut).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();

    // A stale hash for one guild re-registers only that guild; force re-registers both.
    meta.set(`commands.hash.${G2}`, 'stale');
    expect(await registerGuildCommands('replace-with-your-bot-token', APP, [G1, G2], meta, logger)).toBe(1);
    expect(mocks.restPut.mock.calls.map((c) => c[0])).toEqual([`/applications/${APP}/guilds/${G2}/commands`]);
    expect(
      await registerGuildCommands('replace-with-your-bot-token', APP, [G1, G2], meta, logger, true),
    ).toBe(2);
    expect(commandsHash()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('logs a failed guild without storing its hash, and works without a meta store', async () => {
    const { registerGuildCommands } = await import('../../src/discord/register.ts');
    const { meta } = memoryDb();
    const logger = silentLogger();
    const warn = vi.spyOn(logger, 'warn');
    mocks.restPut.mockImplementation(async (route: string) => {
      if (route.includes(G2)) throw new Error('Missing Access at https://discord.example.com/x?token=abc');
      return [];
    });
    expect(await registerGuildCommands('replace-with-your-bot-token', APP, [G1, G2], meta, logger)).toBe(1);
    expect(meta.get(`commands.hash.${G2}`)).toBeNull();
    expect(warn).toHaveBeenCalledOnce();
    const [fields, msg] = warn.mock.calls[0] as unknown as [
      { guildId: string; err: { message: string } },
      string,
    ];
    expect(msg).toBe('command registration failed for guild');
    expect(fields.guildId).toBe(G2);
    expect(fields.err.message).not.toContain('token=abc');
    expect(await registerGuildCommands('replace-with-your-bot-token', APP, [G1], null, logger)).toBe(1);
  });
});

describe('register-commands (in process, Discord replaced by a recorder)', () => {
  const TOKEN = 'replace-with-your-bot-token';
  const APP = '123456789012345678';
  const env = (extra: Record<string, string> = {}) => {
    vi.stubEnv('DISCORD_TOKEN', TOKEN);
    vi.stubEnv('DISCORD_APPLICATION_ID', APP);
    vi.stubEnv('DISCORD_DEV_GUILD_ID', '');
    vi.stubEnv('LOG_LEVEL', 'silent');
    for (const [k, v] of Object.entries(extra)) vi.stubEnv(k, v);
  };

  it('registers in the guilds named on the command line, ignoring other arguments', async () => {
    env();
    mocks.restPut.mockResolvedValue([]);
    const r = await runScript('register-commands.ts', [
      '111111111111111111',
      'nonsense',
      '222222222222222222',
    ]);
    expect(r.code).toBeNull();
    expect(r.out).toBe('Registered /radio in 2 of 2 guild(s).\n');
    expect(mocks.restPut.mock.calls.map((c) => c[0])).toEqual([
      `/applications/${APP}/guilds/111111111111111111/commands`,
      `/applications/${APP}/guilds/222222222222222222/commands`,
    ]);
    expect(mocks.restGet).not.toHaveBeenCalled();
    expect(mocks.tokens.every((t) => t === TOKEN)).toBe(true);
  });

  it('falls back to DISCORD_DEV_GUILD_ID', async () => {
    env({ DISCORD_DEV_GUILD_ID: '333333333333333333' });
    mocks.restPut.mockResolvedValue([]);
    const r = await runScript('register-commands.ts');
    expect(r.out).toBe('Registered /radio in 1 of 1 guild(s).\n');
    expect(mocks.restPut.mock.calls[0]![0]).toBe(`/applications/${APP}/guilds/333333333333333333/commands`);
  });

  it('otherwise asks Discord for every guild the bot is in, and counts failures', async () => {
    env();
    mocks.restGet.mockResolvedValue([{ id: '444444444444444444' }, { id: '555555555555555555' }]);
    mocks.restPut.mockImplementation(async (route: string) => {
      if (route.includes('555555555555555555')) throw new Error('Missing Access');
      return [];
    });
    const r = await runScript('register-commands.ts');
    expect(mocks.restGet).toHaveBeenCalledWith('/users/@me/guilds');
    expect(r.out).toBe('Registered /radio in 1 of 2 guild(s).\n');
  });

  it('stops on invalid configuration before contacting Discord', async () => {
    vi.stubEnv('DISCORD_TOKEN', '');
    vi.stubEnv('DISCORD_APPLICATION_ID', '');
    await expect(runScript('register-commands.ts', ['111111111111111111'])).rejects.toThrow(
      /Invalid configuration/,
    );
    expect(mocks.restGet).not.toHaveBeenCalled();
    expect(mocks.restPut).not.toHaveBeenCalled();
  });
});
