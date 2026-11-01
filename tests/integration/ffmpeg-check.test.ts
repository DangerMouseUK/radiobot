import { afterAll, describe, expect, it } from 'vitest';
import { checkFfmpeg, ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import { DEFAULT_USER_AGENT, lavfUserAgent } from '../../src/streams/safe-fetch.ts';
import { binaries } from './fixture-server.ts';

const registry = new ProcessRegistry();
afterAll(() => registry.killAll());

describe('FFmpeg start-up check', () => {
  it('finds libopus and derives the stream User-Agent from the installed libavformat', async () => {
    const info = await checkFfmpeg(registry, binaries());
    expect(info.libopus).toBe(true);
    expect(info.ffmpegVersion).toMatch(/^ffmpeg version /);
    expect(info.ffprobeVersion).toMatch(/^ffprobe version /);
    expect(info.libavformat).toMatch(/^Lavf\/\d+\.\d+\.\d+$/);
  }, 60_000);
});

describe('lavfUserAgent', () => {
  it.each([
    ['libavformat    61.  7.100 / 61.  7.100', 'Lavf/61.7.100'],
    ['libavformat    60. 16.100 / 60. 16.100', 'Lavf/60.16.100'],
    ['libavformat     58. 76.100 / 58. 76.100\r\n', 'Lavf/58.76.100'],
    ['libavformat 62.0.101', 'Lavf/62.0.101'],
    ['libavcodec     61. 19.100', null],
    ['', null],
  ])('%j → %s', (out, ua) => {
    expect(lavfUserAgent(out)).toBe(ua);
  });

  it('defaults to an FFmpeg-style User-Agent', () => {
    expect(DEFAULT_USER_AGENT).toMatch(/^Lavf\/\d+\.\d+\.\d+$/);
  });
});
