import { createAudioResource, StreamType, TransformerType } from '@discordjs/voice';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planEncoder } from '../../src/audio/encoder.ts';
import { ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import { AudioPipeline } from '../../src/audio/pipeline.ts';
import { compareSources, correlationEvidence } from '../../src/streams/identity.ts';
import { openSourceInput } from '../../src/streams/input.ts';
import { type ProbeBudget, probeSource } from '../../src/streams/probe.ts';
import { SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import { UrlPolicy } from '../../src/streams/url-policy.ts';
import { binaries, generateFixtures, startTestRadio, type TestRadio } from './fixture-server.ts';

const FAST: ProbeBudget = { totalMs: 20_000, sampleMs: 2_000, maxSampleBytes: 2 * 1024 * 1024 };

let radio: TestRadio;
const registry = new ProcessRegistry();
const client = new SafeHttpClient(
  new UrlPolicy({ allowInsecureHttp: true, testAllowedAddresses: ['127.0.0.1'] }),
);
const { ffmpeg, ffprobe } = binaries();
const deps = { client, registry, ffmpegPath: ffmpeg, ffprobePath: ffprobe };

beforeAll(async () => {
  radio = await startTestRadio(generateFixtures());
}, 120_000);
afterAll(async () => {
  registry.killAll();
  await radio?.close();
});

describe('probe: technical inspection (FR-004)', () => {
  it('measures a direct MP3 stream', async () => {
    const o = await probeSource(deps, `${radio.base}/mp3`, FAST);
    expect(o.failureDetail).toBeNull();
    expect(o.success).toBe(true);
    expect(o.transport).toBe('http-continuous');
    expect(o.codec).toBe('mp3');
    expect(o.sampleRateHz).toBe(44_100);
    expect(o.channels).toBe(2);
    expect(o.measuredBitrateKbps).toBeGreaterThan(120);
    expect(o.measuredBitrateKbps).toBeLessThan(136);
    expect(o.bitrateEvidence).toBe('measured');
    expect(o.advertisedBitrateKbps).toBe(128);
    expect(o.icyName).toBe('Test Radio One');
    expect(o.decodedSeconds).toBeGreaterThan(1);
  });

  it('detects mono, low sample rate AAC', async () => {
    const o = await probeSource(deps, `${radio.base}/aac`, FAST);
    expect(o.success).toBe(true);
    expect(o.codec).toBe('aac');
    expect(o.channels).toBe(1);
    expect(o.sampleRateHz).toBe(22_050);
  });

  it('inspects Ogg Opus sources', async () => {
    const o = await probeSource(deps, `${radio.base}/opus`, FAST);
    expect(o.success).toBe(true);
    expect(o.codec).toBe('opus');
  });

  it('follows redirects and PLS playlists through the safe client', async () => {
    expect((await probeSource(deps, `${radio.base}/redirect`, FAST)).codec).toBe('mp3');
    expect((await probeSource(deps, `${radio.base}/station.pls`, FAST)).codec).toBe('mp3');
  });

  it('chooses the highest valid audio-only HLS rendition, ignoring the video variant', async () => {
    const o = await probeSource(deps, `${radio.base}/master.m3u8`, FAST);
    expect(o.success).toBe(true);
    expect(o.transport).toBe('hls');
    expect(o.codec).toBe('aac');
    expect(o.advertisedBitrateKbps).toBe(170);
    expect(o.measuredBitrateKbps).toBeGreaterThan(120);
    expect((o.manifestSummary.chosen as { reason: string }).reason).toMatch(/audio-only/);
  });

  it('reports 404, HTML and unreachable sources as failures', async () => {
    expect((await probeSource(deps, `${radio.base}/nope`, FAST)).failureCode).toBe('NOT_FOUND');
    expect((await probeSource(deps, `${radio.base}/html`, FAST)).failureCode).toBe('CONTENT_TYPE_REJECTED');
    const prod = new SafeHttpClient(new UrlPolicy({ allowInsecureHttp: true }));
    expect((await probeSource({ ...deps, client: prod }, `${radio.base}/mp3`, FAST)).failureCode).toBe(
      'ADDRESS_BLOCKED',
    );
  });

  it('surfaces ICY now-playing titles without altering the audio', async () => {
    const o = await probeSource(deps, `${radio.base}/icy`, FAST);
    expect(o.success).toBe(true);
    expect(o.codec).toBe('mp3');
    expect(o.icyTitle).toBe('Synthetic Artist - Test Tone');
    expect(o.decodeErrors).toBe(0);
  });
});

// ---------------------------------------------------------------- Ogg/Opus output checks

function oggPackets(buf: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  let pending: Buffer[] = [];
  let off = 0;
  while (off + 27 <= buf.length) {
    if (buf.toString('latin1', off, off + 4) !== 'OggS') throw new Error(`bad page at ${off}`);
    const segs = buf[off + 26]!;
    const table = buf.subarray(off + 27, off + 27 + segs);
    let data = off + 27 + segs;
    for (const lace of table) {
      pending.push(buf.subarray(data, data + lace));
      data += lace;
      if (lace < 255) {
        packets.push(Buffer.concat(pending));
        pending = [];
      }
    }
    off = data;
  }
  return packets;
}

function opusFrameMs(toc: number): number {
  const config = toc >> 3;
  if (config >= 16) return [2.5, 5, 10, 20][config % 4]!;
  if (config >= 12) return [10, 20][config % 2]!;
  return [10, 20, 40, 60][config % 4]!;
}

describe('audio pipeline: single Opus encode for Discord (FR-007, NFR-06)', () => {
  it('produces 48 kHz stereo Ogg Opus with 20 ms frames from a 44.1 kHz MP3, using one encoder process', async () => {
    const input = await openSourceInput(client, `${radio.base}/mp3`);
    const plan = planEncoder({
      qualityMode: 'maximum',
      manualBitrateKbps: null,
      channelBitrateBps: 256_000,
      sourceSampleRateHz: 44_100,
      sourceChannels: 2,
    });
    const pipeline = new AudioPipeline(input, plan, { registry, ffmpegPath: ffmpeg, owner: 'test-pipeline' });
    const chunks: Buffer[] = [];
    pipeline.output.on('data', (c: Buffer) => chunks.push(c));
    const failure = new Promise<string>((resolve) => pipeline.on('failed', (e) => resolve(e.code)));
    await new Promise<void>((resolve) => pipeline.output.on('end', () => resolve()));
    // A live stream that ends is reported as an upstream EOF, never as silent "playing".
    expect(await failure).toBe('STREAM_EOF');
    expect(registry.activeByKind().encoder ?? 0).toBeLessThanOrEqual(1);
    pipeline.stop();

    const packets = oggPackets(Buffer.concat(chunks));
    const head = packets[0]!;
    expect(head.toString('latin1', 0, 8)).toBe('OpusHead');
    expect(head[9]).toBe(2);
    expect(packets[1]!.toString('latin1', 0, 8)).toBe('OpusTags');
    const audio = packets.slice(2);
    expect(audio.length).toBeGreaterThan(500);
    for (const p of audio.slice(0, 200)) {
      expect(opusFrameMs(p[0]!)).toBe(20);
      expect(p[0]! & 0x03).toBe(0);
      expect((p[0]! >> 2) & 1).toBe(1);
    }
    const seconds = audio.length * 0.02;
    expect(seconds).toBeGreaterThan(18);
    const totalBits = audio.reduce((n, p) => n + p.length, 0) * 8;
    const kbps = totalBits / seconds / 1000;
    expect(kbps).toBeGreaterThan(64);
  }, 60_000);

  it('hands Ogg Opus to @discordjs/voice with only a demuxer (no second encode)', async () => {
    const input = await openSourceInput(client, `${radio.base}/mp3`);
    const plan = planEncoder({
      qualityMode: 'balanced',
      manualBitrateKbps: null,
      channelBitrateBps: 128_000,
      sourceSampleRateHz: 44_100,
      sourceChannels: 2,
    });
    const pipeline = new AudioPipeline(input, plan, { registry, ffmpegPath: ffmpeg, owner: 'test-resource' });
    const resource = createAudioResource(pipeline.output, {
      inputType: StreamType.OggOpus,
      inlineVolume: false,
    });
    const kinds = resource.edges.map((e) => e.type);
    expect(kinds).toEqual([TransformerType.OggOpusDemuxer]);
    expect(kinds).not.toContain(TransformerType.OpusEncoder);
    expect(kinds).not.toContain(TransformerType.FFmpegPCM);
    expect(resource.volume).toBeUndefined();
    const before = registry.spawned;
    const first = await new Promise<Buffer | null>((resolve) => {
      resource.playStream.once('readable', () => resolve(resource.read()));
    });
    expect(first?.length).toBeGreaterThan(0);
    expect(registry.spawned).toBe(before);
    pipeline.stop();
    resource.playStream.destroy();
  }, 60_000);

  it('reaps FFmpeg when a pipeline is stopped mid-stream (no zombies)', async () => {
    const input = await openSourceInput(client, `${radio.base}/mp3`);
    const plan = planEncoder({
      qualityMode: 'maximum',
      manualBitrateKbps: null,
      channelBitrateBps: 96_000,
      sourceSampleRateHz: 44_100,
      sourceChannels: 2,
    });
    const pipeline = new AudioPipeline(input, plan, { registry, ffmpegPath: ffmpeg, owner: 'test-reap' });
    pipeline.output.resume();
    await new Promise((r) => setTimeout(r, 300));
    pipeline.stop();
    const start = Date.now();
    while (registry.active > 0 && Date.now() - start < 5000) await new Promise((r) => setTimeout(r, 50));
    expect(registry.active).toBe(0);
  }, 30_000);
});

describe('identity: time-aligned comparison (FR-005, §17.2)', () => {
  it('matches the same programme offset by 7 s', async () => {
    const r = await compareSources(deps, `${radio.base}/prog-a`, `${radio.base}/prog-a-late`, {
      seconds: 30,
    });
    expect(correlationEvidence(r, 'a').verdict).toBe('supports');
    expect(Math.abs(Math.abs(r.lagSeconds) - 7)).toBeLessThan(0.5);
  }, 90_000);

  it('does not match a different programme', async () => {
    const r = await compareSources(deps, `${radio.base}/prog-a`, `${radio.base}/prog-b`, { seconds: 30 });
    expect(correlationEvidence(r, 'a').verdict).toBe('inconclusive');
  }, 90_000);
});
