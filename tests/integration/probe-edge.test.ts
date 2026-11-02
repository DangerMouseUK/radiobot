import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import type { SourceInput } from '../../src/streams/input.ts';
import {
  codecLabel,
  collectSample,
  type ProbeBudget,
  parseFfprobeOutput,
  probeSource,
  wholePacketsEnd,
} from '../../src/streams/probe.ts';
import type { SafeHttpClient, SafeResponse } from '../../src/streams/safe-fetch.ts';
import { binaries, type Fixtures, generateFixtures } from './fixture-server.ts';

let fx: Fixtures;
const registry = new ProcessRegistry();
const { ffmpeg, ffprobe } = binaries();

beforeAll(() => {
  fx = generateFixtures();
}, 120_000);
afterAll(() => registry.killAll());

interface Route {
  headers?: IncomingHttpHeaders;
  body: Buffer | string;
  /** Leave the body open after writing it, like a live stream. */
  live?: boolean;
}

/**
 * Serves fixture bytes straight from memory in place of SafeHttpClient, so these probes run real
 * FFprobe/FFmpeg on synthetic audio without opening a socket.
 */
function stubClient(routes: Record<string, Route>): SafeHttpClient {
  const find = (url: string | URL) => {
    const u = new URL(url);
    const route = routes[u.pathname];
    if (!route) throw new Error(`no route for ${u.pathname}`);
    return { u, route };
  };
  const bytes = (body: Buffer | string) => (Buffer.isBuffer(body) ? body : Buffer.from(body));
  return {
    async request(url: string | URL) {
      const { u, route } = find(url);
      const response = new PassThrough();
      if (route.live) response.write(bytes(route.body));
      else response.end(bytes(route.body));
      return {
        response: response as unknown as IncomingMessage,
        finalUrl: u,
        redirects: [],
        remoteAddress: '127.0.0.1',
        status: 200,
        headers: route.headers ?? {},
      } satisfies SafeResponse;
    },
    async fetchText(url: string | URL) {
      const { u, route } = find(url);
      return { text: String(route.body), finalUrl: u, status: 200, headers: {} };
    },
    async fetchBytes(url: string | URL) {
      const { u, route } = find(url);
      return { bytes: bytes(route.body), finalUrl: u, headers: {} };
    },
  } as unknown as SafeHttpClient;
}

/** Ends sampling by size, not time: the live routes stay open, so no probe waits out a window. */
const BY_SIZE: ProbeBudget = { totalMs: 20_000, sampleMs: 20_000, maxSampleBytes: 160 * 1024 };
const BASE = 'http://radio.example.com';

const liveMp3 = (bytes = fx.mp3Stereo) => ({
  '/live': { headers: { 'content-type': 'audio/mpeg', 'icy-br': '128' }, body: bytes, live: true },
});

describe('probeSource: analysis failures', () => {
  it('reports PROBE_FAILED when FFprobe produces no readable analysis', async () => {
    // FFmpeg in FFprobe's place rejects the FFprobe options and prints no JSON.
    const deps = { client: stubClient(liveMp3()), registry, ffmpegPath: ffmpeg, ffprobePath: ffmpeg };
    const o = await probeSource(deps, `${BASE}/live`, BY_SIZE);
    expect(o.success).toBe(false);
    expect(o.failureCode).toBe('PROBE_FAILED');
    expect(o.failureDetail).toMatch(/^ffprobe could not analyse the stream\./);
    expect(o.transport).toBe('http-continuous');
    expect(o.advertisedBitrateKbps).toBe(128);
  });

  it('reports DECODE_FAILED when the decode check yields no audio', async () => {
    // FFprobe in FFmpeg's place rejects the decode options and reports no progress.
    const deps = { client: stubClient(liveMp3()), registry, ffmpegPath: ffprobe, ffprobePath: ffprobe };
    const o = await probeSource(deps, `${BASE}/live`, BY_SIZE);
    expect(o.success).toBe(false);
    expect(o.failureCode).toBe('DECODE_FAILED');
    expect(o.codec).toBe('mp3');
    expect(o.decodedSeconds).toBeNull();
  });

  it('reports NO_AUDIO_STREAM when the stream delivers almost nothing', async () => {
    const deps = { client: stubClient(liveMp3()), registry, ffmpegPath: ffmpeg, ffprobePath: ffprobe };
    const o = await probeSource(deps, `${BASE}/live`, { ...BY_SIZE, maxSampleBytes: 1024 });
    expect(o.failureCode).toBe('NO_AUDIO_STREAM');
    expect(o.failureDetail).toBe('The stream delivered almost no data.');
  });
});

