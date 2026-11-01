import { type ChildProcess, spawn } from 'node:child_process';
import { RadioError } from '../shared/errors.ts';
import { redactText } from '../shared/redact.ts';
import { lavfUserAgent } from '../streams/safe-fetch.ts';

export interface FfmpegPaths {
  ffmpeg: string;
  ffprobe: string;
}

/**
 * Owns every FFmpeg/FFprobe child process so none can outlive its session (PRD §8.5,
 * NFR-05). Processes are tagged with an owner key and can be reaped per owner or globally.
 */
export class ProcessRegistry {
  readonly #procs = new Map<ChildProcess, { owner: string; startedAt: number; kind: string }>();
  spawned = 0;
  reaped = 0;

  track(child: ChildProcess, owner: string, kind: string): void {
    this.#procs.set(child, { owner, startedAt: Date.now(), kind });
    this.spawned++;
    child.once('exit', () => {
      if (this.#procs.delete(child)) this.reaped++;
    });
    child.once('error', () => {
      if (this.#procs.delete(child)) this.reaped++;
    });
  }

  killOwner(owner: string): number {
    let n = 0;
    for (const [child, meta] of this.#procs) {
      if (meta.owner === owner) {
        terminate(child);
        n++;
      }
    }
    return n;
  }

  killAll(): number {
    let n = 0;
    for (const child of this.#procs.keys()) {
      terminate(child);
      n++;
    }
    return n;
  }

  get active(): number {
    return this.#procs.size;
  }

  activeByKind(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const meta of this.#procs.values()) out[meta.kind] = (out[meta.kind] ?? 0) + 1;
    return out;
  }
}

/** SIGTERM, then SIGKILL if the process has not exited within 2 s. */
export function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.stdin?.destroy();
    child.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }, 2000);
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
}

export function spawnTracked(
  registry: ProcessRegistry,
  bin: string,
  args: string[],
  owner: string,
  kind: string,
): ChildProcess {
  let child: ChildProcess;
  try {
    child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (err) {
    throw new RadioError('FFMPEG_SPAWN', 'FFmpeg could not be started.', { cause: err });
  }
  registry.track(child, owner, kind);
  return child;
}

/** Keeps the last `max` bytes of stderr for diagnostics, redacted. */
export class StderrTail {
  #buf = '';
  readonly #max: number;

  constructor(max = 4000) {
    this.#max = max;
  }

  push(chunk: Buffer | string): void {
    this.#buf = (this.#buf + chunk.toString()).slice(-this.#max);
  }

  text(): string {
    return redactText(this.#buf.trim());
  }

  lines(): string[] {
    return this.text().split(/\r?\n/).filter(Boolean);
  }
}

/**
 * Runs a short-lived FFmpeg/FFprobe job over an in-memory input buffer. The input is
 * passed only through stdin, so FFmpeg never opens a network or file URL itself.
 */
export function runWithInput(
  registry: ProcessRegistry,
  bin: string,
  args: string[],
  input: Buffer,
  opts: { owner: string; kind: string; timeoutMs: number; maxStdout?: number; signal?: AbortSignal },
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnTracked(registry, bin, args, opts.owner, opts.kind);
    const out: Buffer[] = [];
    let outSize = 0;
    const err = new StderrTail(8000);
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      terminate(child);
      finish(() => reject(new RadioError('PROBE_TIMEOUT', 'The audio inspection took too long.')));
    }, opts.timeoutMs);
    const onAbort = () => {
      terminate(child);
      finish(() => reject(new RadioError('CANCELLED', 'Inspection cancelled.')));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (opts.signal?.aborted) onAbort();
    child.stdout?.on('data', (c: Buffer) => {
      outSize += c.length;
      if (opts.maxStdout && outSize > opts.maxStdout) {
        terminate(child);
        finish(() => reject(new RadioError('BODY_TOO_LARGE', 'Inspection output exceeded its limit.')));
        return;
      }
      out.push(c);
    });
    child.stderr?.on('data', (c: Buffer) => err.push(c));
    child.on('error', (e) =>
      finish(() =>
        reject(new RadioError('FFMPEG_SPAWN', `Could not run ${bin}. Is FFmpeg installed?`, { cause: e })),
      ),
    );
    child.on('close', (code) =>
      finish(() => resolve({ code, stdout: Buffer.concat(out), stderr: err.text() })),
    );
    child.stdin?.on('error', () => {
      /* EPIPE when the tool stops reading early is expected */
    });
    child.stdin?.end(input);
  });
}

/** Verifies the binaries exist and libopus is available. */
export async function checkFfmpeg(
  registry: ProcessRegistry,
  paths: FfmpegPaths,
): Promise<{ ffmpegVersion: string; ffprobeVersion: string; libopus: boolean; libavformat: string | null }> {
  const ver = async (bin: string) => {
    const r = await runWithInput(registry, bin, ['-hide_banner', '-version'], Buffer.alloc(0), {
      owner: 'startup',
      kind: 'version',
      timeoutMs: 10_000,
    });
    return r.stdout.toString().split(/\r?\n/)[0] ?? 'unknown';
  };
  const encoders = await runWithInput(
    registry,
    paths.ffmpeg,
    ['-hide_banner', '-encoders'],
    Buffer.alloc(0),
    {
      owner: 'startup',
      kind: 'version',
      timeoutMs: 10_000,
    },
  );
  const full = await runWithInput(registry, paths.ffmpeg, ['-hide_banner', '-version'], Buffer.alloc(0), {
    owner: 'startup',
    kind: 'version',
    timeoutMs: 10_000,
  });
  return {
    ffmpegVersion: await ver(paths.ffmpeg),
    libavformat: lavfUserAgent(full.stdout.toString()),
    ffprobeVersion: await ver(paths.ffprobe),
    libopus: /\blibopus\b/.test(encoders.stdout.toString()),
  };
}
