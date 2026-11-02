import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { PassThrough, type Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { HlsReader, type InputStats, openSourceInput, SourceInput } from '../../src/streams/input.ts';
import { parseHls } from '../../src/streams/playlists.ts';
import type { SafeHttpClient, SafeResponse } from '../../src/streams/safe-fetch.ts';
import { statusError } from '../../src/streams/safe-fetch.ts';

// The HLS reader waits between playlist refreshes. Those waits are recorded and skipped so the
// tests run instantly; a real yield to the event loop keeps the reader's loop cooperative.
const waits = vi.hoisted(() => [] as number[]);
vi.mock('../../src/shared/async.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/shared/async.ts')>();
  return {
    ...original,
    delay: (ms: number) => {
      waits.push(ms);
      return new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
});

// ---------------------------------------------------------------- a scripted, offline client

interface Reply {
  status?: number;
  headers?: IncomingHttpHeaders;
  body?: Buffer | string;
  /** A response body the test writes to itself (left open unless the test ends it). */
  stream?: PassThrough;
  /** Rejects the request instead of answering. */
  fail?: Error;
  /** Never answers; rejects when the request's signal aborts. */
  hang?: boolean;
}
type Handler = (url: URL, call: number) => Reply;

/** Stands in for SafeHttpClient: answers from a script, so no socket is ever opened. */
class StubClient {
  readonly calls: string[] = [];
  readonly requestHeaders: Array<Record<string, string> | undefined> = [];
  readonly #handler: Handler;
  readonly #counts = new Map<string, number>();

  constructor(handler: Handler) {
    this.#handler = handler;
  }

  #reply(url: string | URL, signal?: AbortSignal): Promise<{ reply: Reply; url: URL }> {
    const u = new URL(url);
    this.calls.push(u.pathname);
    const n = this.#counts.get(u.href) ?? 0;
    this.#counts.set(u.href, n + 1);
    const reply = this.#handler(u, n);
    if (reply.fail) return Promise.reject(reply.fail);
    if (reply.hang) {
      return new Promise((_, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    return Promise.resolve({ reply, url: u });
  }

  async request(url: string | URL, opts: { signal?: AbortSignal; headers?: Record<string, string> } = {}) {
    this.requestHeaders.push(opts.headers);
    const { reply, url: u } = await this.#reply(url, opts.signal);
    let response = reply.stream;
    if (!response) {
      response = new PassThrough();
      response.end(reply.body ?? '');
    }
    return {
      response: response as unknown as IncomingMessage,
      finalUrl: u,
      redirects: [],
      remoteAddress: '127.0.0.1',
      status: reply.status ?? 200,
      headers: reply.headers ?? {},
    } satisfies SafeResponse;
  }

  async fetchText(url: string | URL, opts: { signal?: AbortSignal } = {}) {
    const { reply, url: u } = await this.#reply(url, opts.signal);
    const status = reply.status ?? 200;
    if (status < 200 || status >= 300) throw statusError(status);
    return { text: String(reply.body ?? ''), finalUrl: u, status, headers: reply.headers ?? {} };
  }

  async fetchBytes(url: string | URL, opts: { signal?: AbortSignal } = {}) {
    const { reply, url: u } = await this.#reply(url, opts.signal);
    const status = reply.status ?? 200;
    if (status < 200 || status >= 300) throw statusError(status);
    const body = reply.body ?? '';
    return { bytes: Buffer.isBuffer(body) ? body : Buffer.from(body), finalUrl: u, headers: {} };
  }
}

const asClient = (c: StubClient) => c as unknown as SafeHttpClient;
const BASE = 'http://radio.example.com';

const newStats = (): InputStats => ({
  segmentHost: null,
  bytesIn: 0,
  firstByteAt: null,
  lastByteAt: null,
  segmentsFetched: 0,
  segmentFailures: 0,
  playlistFailures: 0,
  skippedSegments: 0,
  liveEdgeSkips: 0,
});

/** A media playlist with `count` segments named seg<sequence>.ts, starting at `seq`. */
function media(
  seq: number,
  count: number,
  opts: { endList?: boolean; target?: number; extra?: string[]; name?: (n: number) => string } = {},
): string {
  const lines = ['#EXTM3U', `#EXT-X-TARGETDURATION:${opts.target ?? 2}`, `#EXT-X-MEDIA-SEQUENCE:${seq}`];
  lines.push(...(opts.extra ?? []));
  for (let i = 0; i < count; i++)
    lines.push('#EXTINF:2.0,', opts.name ? opts.name(seq + i) : `seg${seq + i}.ts`);
  if (opts.endList) lines.push('#EXT-X-ENDLIST');
  return `${lines.join('\n')}\n`;
}

/** An MPEG-TS-looking segment (sync byte 0x47) that carries its sequence number. */
const tsSegment = (seq: number) => Buffer.from([0x47, seq]);
const segNumber = (path: string) => Number(/seg(\d+)\./.exec(path)?.[1] ?? Number.NaN);

/** Reads a reader to its end, returning the chunks (or rejecting with its error). */
function drain(stream: Readable): Promise<Buffer[]> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('end', () => resolve(chunks));
    stream.on('error', reject);
  });
}

