import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HealthSnapshot } from '../../src/observability/health.ts';

/** Every heartbeat write, from writing the temporary file until it is renamed into place. */
const io = { active: 0, peak: 0, writes: [] as string[], release: [] as Array<() => void>, hold: false };

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: async (path: string, data: string) => {
      io.active++;
      io.peak = Math.max(io.peak, io.active);
      io.writes.push(data);
      if (io.hold) await new Promise<void>((resolve) => io.release.push(resolve));
      try {
        await actual.writeFile(path, data);
      } catch (err) {
        io.active--;
        throw err;
      }
    },
    rename: async (from: string, to: string) => {
      try {
        await actual.rename(from, to);
      } finally {
        io.active--;
      }
    },
  };
});

const { HeartbeatWriter, checkHeartbeat } = await import('../../src/observability/health.ts');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  Object.assign(io, { active: 0, peak: 0, writes: [], release: [], hold: false });
});

const snap = (activeStreams: number): HealthSnapshot => ({
  at: new Date().toISOString(),
  pid: 1,
  discordReady: true,
  activeStreams,
  ffmpegProcesses: activeStreams,
  dbOk: true,
  ffmpegOk: true,
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'radiobot-hb-writer-'));
  dirs.push(dir);
  const path = join(dir, 'data', 'health.json');
  const errors: unknown[] = [];
  return { dir, path, errors, writer: new HeartbeatWriter(path, (err) => errors.push(err)) };
}

describe('HeartbeatWriter', () => {
  it('writes the same JSON as before, atomically, creating the folder if needed', async () => {
    const t = setup();
    const s = snap(3);
    await t.writer.write(s);
    expect(readFileSync(t.path, 'utf8')).toBe(JSON.stringify(s));
    expect(checkHeartbeat(t.path)).toEqual({ healthy: true, reason: 'ok' });
    expect(t.errors).toEqual([]);
  });

  it('never overlaps two writes, and writes only the newest of those that waited', async () => {
    const t = setup();
    io.hold = true;
    const first = t.writer.write(snap(1));
    // Asked for while the first is still being written: only the last of these is written.
    const second = t.writer.write(snap(2));
    const third = t.writer.write(snap(3));
    await vi.waitFor(() => expect(io.release).toHaveLength(1));
    io.hold = false;
    io.release.shift()!();
    await Promise.all([first, second, third]);
    expect(io.peak).toBe(1);
    expect(io.writes.map((w) => JSON.parse(w).activeStreams)).toEqual([1, 3]);
    expect(JSON.parse(readFileSync(t.path, 'utf8')).activeStreams).toBe(3);
  });

  it('passes a failed write to its error handler and carries on with the next one', async () => {
    const t = setup();
    // A folder where the temporary file goes makes the write fail.
    mkdirSync(join(t.dir, 'data', 'health.json.tmp'), { recursive: true });
    await t.writer.write(snap(1));
    expect(t.errors).toHaveLength(1);
    rmSync(join(t.dir, 'data', 'health.json.tmp'), { recursive: true });
    await t.writer.write(snap(2));
    expect(JSON.parse(readFileSync(t.path, 'utf8')).activeStreams).toBe(2);
    expect(t.errors).toHaveLength(1);
  });
});
