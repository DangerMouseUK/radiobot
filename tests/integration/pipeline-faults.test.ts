import { PassThrough } from 'node:stream';
import { afterAll, describe, expect, it } from 'vitest';
import { planEncoder } from '../../src/audio/encoder.ts';
import { ProcessRegistry } from '../../src/audio/ffmpeg.ts';
import { AudioPipeline } from '../../src/audio/pipeline.ts';
import { RadioError } from '../../src/shared/errors.ts';
import { SourceInput } from '../../src/streams/input.ts';
import { binaries } from './fixture-server.ts';

/** How the live encoder reports its faults. No network: the "station" is an in-memory stream. */
const registry = new ProcessRegistry();
afterAll(() => registry.killAll());

const plan = planEncoder({
  qualityMode: 'maximum',
  manualBitrateKbps: null,
  channelBitrateBps: 96_000,
  sourceSampleRateHz: 44_100,
  sourceChannels: 2,
});

function input() {
  const stream = new PassThrough();
  const src = new SourceInput(
    stream,
    {
      transport: 'http-continuous',
      requestedHost: 'stream.example.com',
      finalHost: 'stream.example.com',
      remoteAddress: '203.0.113.10',
      remotePort: 443,
      redirects: [],
      contentType: 'audio/mpeg',
      headersSummary: {},
      advertisedBitrateKbps: 128,
      icyName: null,
      hls: null,
    },
    {
      segmentHost: null,
      bytesIn: 0,
      firstByteAt: null,
      lastByteAt: null,
      segmentsFetched: 0,
      segmentFailures: 0,
      playlistFailures: 0,
      skippedSegments: 0,
    },
  );
  return { stream, src };
}

const failure = (p: AudioPipeline) => new Promise<RadioError>((resolve) => p.once('failed', resolve));

describe('audio pipeline faults', () => {
  it('reports an encoder that cannot be started', async () => {
    const { src } = input();
    const p = new AudioPipeline(src, plan, {
      registry,
      ffmpegPath: 'C:\\no-such-dir\\no-such-ffmpeg-binary',
      owner: 'test:spawn',
    });
    expect((await failure(p)).code).toBe('FFMPEG_SPAWN');
    p.stop();
  });

  it('reports an encoder that exits with an error, with the end of what it said', async () => {
    const { src } = input();
    // Node stands in for a broken FFmpeg: it rejects the encoder's options and exits non-zero.
    const p = new AudioPipeline(src, plan, { registry, ffmpegPath: process.execPath, owner: 'test:exit' });
    const err = await failure(p);
    expect(err.code).toBe('FFMPEG_EXIT');
    expect(err.userMessage).toMatch(/^The audio encoder stopped \(exit \d+\)\. .*-hide_banner/);
    expect(p.stderrTail.join('\n')).toContain('-hide_banner');
    p.stop();
  });

  it('reports a station connection that fails, keeping a reason it already has', async () => {
    const { ffmpeg } = binaries();
    const a = input();
    const p = new AudioPipeline(a.src, plan, { registry, ffmpegPath: ffmpeg, owner: 'test:input' });
    const first = failure(p);
    a.stream.destroy(new Error('ECONNRESET'));
    const err = await first;
    expect(err.code).toBe('HTTP_ERROR');
    expect(err.userMessage).toBe('The connection to the station failed.');
    p.stop();

    const b = input();
    const q = new AudioPipeline(b.src, plan, { registry, ffmpegPath: ffmpeg, owner: 'test:input2' });
    const second = failure(q);
    b.stream.destroy(new RadioError('STREAM_STALLED', 'No data from the station.'));
    expect((await second).code).toBe('STREAM_STALLED');
    q.stop();
  });

  it('reports an encoder killed from outside by its signal, once', async () => {
    const { ffmpeg } = binaries();
    const { src } = input();
    const p = new AudioPipeline(src, plan, { registry, ffmpegPath: ffmpeg, owner: 'test:killed' });
    const failures: RadioError[] = [];
    p.on('failed', (e) => failures.push(e));
    expect(p.stats.pid).toBeGreaterThan(0);
    registry.killOwner('test:killed');
    await new Promise<void>((resolve) => {
      const check = () => (failures.length > 0 ? resolve() : setTimeout(check, 10));
      check();
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.code).toBe('FFMPEG_EXIT');
    expect(failures[0]!.userMessage).toMatch(/^The audio encoder stopped \((SIGTERM|exit \d+)\)/);
    p.stop();
  });

  it('passes on stream titles, and stops quietly and only once', async () => {
    const { ffmpeg } = binaries();
    const { src, stream } = input();
    const p = new AudioPipeline(src, plan, { registry, ffmpegPath: ffmpeg, owner: 'test:stop' });
    const titles: Array<string | null> = [];
    p.on('metadata', (m) => titles.push(m?.title ?? null));
    src.emit('metadata', { title: 'Some Artist - Some Song' } as never);
    src.emit('metadata', null);
    expect(titles).toEqual(['Some Artist - Some Song', null]);
    stream.write(Buffer.alloc(1_000));
    await new Promise((r) => setTimeout(r, 20));
    expect(p.stats.inputBytes).toBe(1_000);

    const failures: RadioError[] = [];
    p.on('failed', (e) => failures.push(e));
    expect(p.stopped).toBe(false);
    p.stop();
    p.stop();
    expect(p.stopped).toBe(true);
    expect(stream.destroyed).toBe(true);
    // The encoder exits after a stop: that is not a fault.
    while (registry.activeByKind().encoder) await new Promise((r) => setTimeout(r, 20));
    expect(failures).toEqual([]);
  });
});
