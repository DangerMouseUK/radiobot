import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkFfmpeg,
  lowerPriority,
  ProcessRegistry,
  runWithInput,
  StderrTail,
  spawnTracked,
  terminate,
} from '../../src/audio/ffmpeg.ts';

/**
 * Process handling, exercised with Node itself standing in for FFmpeg (`node -e …`), so every
 * case runs a real child process without needing FFmpeg or any audio.
 */
const NODE = process.execPath;
const MISSING = 'C:\\no-such-dir\\no-such-ffmpeg-binary';
const registry = new ProcessRegistry();
afterAll(() => registry.killAll());
afterEach(() => vi.useRealTimers());

const opts = (o: Partial<Parameters<typeof runWithInput>[4]> = {}) => ({
  owner: 'test',
  kind: 'check',
  timeoutMs: 10_000,
  ...o,
});

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('condition not met in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A child process that does nothing until told to: for timing the SIGTERM → SIGKILL escalation. */
class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  signals: string[] = [];
  stdinDestroyed = false;
  killThrows = false;
  readonly stdin = { destroy: () => (this.stdinDestroyed = true) };
  kill(signal: string) {
    this.signals.push(signal);
    if (this.killThrows) throw new Error('ESRCH');
    return true;
  }
}

describe('ProcessRegistry', () => {
  it('counts, groups and reaps the processes it owns', async () => {
    const r = new ProcessRegistry();
    const keep = 'setTimeout(() => {}, 30_000)';
    const a = spawnTracked(r, NODE, ['-e', keep], 'session:a', 'encoder');
    const b = spawnTracked(r, NODE, ['-e', keep], 'session:b', 'encoder');
    const c = spawnTracked(r, NODE, ['-e', keep], 'probe:c', 'probe');
    expect(r.spawned).toBe(3);
    expect(r.active).toBe(3);
    expect(r.activeByKind()).toEqual({ encoder: 2, probe: 1 });
    // Only the named owner's processes are stopped.
    expect(r.killOwner('session:a')).toBe(1);
    expect(r.killOwner('nobody')).toBe(0);
    await until(() => a.exitCode !== null || a.signalCode !== null);
    await until(() => r.active === 2);
    expect(r.reaped).toBe(1);
    expect(b.exitCode).toBeNull();
    expect(r.killAll()).toBe(2);
    await until(() => r.active === 0);
    expect(r.reaped).toBe(3);
    expect(c.killed).toBe(true);
    expect(r.activeByKind()).toEqual({});
  });

  it('reaps a process that could not be started', async () => {
    const r = new ProcessRegistry();
    const child = spawnTracked(r, MISSING, [], 'probe:x', 'probe');
    const err = await new Promise<Error>((resolve) => child.once('error', resolve));
    expect((err as NodeJS.ErrnoException).code).toBe('ENOENT');
    await until(() => r.active === 0);
    expect(r.reaped).toBe(1);
  });

  it('reports an invalid binary path as FFMPEG_SPAWN', () => {
    expect(() => spawnTracked(new ProcessRegistry(), 'ffmpeg\0', [], 'x', 'y')).toThrow(
      expect.objectContaining({ code: 'FFMPEG_SPAWN' }),
    );
  });
});

