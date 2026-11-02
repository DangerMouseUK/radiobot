import type { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { HlsReader, type InputStats } from '../../src/streams/input.ts';
import { type HlsMedia, parseHls } from '../../src/streams/playlists.ts';
import type { SafeHttpClient } from '../../src/streams/safe-fetch.ts';

// The reader waits between playlist refreshes; tests don't need the real delays.
vi.mock('../../src/shared/async.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/shared/async.ts')>()),
  delay: () => Promise.resolve(),
}));

const BASE = new URL('https://cdn.example.com/live/media.m3u8');

function playlist(first: number, count: number, opts: { end?: boolean; map?: boolean } = {}): string {
  const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:6', `#EXT-X-MEDIA-SEQUENCE:${first}`];
  if (opts.map) lines.push('#EXT-X-MAP:URI="init.mp4"');
  for (let i = first; i < first + count; i++) lines.push('#EXTINF:6.0,', `seg${i}.aac`);
  if (opts.end) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n');
}

function media(text: string): HlsMedia {
  const p = parseHls(text, BASE);
  if (p.type !== 'media') throw new Error('expected a media playlist');
  return p;
}

/** Serves the given playlist refreshes in order; each file's body is its own name. */
function fakeClient(refreshes: string[], failOnce: string[] = []) {
  const failing = new Set(failOnce);
  const client = {
    fetchText: async (url: URL) => {
      const text = refreshes.shift();
      if (text === undefined) throw new Error('no more playlists');
      return { text, finalUrl: url };
    },
    fetchBytes: async (url: URL) => {
      const name = url.pathname.split('/').pop()!;
      if (failing.delete(name)) throw new Error('connection reset');
      return { bytes: Buffer.from(`<${name}>`), finalUrl: url };
    },
  };
  return client as unknown as SafeHttpClient;
}

function newStats(): InputStats {
  return {
    segmentHost: null,
    bytesIn: 0,
    firstByteAt: null,
    lastByteAt: null,
    segmentsFetched: 0,
    segmentFailures: 0,
    playlistFailures: 0,
    skippedSegments: 0,
  };
}

async function readAll(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
}

describe('HlsReader', () => {
  it('ignores a playlist a refresh behind (another CDN node) instead of replaying audio', async () => {
    const client = fakeClient([playlist(9, 5), playlist(11, 5, { end: true })]);
    const reader = new HlsReader(client, BASE, newStats(), media(playlist(10, 5)));
    expect(await readAll(reader)).toBe('<seg12.aac><seg13.aac><seg14.aac><seg15.aac>');
  });

  it('still resynchronises when the upstream encoder restarts its sequence numbers', async () => {
    const client = fakeClient([playlist(0, 5, { end: true })]);
    const reader = new HlsReader(client, BASE, newStats(), media(playlist(100, 5)));
    expect(await readAll(reader)).toBe('<seg102.aac><seg103.aac><seg104.aac><seg2.aac><seg3.aac><seg4.aac>');
  });

  it('retries the init section once instead of ending the stream', async () => {
    const stats = newStats();
    const client = fakeClient([], ['init.mp4']);
    const reader = new HlsReader(client, BASE, stats, media(playlist(10, 3, { map: true, end: true })));
    expect(await readAll(reader)).toBe('<init.mp4><seg10.aac><seg11.aac><seg12.aac>');
    expect(reader.container).toBe('fmp4');
    expect(stats.segmentFailures).toBe(1);
  });
});