describe('probeSource: bitrate evidence', () => {
  const deps = () => ({ client: stubClient(liveMp3()), registry, ffmpegPath: ffmpeg, ffprobePath: ffprobe });

  it('measures the bitrate from a sample of three seconds or more', async () => {
    const o = await probeSource(deps(), `${BASE}/live`, BY_SIZE);
    expect(o.success).toBe(true);
    expect(o.bitrateEvidence).toBe('measured');
    expect(o.measuredBitrateKbps).toBeGreaterThan(100);
  });

  it('falls back to the codec metadata when the sample is too short to measure', async () => {
    // 128 kbps is 16 kB a second: a 24 kB sample holds about 1.5 s of audio.
    const o = await probeSource(deps(), `${BASE}/live`, { ...BY_SIZE, maxSampleBytes: 24 * 1024 });
    expect(o.success).toBe(true);
    expect(o.measuredBitrateKbps).toBeNull();
    expect(o.codecBitrateKbps).toBe(128);
    expect(o.bitrateEvidence).toBe('codec-metadata');
  });
});

describe('probeSource: HLS', () => {
  it('reports the HLS container when FFprobe sees only the segment payload', async () => {
    // An fMP4-style playlist whose initialisation section is empty and whose segments carry MP3.
    const seg = Math.ceil(fx.mp3Stereo.length / 4);
    const playlist = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:5',
      '#EXT-X-MAP:URI="init.mp4"',
      ...[0, 1, 2, 3].flatMap((i) => ['#EXTINF:5,', `seg${i}.m4s`]),
      '#EXT-X-ENDLIST',
      '',
    ].join('\n');
    const routes: Record<string, Route> = {
      '/hls/index.m3u8': { headers: { 'content-type': 'application/vnd.apple.mpegurl' }, body: playlist },
      '/hls/init.mp4': { body: Buffer.alloc(0) },
    };
    for (let i = 0; i < 4; i++)
      routes[`/hls/seg${i}.m4s`] = { body: fx.mp3Stereo.subarray(i * seg, (i + 1) * seg) };
    const deps = { client: stubClient(routes), registry, ffmpegPath: ffmpeg, ffprobePath: ffprobe };
    const o = await probeSource(deps, `${BASE}/hls/index.m3u8`, BY_SIZE);
    expect(o.success).toBe(true);
    expect(o.transport).toBe('hls');
    expect(o.container).toBe('fmp4');
    expect(o.manifestSummary).toMatchObject({
      playlistHost: 'radio.example.com',
      chosen: null,
      targetDuration: 5,
    });
  });
});

describe('collectSample', () => {
  it('fails with PROBE_TIMEOUT when the budget runs out before any data', async () => {
    const stream = new PassThrough();
    const input = { stream } as unknown as SourceInput;
    const budget = new AbortController();
    const sample = collectSample(input, 60_000, 1024, budget.signal);
    budget.abort();
    await expect(sample).rejects.toMatchObject({ code: 'PROBE_TIMEOUT' });
    expect(stream.listenerCount('data')).toBe(0);
  });

  it('keeps the data that arrived when the stream errors after some audio', async () => {
    const stream = new PassThrough();
    const input = { stream } as unknown as SourceInput;
    const sample = collectSample(input, 60_000, 1024 * 1024, new AbortController().signal);
    stream.write(Buffer.alloc(4096));
    await new Promise((resolve) => setImmediate(resolve));
    stream.destroy(new Error('connection reset'));
    const r = await sample;
    expect(r.sample.length).toBe(4096);
    expect(r.firstByteMs).not.toBeNull();
    expect(r.networkKbps).toBeNull();
  });
});