describe('terminate', () => {
  it('asks politely, then kills a process that has not exited within 2 s', () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    terminate(child as unknown as ChildProcess);
    expect(child.stdinDestroyed).toBe(true);
    expect(child.signals).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(1_999);
    expect(child.signals).toEqual(['SIGTERM']);
    vi.advanceTimersByTime(1);
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('does not kill a process that exited in time', () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    terminate(child as unknown as ChildProcess);
    child.exitCode = 0;
    child.emit('exit', 0, null);
    vi.advanceTimersByTime(5_000);
    expect(child.signals).toEqual(['SIGTERM']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not escalate when the exit was recorded without an event yet', () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    terminate(child as unknown as ChildProcess);
    child.signalCode = 'SIGTERM';
    vi.advanceTimersByTime(2_000);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  it('leaves alone a process that has already exited', () => {
    const child = new FakeChild();
    child.exitCode = 1;
    terminate(child as unknown as ChildProcess);
    expect(child.signals).toEqual([]);
    expect(child.stdinDestroyed).toBe(false);
  });

  it('ignores a process that is gone by the time it is signalled', () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.killThrows = true;
    expect(() => terminate(child as unknown as ChildProcess)).not.toThrow();
    expect(() => vi.advanceTimersByTime(2_000)).not.toThrow();
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});

describe('StderrTail', () => {
  it('keeps only the last bytes, as non-empty lines, with secrets redacted', () => {
    const tail = new StderrTail(27);
    tail.push('first line that will scroll away\n');
    tail.push(Buffer.from('\r\nwarning one\n\nwarning two\n'));
    expect(tail.lines()).toEqual(['warning one', 'warning two']);
    const urls = new StderrTail();
    urls.push('Error opening https://user:secret@stream.example.com/live?token=abc\n');
    expect(urls.text()).not.toContain('secret');
    expect(urls.text()).not.toContain('token=abc');
  });
});

describe('lowerPriority', () => {
  it('does nothing for a process without a pid, or one it may not change', () => {
    expect(() => lowerPriority({ pid: undefined } as ChildProcess)).not.toThrow();
    expect(() => lowerPriority({ pid: 2_147_483_000 } as ChildProcess)).not.toThrow();
  });
});

describe('runWithInput', () => {
  it('passes the input on stdin and returns stdout, stderr and the exit code', async () => {
    const r = await runWithInput(
      registry,
      NODE,
      ['-e', 'process.stdin.pipe(process.stdout); process.stderr.write("note\\n"); process.exitCode = 3'],
      Buffer.from('pcm-bytes'),
      opts(),
    );
    expect(r.stdout.toString()).toBe('pcm-bytes');
    expect(r.stderr).toBe('note');
    expect(r.code).toBe(3);
  });

  it('stops a check that takes too long', async () => {
    const before = registry.reaped;
    await expect(
      runWithInput(
        registry,
        NODE,
        ['-e', 'setTimeout(() => {}, 30_000)'],
        Buffer.alloc(0),
        opts({ timeoutMs: 200 }),
      ),
    ).rejects.toMatchObject({ code: 'PROBE_TIMEOUT' });
    await until(() => registry.reaped > before);
  });

  it('stops a check when it is cancelled, or was cancelled before it began', async () => {
    const abort = new AbortController();
    const running = runWithInput(
      registry,
      NODE,
      ['-e', 'setTimeout(() => {}, 30_000)'],
      Buffer.alloc(0),
      opts({ signal: abort.signal }),
    );
    setTimeout(() => abort.abort(), 50);
    await expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
    const already = new AbortController();
    already.abort();
    await expect(
      runWithInput(registry, NODE, ['-e', ''], Buffer.alloc(0), opts({ signal: already.signal })),
    ).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('stops a check that writes more than allowed', async () => {
    await expect(
      runWithInput(
        registry,
        NODE,
        ['-e', 'process.stdout.write(Buffer.alloc(256 * 1024)); setTimeout(() => {}, 30_000)'],
        Buffer.alloc(0),
        opts({ maxStdout: 1_000 }),
      ),
    ).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
  });

  it('says so when the tool cannot be run', async () => {
    await expect(runWithInput(registry, MISSING, [], Buffer.alloc(0), opts())).rejects.toMatchObject({
      code: 'FFMPEG_SPAWN',
      userMessage: `Could not run ${MISSING}. Is FFmpeg installed?`,
    });
  });

  it('tolerates a tool that exits without reading its input', async () => {
    const r = await runWithInput(
      registry,
      NODE,
      ['-e', 'process.exit(0)'],
      Buffer.alloc(4 * 1024 * 1024),
      opts(),
    );
    expect(r.code).toBe(0);
  });
});

describe('checkFfmpeg', () => {
  it('fails clearly when FFmpeg is missing', async () => {
    await expect(checkFfmpeg(registry, { ffmpeg: MISSING, ffprobe: MISSING })).rejects.toMatchObject({
      code: 'FFMPEG_SPAWN',
    });
  });
});