function reader(client: StubClient, text: string, liveEdge?: number, stats = newStats()): HlsReader {
  const url = new URL(`${BASE}/live/index.m3u8`);
  const initial = parseHls(text, url);
  if (initial.type !== 'media') throw new Error('test playlist must be a media playlist');
  return new HlsReader(asClient(client), url, stats, initial, liveEdge);
}

// ---------------------------------------------------------------- HLS live reader

describe('HlsReader: following a live playlist', () => {
  it('starts near the live edge, follows refreshes and ends at #EXT-X-ENDLIST', async () => {
    waits.length = 0;
    const refreshes = [media(2, 4, { target: 4 }), media(4, 3, { endList: true })];
    const client = new StubClient((url, n) => {
      if (url.pathname.endsWith('.m3u8')) return { body: refreshes[n]! };
      return { body: tsSegment(segNumber(url.pathname)) };
    });
    const stats = newStats();
    const r = reader(client, media(0, 4), undefined, stats);
    const chunks = await drain(r);
    expect(chunks.map((c) => c[1])).toEqual([1, 2, 3, 4, 5, 6]);
    expect(r.container).toBe('mpegts');
    expect(r.targetDuration).toBe(2);
    expect(stats.segmentsFetched).toBe(6);
    expect(stats.segmentHost).toBe('radio.example.com');
    expect(stats.bytesIn).toBe(12);
    // Re-polls at half the target duration, but never faster than once a second.
    expect(waits).toEqual([1000, 2000]);
  });

  it('resynchronises near the live edge when the sequence numbers go backwards', async () => {
    const refreshes = [media(0, 3), media(0, 4, { endList: true })];
    const client = new StubClient((url, n) =>
      url.pathname.endsWith('.m3u8') ? { body: refreshes[n]! } : { body: tsSegment(segNumber(url.pathname)) },
    );
    const chunks = await drain(reader(client, media(100, 3), 1));
    expect(chunks.map((c) => c[1])).toEqual([102, 2, 3]);
  });

  it('skips ahead and counts the gap when it falls out of the live window', async () => {
    const refreshes = [media(10, 3), media(12, 2, { endList: true })];
    const client = new StubClient((url, n) =>
      url.pathname.endsWith('.m3u8') ? { body: refreshes[n]! } : { body: tsSegment(segNumber(url.pathname)) },
    );
    const stats = newStats();
    const chunks = await drain(reader(client, media(0, 3), 1, stats));
    expect(chunks.map((c) => c[1])).toEqual([2, 12, 13]);
    expect(stats.skippedSegments).toBe(7);
    expect(stats.liveEdgeSkips).toBe(1);
  });

  it('retries a failing playlist with growing waits and gives up after five failures in a row', async () => {
    waits.length = 0;
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"\naudio.m3u8\n';
    const client = new StubClient((url, n) => {
      if (url.pathname.endsWith('.m3u8')) {
        if (n === 0) return { fail: new Error('connection reset') };
        if (n === 1) return { body: media(0, 2) }; // a success resets the failure count
        if (n === 2) return { body: master }; // a master playlist where a media one belongs
        if (n === 3) return { status: 503 };
        return { fail: new Error('connection reset') };
      }
      return { body: tsSegment(segNumber(url.pathname)) };
    });
    const stats = newStats();
    const r = reader(client, media(0, 1), undefined, stats);
    await expect(drain(r)).rejects.toMatchObject({ code: 'HLS_PLAYLIST_FAILED' });
    expect(stats.playlistFailures).toBe(6);
    expect(waits).toEqual([1000, 1000, 1000, 1000, 2000, 3000, 4000]);
  });

  it('starts from the media sequence when the first playlist has no segments yet', async () => {
    const client = new StubClient((url) =>
      url.pathname.endsWith('.m3u8')
        ? { body: media(7, 2, { endList: true }) }
        : { body: tsSegment(segNumber(url.pathname)) },
    );
    const chunks = await drain(reader(client, media(7, 0)));
    expect(chunks.map((c) => c[1])).toEqual([7, 8]);
  });

  it('refuses a playlist that becomes encrypted', async () => {
    const encrypted = media(1, 2, { extra: ['#EXT-X-KEY:METHOD=AES-128,URI="key.bin"'] });
    const client = new StubClient((url) =>
      url.pathname.endsWith('.m3u8') ? { body: encrypted } : { body: tsSegment(segNumber(url.pathname)) },
    );
    await expect(drain(reader(client, media(0, 1)))).rejects.toMatchObject({ code: 'HLS_ENCRYPTED' });
  });
});