describe('probeSource: metadata and unexpected errors', () => {
  it('keeps the last real title when the station clears it during the probe', async () => {
    // ICY metadata every 8192 bytes: a title, then a cleared title, repeated.
    const metaint = 8192;
    const block = (text: string) => {
      const b = Buffer.alloc(Math.ceil(text.length / 16) * 16);
      b.write(text);
      return Buffer.concat([Buffer.from([b.length / 16]), b]);
    };
    const parts: Buffer[] = [];
    for (let i = 0, n = 0; i < fx.mp3Stereo.length; i += metaint, n++) {
      parts.push(fx.mp3Stereo.subarray(i, i + metaint));
      parts.push(block(n % 2 === 0 ? "StreamTitle='Some Artist - Some Song';" : "StreamTitle='';"));
    }
    const routes = {
      '/live': {
        headers: { 'content-type': 'audio/mpeg', 'icy-metaint': String(metaint) },
        body: Buffer.concat(parts),
        live: true,
      },
    };
    const deps = { client: stubClient(routes), registry, ffmpegPath: ffmpeg, ffprobePath: ffprobe };
    const o = await probeSource(deps, `${BASE}/live`, BY_SIZE);
    expect(o.success).toBe(true);
    expect(o.icyTitle).toBe('Some Artist - Some Song');
    expect(o.decodeErrors).toBe(0);
  });

  it.each([
    ['an Error', new Error('socket hang up'), 'socket hang up'],
    ['a bare value', 'something odd', 'something odd'],
  ])('records %s thrown while opening as the failure detail', async (_name, thrown, detail) => {
    const client = {
      request: () => Promise.reject(thrown),
    } as unknown as SafeHttpClient;
    const o = await probeSource(
      { client, registry, ffmpegPath: ffmpeg, ffprobePath: ffprobe },
      `${BASE}/live`,
    );
    expect(o.success).toBe(false);
    expect(o.failureDetail).toBe(detail);
    expect(o.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('probeSource: bitrate evidence without codec metadata', () => {
  // Opus in Ogg declares no bitrate to FFprobe; a sample under three seconds is not measured.
  const SHORT: ProbeBudget = { ...BY_SIZE, maxSampleBytes: 20 * 1024 };
  const opus = (headers: IncomingHttpHeaders) => ({
    '/live': { headers: { 'content-type': 'application/ogg', ...headers }, body: fx.opusOgg, live: true },
  });

  it('uses the advertised bitrate when that is all there is', async () => {
    const deps = {
      client: stubClient(opus({ 'icy-br': '96' })),
      registry,
      ffmpegPath: ffmpeg,
      ffprobePath: ffprobe,
    };
    const o = await probeSource(deps, `${BASE}/live`, SHORT);
    expect(o.success).toBe(true);
    expect(o.codec).toBe('opus');
    expect(o.codecBitrateKbps).toBeNull();
    expect(o.measuredBitrateKbps).toBeNull();
    expect(o.bitrateEvidence).toBe('advertised');
  });

  it('says unknown when nothing states a bitrate', async () => {
    const deps = { client: stubClient(opus({})), registry, ffmpegPath: ffmpeg, ffprobePath: ffprobe };
    const o = await probeSource(deps, `${BASE}/live`, SHORT);
    expect(o.success).toBe(true);
    expect(o.bitrateEvidence).toBe('unknown');
  });
});

describe('wholePacketsEnd', () => {
  it('stops at the start of the last packet when it lies in the second half of the sample', () => {
    expect(wholePacketsEnd({ packets: [{ pos: '0' }, { pos: '700' }, { pos: 'N/A' }] }, 1000)).toBe(700);
  });

  it('uses the whole sample when packet positions are missing or implausible', () => {
    expect(wholePacketsEnd({}, 1000)).toBe(1000);
    expect(wholePacketsEnd({ packets: [{ size: '10' }, { pos: 'N/A' }] }, 1000)).toBe(1000);
    expect(wholePacketsEnd({ packets: [{ pos: '100' }] }, 1000)).toBe(1000);
    expect(wholePacketsEnd({ packets: [{ pos: '1000' }] }, 1000)).toBe(1000);
  });
});

describe('parseFfprobeOutput', () => {
  it('returns nulls for output without an audio stream or packets', () => {
    expect(parseFfprobeOutput({})).toEqual({
      container: null,
      codec: null,
      profile: null,
      sampleRateHz: null,
      channels: null,
      channelLayout: null,
      codecBitrateKbps: null,
      measuredBitrateKbps: null,
      sampleSeconds: null,
    });
    expect(parseFfprobeOutput({ streams: [{ codec_type: 'video', codec_name: 'h264' }] }).codec).toBeNull();
  });

  it('falls back to the format bitrate, drops placeholder profiles and ignores unusable packets', () => {
    const parsed = parseFfprobeOutput({
      streams: [
        { codec_type: 'audio', codec_name: 'aac', profile: '-99', sample_rate: 'N/A', bit_rate: 'N/A' },
      ],
      format: { format_name: 'aac', bit_rate: '64000' },
      packets: [
        { size: '1000', duration_time: '1.0' },
        { size: 'N/A', duration_time: '1.0' },
        { size: '1000', duration_time: '0' },
        { size: '1000', duration_time: 'abc' },
      ],
    });
    expect(parsed).toMatchObject({
      container: 'aac',
      codec: 'aac',
      profile: null,
      sampleRateHz: null,
      codecBitrateKbps: 64,
      measuredBitrateKbps: null,
      sampleSeconds: 1,
    });
    expect(parseFfprobeOutput({ streams: [{ codec_type: 'audio', profile: 'unknown' }] }).profile).toBeNull();
    expect(parseFfprobeOutput({ streams: [{ codec_type: 'audio', profile: 'LC' }] }).profile).toBe('LC');
  });
});

describe('codecLabel', () => {
  it.each([
    [null, null, 'unknown'],
    ['aac', 'HE-AACv2', 'HE-AACv2'],
    ['aac', 'HE-AAC', 'HE-AAC'],
    ['aac', 'LC', 'AAC-LC'],
    ['aac', null, 'AAC'],
    ['mp3float', null, 'MP3'],
    ['mp3', null, 'MP3'],
    ['opus', null, 'Opus'],
    ['vorbis', null, 'Vorbis'],
    ['flac', null, 'FLAC'],
    ['ac3', null, 'AC3'],
  ])('labels %s / %s as %s', (codec, profile, label) => {
    expect(codecLabel(codec, profile)).toBe(label);
  });
});
