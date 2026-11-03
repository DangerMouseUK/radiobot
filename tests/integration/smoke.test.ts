/**
 * scripts/smoke.ts from source, inside the test process so its code is measured. CI runs it again
 * from the compiled build (dist/) and inside the Docker image, with the image's own FFmpeg.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { binaries } from './fixture-server.ts';

class ExitCalled extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

/** Imports the script afresh and captures what it prints and its exit code. */
async function runSmoke(): Promise<{ code: number | null; out: string }> {
  vi.resetModules();
  let out = '';
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }) as never);
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as never);
  let code: number | null = null;
  try {
    await import('../../scripts/smoke.ts');
  } catch (e) {
    if (e instanceof ExitCalled) code = e.code;
    else throw e;
  } finally {
    outSpy.mockRestore();
    exitSpy.mockRestore();
  }
  return { code, out };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('scripts/smoke', () => {
  it('runs every step against the real database, workers, FFmpeg and healthcheck', async () => {
    const { ffmpeg, ffprobe } = binaries();
    vi.stubEnv('FFMPEG_PATH', ffmpeg);
    vi.stubEnv('FFPROBE_PATH', ffprobe);
    const r = await runSmoke();
    expect(r.out).not.toMatch(/FAIL/);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^ok {3}database: migrations and the template pack \(schema v\d+, \d+ pack\(s\)/m);
    expect(r.out).toMatch(/^ok {3}station pack check on the pack worker thread \(template: \d+ stations\)/m);
    expect(r.out).toMatch(/^ok {3}WAL checkpoint on the worker thread/m);
    expect(r.out).toMatch(/^ok {3}station list parsed on the worker thread \(200 entries\)/m);
    expect(r.out).toMatch(/^ok {3}FFmpeg with libopus/m);
    expect(r.out).toMatch(/^ok {3}encode: .* \(128 kbps, 2\.\d\d s/m);
    expect(r.out).toMatch(/^ok {3}heartbeat and healthcheck \(healthy: ok\)/m);
  }, 60_000);

  it('stops at the first step that fails and exits 1', async () => {
    vi.stubEnv('FFMPEG_PATH', 'radio-bot-no-such-ffmpeg');
    vi.stubEnv('FFPROBE_PATH', 'radio-bot-no-such-ffprobe');
    const r = await runSmoke();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^ok {3}station list parsed/m);
    expect(r.out).toMatch(/^FAIL FFmpeg with libopus: /m);
    expect(r.out).not.toMatch(/encode:/);
  }, 60_000);
});