describe('HlsReader: segments', () => {
  it('retries a segment once, skips one that fails twice, and carries on', async () => {
    const client = new StubClient((url, n) => {
      const seg = segNumber(url.pathname);
      if (seg === 1 && n === 0) return { status: 500 };
      if (seg === 2) return { fail: new Error('connection reset') };
      return { body: tsSegment(seg) };
    });
    const stats = newStats();
    const chunks = await drain(reader(client, media(0, 4, { endList: true }), undefined, stats));
    expect(chunks.map((c) => c[1])).toEqual([0, 1, 3]);
    expect(stats.segmentFailures).toBe(3);
    expect(stats.skippedSegments).toBe(1);
    // A failed segment skipped on the way is not a jump to the live edge.
    expect(stats.liveEdgeSkips).toBe(0);
    expect(stats.segmentsFetched).toBe(3);
  });

  it('stops after more than three segments in a row fail', async () => {
    const client = new StubClient((url) =>
      segNumber(url.pathname) === 0 ? { body: tsSegment(0) } : { status: 404 },
    );
    const stats = newStats();
    await expect(
      drain(reader(client, media(0, 8, { endList: true }), undefined, stats)),
    ).rejects.toMatchObject({
      code: 'HLS_SEGMENT_FAILED',
    });
    expect(stats.skippedSegments).toBe(4);
    expect(stats.segmentFailures).toBe(8);
  });

  it('sends each fMP4 initialisation section once, before the segments that use it', async () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:2',
      '#EXT-X-MAP:URI="init-a.mp4"',
      '#EXTINF:2,',
      'seg0.m4s',
      '#EXTINF:2,',
      'seg1.m4s',
      '#EXT-X-MAP:URI="init-b.mp4"',
      '#EXTINF:2,',
      'seg2.m4s',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const client = new StubClient((url) => ({ body: url.pathname.split('/').pop()! }));
    const r = reader(client, text);
    const chunks = await drain(r);
    expect(chunks.map(String)).toEqual(['init-a.mp4', 'seg0.m4s', 'seg1.m4s', 'init-b.mp4', 'seg2.m4s']);
    expect(r.container).toBe('fmp4');
  });

  it('strips the ID3 timestamp tag from packed-audio segments and skips empty ones', async () => {
    const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 4]), Buffer.alloc(4)]);
    const client = new StubClient((url) => {
      const seg = segNumber(url.pathname);
      return { body: seg === 1 ? Buffer.alloc(0) : Buffer.concat([id3, Buffer.from(`audio${seg}`)]) };
    });
    const r = reader(client, media(0, 3, { endList: true, name: (n) => `seg${n}.aac` }));
    const chunks = await drain(r);
    expect(chunks.map(String)).toEqual(['audio0', 'audio2']);
    expect(r.container).toBe('packed-audio');
  });

  it('waits for the consumer when its buffer is full, then resumes', async () => {
    const big = (seq: number) => Buffer.alloc(600 * 1024, seq);
    const client = new StubClient((url) => ({ body: big(segNumber(url.pathname)) }));
    const r = reader(client, media(0, 3, { endList: true }));
    const sizes: number[] = [];
    for await (const chunk of r) sizes.push((chunk as Buffer).length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(3 * 600 * 1024);
    expect(client.calls.filter((p) => p.endsWith('.ts'))).toHaveLength(3);
  });

  it('stops fetching when destroyed while waiting for the consumer', async () => {
    const client = new StubClient((url) => ({ body: Buffer.alloc(600 * 1024, segNumber(url.pathname)) }));
    const r = reader(client, media(0, 5, { endList: true }));
    r.read(0); // starts the loop without consuming anything
    await vi.waitFor(() => expect(r.readableLength).toBe(600 * 1024));
    r.destroy();
    await new Promise((resolve) => setImmediate(resolve));
    expect(r.destroyed).toBe(true);
    expect(client.calls.filter((p) => p.endsWith('.ts'))).toEqual(['/live/seg0.ts']);
  });

  it('stops quietly when destroyed during a playlist refresh', async () => {
    const client = new StubClient((url) =>
      url.pathname.endsWith('.m3u8') ? { hang: true } : { body: tsSegment(segNumber(url.pathname)) },
    );
    const stats = newStats();
    const r = reader(client, media(0, 1), undefined, stats);
    r.on('data', () => {});
    await vi.waitFor(() => expect(client.calls).toContain('/live/index.m3u8'));
    r.destroy();
    await vi.waitFor(() => expect(r.destroyed).toBe(true));
    await new Promise((resolve) => setImmediate(resolve));
    expect(stats.playlistFailures).toBe(0);
  });
});

