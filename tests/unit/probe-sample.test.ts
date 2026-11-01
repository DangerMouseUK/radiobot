import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { SourceInput } from '../../src/streams/input.ts';
import { collectSample } from '../../src/streams/probe.ts';

function fakeInput(): { input: SourceInput; stream: PassThrough } {
  const stream = new PassThrough();
  return { input: { stream } as unknown as SourceInput, stream };
}

describe('collectSample', () => {
  it('refuses a live stream that ends inside the sample window, even after some data', async () => {
    const { input, stream } = fakeInput();
    const sample = collectSample(input, 5_000, 1024 * 1024, new AbortController().signal, {
      requireLive: true,
    });
    stream.write(Buffer.alloc(4096));
    stream.end();
    await expect(sample).rejects.toMatchObject({ code: 'STREAM_EOF' });
  });

  it('keeps what arrived when a finite sample (identity comparison) ends early', async () => {
    const { input, stream } = fakeInput();
    const sample = collectSample(input, 5_000, 1024 * 1024, new AbortController().signal);
    stream.write(Buffer.alloc(4096));
    stream.end();
    expect((await sample).sample.length).toBe(4096);
  });

  it('still fails an empty stream without requireLive', async () => {
    const { input, stream } = fakeInput();
    const sample = collectSample(input, 5_000, 1024, new AbortController().signal);
    stream.end();
    await expect(sample).rejects.toMatchObject({ code: 'STREAM_EOF' });
  });
});
