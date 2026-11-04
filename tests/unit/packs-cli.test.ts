import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PARTIAL_STATUS, runPacksCli, UNCHANGED_STATUS } from '../../scripts/packs.ts';

/**
 * `radio-bot packs` against a pack library in a folder on disk: installing over a pack the bot
 * couldn't load, what `remove` records, and the statuses radio-bot.sh reloads the bot by.
 */

const roots: string[] = [];
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'radiobot-packs-cli-'));
  roots.push(d);
  return d;
};
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

function packFiles(id: string, version: string) {
  return {
    pack: { schemaVersion: 1, id, name: `Pack ${id}`, version, countries: ['GB'], languages: ['en'] },
    stations: { schemaVersion: 1, stations: [{ slug: `${id}-1`, displayName: `${id} one`, order: 1 }] },
    sources: {
      schemaVersion: 1,
      sources: [
        {
          id: `${id}-1-mp3`,
          station: `${id}-1`,
          url: `https://stream.example.org/${id}.mp3`,
          provenance: 'curated',
          provenanceDetail: 'Listed on the example website.',
        },
      ],
    },
  };
}

/** Writes a library folder holding the given packs; returns its index.json path. */
function library(...packs: Array<ReturnType<typeof packFiles>>): string {
  const dir = temp();
  const entries = packs.map((files) => {
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, ...files }));
    writeFileSync(join(dir, `${files.pack.id}.json`), bytes);
    return {
      id: files.pack.id,
      name: files.pack.name,
      description: '',
      version: files.pack.version,
      owner: null,
      countries: ['GB'],
      regions: [],
      languages: ['en'],
      stations: 1,
      sources: 1,
      lastChecked: null,
      minBotVersion: null,
      status: 'available',
      withdrawnReason: null,
      file: `${files.pack.id}.json`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    };
  });
  const index = { schemaVersion: 1, generatedAt: '2026-11-03T00:00:00Z', packs: entries, collections: [] };
  writeFileSync(join(dir, 'index.json'), JSON.stringify(index));
  return join(dir, 'index.json');
}

async function cli(args: string[], data: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runPacksCli(args, {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    env: { DATABASE_PATH: join(data, 'radio-bot.sqlite') },
  });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

const record = (data: string) =>
  JSON.parse(readFileSync(join(data, 'installed-packs', 'installed.json'), 'utf8')) as {
    packs: Record<string, unknown>;
    removed: string[];
  };

describe('radio-bot packs: packs that could not be loaded', () => {
  it('updates an installed pack the bot skipped, by name and with a bare update', async () => {
    const from = ['--from', library(packFiles('alpha', '2026.11.01'), packFiles('beta', '2026.11.01'))];
    const data = temp();
    expect((await cli(['add', 'alpha', 'beta', ...from], data)).code).toBe(0);
    const broken = join(data, 'installed-packs', 'alpha', 'stations.json');
    writeFileSync(broken, '{');
    expect((await cli(['list', ...from], data)).err).toMatch(/Not loaded: .*alpha/);

    // The fix troubleshooting gives for a "Not loaded" pack: update it.
    const named = await cli(['update', 'alpha', '--unchanged-status', ...from], data);
    expect(named.code).toBe(0);
    expect(named.out).toBe(
      "Replaced the copy of alpha that couldn't be loaded with Pack alpha version 2026.11.01.",
    );
    expect((await cli(['list', ...from], data)).err).toBe('');

    // A bare update doesn't fail because one installed pack was skipped: it repairs it.
    writeFileSync(broken, '{');
    const bare = await cli(['update', '--unchanged-status', ...from], data);
    expect(bare.code).toBe(0);
    expect(bare.out).toMatch(/Replaced the copy of alpha/);
    expect(bare.out).toMatch(/beta.*already up to date/);
    expect(bare.err).toBe('');
  });

  it('says there is nothing to load when no packs from that library are installed', async () => {
    const from = ['--from', library(packFiles('alpha', '2026.11.01'))];
    const data = temp();
    const r = await cli(['update', '--unchanged-status', ...from], data);
    expect(r.code).toBe(UNCHANGED_STATUS);
    expect(r.out).toMatch(/No packs from .* are installed/);
    // A pack whose folder is gone isn't updated as if it were installed.
    expect((await cli(['add', 'alpha', ...from], data)).code).toBe(0);
    rmSync(join(data, 'installed-packs', 'alpha'), { recursive: true });
    expect((await cli(['update', '--unchanged-status', ...from], data)).code).toBe(UNCHANGED_STATUS);
  });
});

describe('radio-bot packs remove', () => {
  it('refuses a name that is not installed, or not a pack name, without recording it as removed', async () => {
    const from = ['--from', library(packFiles('alpha', '2026.11.01'))];
    const data = temp();
    expect((await cli(['add', 'alpha', ...from], data)).code).toBe(0);
    const ghost = await cli(['remove', 'ghost'], data);
    expect(ghost.code).toBe(1);
    expect(ghost.err).toBe("ghost isn't installed. See the installed packs with: radio-bot packs");
    const bad = await cli(['remove', '../alpha', 'alpha'], data);
    expect(bad.err).toMatch(/^"\.\.\/alpha" isn't a pack name/);
    // The loop carries on past a bad name: alpha is still removed.
    expect(bad.out).toMatch(/^Removed alpha\./);
    expect(bad.code).toBe(1);
    expect(record(data).removed).toEqual(['alpha']);
    expect(existsSync(join(data, 'installed-packs', 'alpha'))).toBe(false);
  });

  it('reports a partial removal with its own status when asked, and removes a pack known only to the record', async () => {
    const from = ['--from', library(packFiles('alpha', '2026.11.01'), packFiles('beta', '2026.11.01'))];
    const data = temp();
    expect((await cli(['add', 'alpha', 'beta', ...from], data)).code).toBe(0);
    const partial = await cli(['remove', 'alpha', 'ghost', '--unchanged-status'], data);
    expect(partial.code).toBe(PARTIAL_STATUS);
    expect((await cli(['remove', 'ghost', '--unchanged-status'], data)).code).toBe(1);
    // Its folder was deleted by hand, but the record still names it: removing it is remembered.
    rmSync(join(data, 'installed-packs', 'beta'), { recursive: true });
    const recorded = await cli(['remove', 'beta', '--unchanged-status'], data);
    expect(recorded.code).toBe(0);
    expect(record(data).removed).toEqual(['alpha', 'beta']);
    expect(record(data).packs).toEqual({});
  });
});

describe('radio-bot packs add', () => {
  it('reports a partial install with its own status when asked, and plain failure otherwise', async () => {
    const from = ['--from', library(packFiles('alpha', '2026.11.01'))];
    const data = temp();
    const partial = await cli(['add', 'alpha', 'nope', '--unchanged-status', ...from], data);
    expect(partial.code).toBe(PARTIAL_STATUS);
    expect(partial.err).toMatch(/no pack called "nope"/);
    expect((await cli(['add', 'alpha', 'nope', ...from], data)).code).toBe(1);
    expect((await cli(['add', 'nope', '--unchanged-status', ...from], data)).code).toBe(1);
  });

  it('names collections by their ID in its help', async () => {
    const help = (await cli(['help'], temp())).out;
    expect(help).toContain('--collection <id>');
    expect(help).not.toContain('--collection <name>');
  });
});