// ---------------------------------------------------------------- opener

describe('openSourceInput', () => {
  it('maps a refused answer to its reason code and closes the response', async () => {
    const body = new PassThrough();
    const client = new StubClient(() => ({ status: 451, stream: body }));
    await expect(openSourceInput(asClient(client), `${BASE}/stream`)).rejects.toMatchObject({
      code: 'ACCESS_DENIED',
    });
    expect(body.destroyed).toBe(true);
  });

  it.each([
    ['application/json; charset=utf-8', 'application/json'],
    ['image/png', 'image/png'],
  ])('rejects a %s answer as not audio', async (type, base) => {
    const client = new StubClient(() => ({ headers: { 'content-type': type }, body: '{}' }));
    await expect(openSourceInput(asClient(client), `${BASE}/stream`)).rejects.toMatchObject({
      code: 'CONTENT_TYPE_REJECTED',
      userMessage: `That URL serves ${base}, not an audio stream.`,
    });
  });

  it('refuses playlists that point to playlists more than two levels deep', async () => {
    const client = new StubClient((url) => {
      const n = Number(/(\d+)\.pls$/.exec(url.pathname)?.[1] ?? 0);
      return { headers: { 'content-type': 'audio/x-scpls' }, body: `[playlist]\nFile1=/p${n + 1}.pls\n` };
    });
    await expect(openSourceInput(asClient(client), `${BASE}/p0.pls`)).rejects.toMatchObject({
      code: 'PLAYLIST_INVALID',
      userMessage: 'The playlist points to too many other playlists.',
    });
    expect(client.calls).toEqual(['/p0.pls', '/p1.pls', '/p2.pls']);
  });

  it('fails a playlist without stream URLs', async () => {
    const client = new StubClient(() => ({
      headers: { 'content-type': 'audio/x-mpegurl' },
      body: '#EXTM3U\n',
    }));
    await expect(openSourceInput(asClient(client), `${BASE}/list.m3u`)).rejects.toMatchObject({
      code: 'PLAYLIST_INVALID',
      userMessage: 'The playlist contains no stream URLs.',
    });
  });

  it('follows a plain M3U to the first entry that opens', async () => {
    const client = new StubClient((url) => {
      if (url.pathname === '/list.m3u') return { body: '#EXTM3U\n/gone\n/live\n' };
      if (url.pathname === '/gone') return { status: 410 };
      return { headers: { 'content-type': 'audio/mpeg' }, stream: new PassThrough() };
    });
    const input = await openSourceInput(asClient(client), `${BASE}/list.m3u`);
    expect(input.info.transport).toBe('http-continuous');
    expect(client.calls).toEqual(['/list.m3u', '/gone', '/live']);
    input.close();
  });

  it('reads the advertised bitrate from ice-audio-info and reports the default port', async () => {
    const client = new StubClient(() => ({
      headers: {
        'content-type': 'audio/mpeg',
        'icy-br': 'not a number',
        'ice-audio-info': 'ice-samplerate=44100;ice-bitrate=192;ice-channels=2',
        'icy-name': 'N'.repeat(300),
      },
      stream: new PassThrough(),
    }));
    const input = await openSourceInput(asClient(client), `${BASE}/live`, { icyMetadata: false });
    expect(input.info.advertisedBitrateKbps).toBe(192);
    expect(input.info.remotePort).toBe(80);
    expect(input.info.icyName).toHaveLength(200);
    expect(input.info.headersSummary['icy-name']).toHaveLength(200);
    expect(client.requestHeaders).toEqual([{}]);
    input.close();
  });

  it('reports port 443 for https and no advertised bitrate when none is sent', async () => {
    const client = new StubClient(() => ({
      headers: { 'content-type': 'audio/aac' },
      stream: new PassThrough(),
    }));
    const input = await openSourceInput(asClient(client), 'https://radio.example.com/live');
    expect(input.info.remotePort).toBe(443);
    expect(input.info.advertisedBitrateKbps).toBeNull();
    expect(input.info.icyName).toBeNull();
    expect(client.requestHeaders).toEqual([{ 'icy-metadata': '1' }]);
    input.close();
  });

  it('strips ICY metadata, emits titles (null when cleared) and passes on response errors', async () => {
    const block = (text: string) => {
      const b = Buffer.alloc(Math.ceil(text.length / 16) * 16);
      b.write(text);
      return Buffer.concat([Buffer.from([b.length / 16]), b]);
    };
    const body = new PassThrough();
    const client = new StubClient(() => ({
      headers: { 'content-type': 'audio/mpeg', 'icy-metaint': '4' },
      stream: body,
    }));
    const input = await openSourceInput(asClient(client), `${BASE}/live`);
    const titles: Array<string | null> = [];
    input.on('metadata', (m) => titles.push(m?.title ?? null));
    const audio: Buffer[] = [];
    input.stream.on('data', (c: Buffer) => audio.push(c));
    const failed = new Promise<Error>((resolve) => input.stream.on('error', resolve));
    body.write(Buffer.concat([Buffer.from('abcd'), block("StreamTitle='';")]));
    // A block without a StreamTitle field leaves the title as it was.
    body.write(Buffer.concat([Buffer.from('efgh'), block("StreamUrl='http://radio.example.com/';")]));
    body.write(Buffer.concat([Buffer.from('ijkl'), block("StreamTitle='Some Artist - Some Song';")]));
    await vi.waitFor(() => expect(titles).toEqual([null, 'Some Artist - Some Song']));
    expect(Buffer.concat(audio).toString()).toBe('abcdefghijkl');
    expect(input.stats.bytesIn).toBeGreaterThan(12);
    body.destroy(new Error('connection reset'));
    expect((await failed).message).toBe('connection reset');
    input.close();
    expect(input.closed).toBe(true);
    input.close(); // closing twice is harmless
  });

  it('opens an HLS media playlist directly', async () => {
    const client = new StubClient(() => ({
      headers: { 'content-type': 'application/vnd.apple.mpegurl' },
      body: media(0, 2, { extra: ['#EXT-X-MAP:URI="init.mp4"'] }),
    }));
    const input = await openSourceInput(asClient(client), `${BASE}/live/index.m3u8`);
    expect(input.info.transport).toBe('hls');
    expect(input.info.hls).toMatchObject({
      chosen: null,
      alternatives: [],
      container: 'fmp4',
      targetDuration: 2,
    });
    expect(input.info.advertisedBitrateKbps).toBeNull();
    input.close();
  });

  it.each([
    ['encrypted', media(0, 2, { extra: ['#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k"'] }), 'HLS_ENCRYPTED'],
    ['empty', media(0, 0), 'PLAYLIST_INVALID'],
  ])('refuses an %s HLS media playlist', async (_name, body, code) => {
    const client = new StubClient(() => ({ body }));
    await expect(openSourceInput(asClient(client), `${BASE}/live/index.m3u8`)).rejects.toMatchObject({
      code,
    });
  });

  it('refuses an HLS master playlist without an audio track', async () => {
    const master =
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000,CODECS="avc1.640028",AUDIO="aud"\nvideo.m3u8\n';
    const client = new StubClient(() => ({ body: master }));
    await expect(openSourceInput(asClient(client), `${BASE}/master.m3u8`)).rejects.toMatchObject({
      code: 'HLS_NO_AUDIO',
    });
  });

  it('tries each audio rendition in turn and reports the one it chose', async () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=320000,CODECS="mp4a.40.2"',
      'broken.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=256000,CODECS="mp4a.40.2"',
      'nested.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=192000,CODECS="mp4a.40.2"',
      'locked.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"',
      'good.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.5"',
      'low.m3u8',
      '',
    ].join('\n');
    const client = new StubClient((url) => {
      switch (url.pathname) {
        case '/master.m3u8':
          return { body: master };
        case '/broken.m3u8':
          return { status: 500 };
        case '/nested.m3u8':
          return { body: master };
        case '/locked.m3u8':
          return { body: media(0, 2, { extra: ['#EXT-X-KEY:METHOD=AES-128,URI="k"'] }) };
        default:
          return { body: media(0, 2) };
      }
    });
    const input = await openSourceInput(asClient(client), `${BASE}/master.m3u8`);
    expect(input.info.advertisedBitrateKbps).toBe(128);
    expect(input.info.hls?.chosen).toEqual({
      bitrateKbps: 128,
      reason: 'audio-only variant (declared bandwidth)',
      codecs: ['mp4a.40.2'],
    });
    expect(input.info.hls?.alternatives.map((a) => a.bitrateKbps)).toEqual([320, 256, 192, 64]);
    expect(input.info.hls?.playlistHost).toBe('radio.example.com');
    expect(input.info.hls?.container).toBeNull();
    input.close();
  });

  it('reports the last failure when no rendition can be loaded', async () => {
    const master = [
      '#EXTM3U',
      '#EXT-X-STREAM-INF:BANDWIDTH=128000,CODECS="mp4a.40.2"',
      'a.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.2"',
      'b.m3u8',
      '',
    ].join('\n');
    const locked = new StubClient((url) =>
      url.pathname === '/master.m3u8'
        ? { body: master }
        : { body: media(0, 2, { extra: ['#EXT-X-KEY:METHOD=AES-128,URI="k"'] }) },
    );
    await expect(openSourceInput(asClient(locked), `${BASE}/master.m3u8`)).rejects.toMatchObject({
      code: 'HLS_ENCRYPTED',
    });
    const empty = new StubClient((url) =>
      url.pathname === '/master.m3u8' ? { body: master } : { body: media(0, 0) },
    );
    await expect(openSourceInput(asClient(empty), `${BASE}/master.m3u8`)).rejects.toMatchObject({
      code: 'HLS_NO_AUDIO',
      userMessage: 'None of the HLS audio tracks could be loaded.',
    });
  });
});

describe('SourceInput', () => {
  it('closes its stream once and drops its listeners', () => {
    const stream = new PassThrough();
    const input = new SourceInput(stream, {} as never, newStats());
    input.on('metadata', () => {});
    expect(input.closed).toBe(false);
    input.close();
    expect(stream.destroyed).toBe(true);
    expect(input.listenerCount('metadata')).toBe(0);
    expect(input.closed).toBe(true);
  });
});
