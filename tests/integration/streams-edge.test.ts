import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import { type ProbeBudget, probeSource } from '../../src/streams/probe.ts';
import { SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import { UrlPolicy } from '../../src/streams/url-policy.ts';
import { binaries, generateFixtures, startTestRadio, type TestRadio } from './fixture-server.ts';

let radio: TestRadio;
const registry = new ProcessRegistry();
const client = new SafeHttpClient(
  new UrlPolicy({ allowInsecureHttp: true, testAllowedAddresses: ['127.0.0.1'] }),
);
const { ffmpeg, ffprobe } = binaries();
const deps = { client, registry, ffmpegPath: ffmpeg, ffprobePath: ffprobe };
const FAST: ProbeBudget = { totalMs: 20_000, sampleMs: 2_000, maxSampleBytes: 2 * 1024 * 1024 };

beforeAll(async () => {
  radio = await startTestRadio(generateFixtures());
}, 120_000);
afterAll(async () => {
  registry.killAll();
  await radio?.close();
});

describe('probe: streams that are not live radio', () => {
  it('fails a short file that ends inside the sample window instead of marking it healthy', async () => {
    const o = await probeSource(deps, `${radio.base}/offline`, FAST);
    expect(o.success).toBe(false);
    expect(o.failureCode).toBe('STREAM_EOF');
    expect(o.failureDetail).toMatch(/not a continuous live stream/);
  });
});

describe('probe: failure labels', () => {
  it('labels a probe that runs out of time as PROBE_TIMEOUT, not CANCELLED', async () => {
    const o = await probeSource(deps, `${radio.base}/hang.pls`, { ...FAST, totalMs: 1_500 });
    expect(o.success).toBe(false);
    expect(o.failureCode).toBe('PROBE_TIMEOUT');
  });

  it('labels a probe the caller aborts as CANCELLED', async () => {
    const outer = new AbortController();
    setTimeout(() => outer.abort(), 200);
    const o = await probeSource(deps, `${radio.base}/hang`, FAST, outer.signal);
    expect(o.failureCode).toBe('CANCELLED');
  });
});

describe('ICY metadata headers', () => {
  it('reads a repeated icy-metaint header and keeps metadata out of the audio', async () => {
    const o = await probeSource(deps, `${radio.base}/icy-repeated`, FAST);
    expect(o.success).toBe(true);
    expect(o.icyTitle).toBe('Repeated Header - Test Tone');
    expect(o.decodeErrors).toBe(0);
  });

  it('asks again without metadata when the interval is unreadable', async () => {
    const o = await probeSource(deps, `${radio.base}/icy-garbled`, FAST);
    expect(o.success).toBe(true);
    expect(o.icyTitle).toBeNull();
    expect(o.decodeErrors).toBe(0);
  });
});

describe('SafeHttpClient status mapping', () => {
  it('reports 401/403/451 from playlist and segment fetches as ACCESS_DENIED', async () => {
    await expect(client.fetchText(`${radio.base}/forbidden`)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    await expect(client.fetchBytes(`${radio.base}/forbidden`, { maxBytes: 1024 })).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    await expect(client.fetchText(`${radio.base}/nope`)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
