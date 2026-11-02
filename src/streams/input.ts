import { EventEmitter } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import type { Transport } from '../catalogue/types.ts';
import { delay } from '../shared/async.ts';
import { RadioError } from '../shared/errors.ts';
import {
  type HlsMedia,
  looksLikeHls,
  parseHls,
  parseM3u,
  parsePls,
  playlistKindFromHeaders,
  type RenditionChoice,
  rankAudioRenditions,
  stripId3,
} from './playlists.ts';
import { headerString, readCapped, type SafeHttpClient, statusError } from './safe-fetch.ts';

const MAX_SEGMENT_BYTES = 16 * 1024 * 1024;
const MAX_PLAYLIST_BYTES = 512 * 1024;
const LIVE_EDGE_SEGMENTS = 3;

export interface InputStats {
  /** Host that served the most recent HLS segment (segments can come from other nodes). */
  segmentHost: string | null;
  bytesIn: number;
  firstByteAt: number | null;
  lastByteAt: number | null;
  segmentsFetched: number;
  segmentFailures: number;
  playlistFailures: number;
  skippedSegments: number;
  /** Times the HLS reader jumped forward to the live edge after falling out of the live window. */
  liveEdgeSkips: number;
}

export interface NowPlayingMeta {
  title: string;
  receivedAt: string;
  source: 'icy-stream-title';
}

export interface InputInfo {
  transport: Transport;
  /** Host of the URL as configured, before redirects. */
  requestedHost: string;
  finalHost: string;
  /** IP address and port of the stream server actually connected to. */
  remoteAddress: string | null;
  remotePort: number | null;
  redirects: string[];
  contentType: string | null;
  headersSummary: Record<string, string>;
  advertisedBitrateKbps: number | null;
  icyName: string | null;
  hls: null | {
    playlistHost: string;
    chosen: { bitrateKbps: number | null; reason: string; codecs: string[] } | null;
    alternatives: Array<{ bitrateKbps: number | null; reason: string; codecs: string[] }>;
    targetDuration: number;
    container: string | null;
  };
}

/** An open, policy-checked byte stream of a station source, ready to be fed to FFmpeg. */
/** `metadata` carries the latest title, or null when the station clears it (for example during adverts). */
export class SourceInput extends EventEmitter<{ metadata: [NowPlayingMeta | null] }> {
  readonly stream: Readable;
  readonly info: InputInfo;
  readonly stats: InputStats;
  readonly openedAt: number;
  #closed = false;

  constructor(stream: Readable, info: InputInfo, stats: InputStats) {
    super();
    this.stream = stream;
    this.info = info;
    this.stats = stats;
    this.openedAt = Date.now();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.stream.destroy();
    this.removeAllListeners();
  }

  get closed(): boolean {
    return this.#closed;
  }
}

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

function countBytes(stats: InputStats, n: number): void {
  const now = Date.now();
  stats.bytesIn += n;
  stats.firstByteAt ??= now;
  stats.lastByteAt = now;
}

const SUMMARY_HEADERS = [
  'content-type',
  'server',
  'icy-name',
  'icy-genre',
  'icy-br',
  'icy-sr',
  'icy-description',
  'icy-metaint',
  'ice-audio-info',
];

function summariseHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of SUMMARY_HEADERS) {
    const v = headerString(headers, h);
    if (v) out[h] = v.slice(0, 200);
  }
  return out;
}

function advertisedBitrate(headers: IncomingHttpHeaders): number | null {
  const icyBr = headerString(headers, 'icy-br');
  const fromIcy = icyBr ? Number.parseInt(icyBr.split(',')[0]!, 10) : Number.NaN;
  if (Number.isFinite(fromIcy) && fromIcy > 0 && fromIcy < 2000) return fromIcy;
  const audioInfo = headerString(headers, 'ice-audio-info');
  const m = audioInfo ? /(?:^|;)\s*(?:ice-)?bitrate=(\d+)/i.exec(audioInfo) : null;
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------- ICY metadata

/** Strips interleaved SHOUTcast/Icecast metadata blocks and surfaces StreamTitle. */
export class IcyDemuxer extends Transform {
  readonly #metaint: number;
  #remainingAudio: number;
  #metaRemaining = -1;
  #meta: Buffer[] = [];
  readonly #onTitle: (title: string | null) => void;

  constructor(metaint: number, onTitle: (title: string | null) => void) {
    super();
    this.#metaint = metaint;
    this.#remainingAudio = metaint;
    this.#onTitle = onTitle;
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.#remainingAudio > 0) {
        const n = Math.min(this.#remainingAudio, chunk.length - offset);
        this.push(chunk.subarray(offset, offset + n));
        offset += n;
        this.#remainingAudio -= n;
      } else if (this.#metaRemaining < 0) {
        this.#metaRemaining = chunk[offset]! * 16;
        offset += 1;
        if (this.#metaRemaining === 0) this.#endMeta();
      } else {
        const n = Math.min(this.#metaRemaining, chunk.length - offset);
        this.#meta.push(chunk.subarray(offset, offset + n));
        offset += n;
        this.#metaRemaining -= n;
        if (this.#metaRemaining === 0) this.#endMeta();
      }
    }
    cb();
  }

  #endMeta(): void {
    if (this.#meta.length > 0) {
      const text = decodeIcyText(Buffer.concat(this.#meta)).replace(/\0+$/, '');
      const title = parseIcyStreamTitle(text);
      if (title !== undefined) this.#onTitle(title);
    }
    this.#meta = [];
    this.#metaRemaining = -1;
    this.#remainingAudio = this.#metaint;
  }
}

const UTF8 = new TextDecoder('utf-8', { fatal: true });
/** Windows-1252, the superset of Latin-1 that older SHOUTcast encoders send (Node's ICU provides it). */
const LEGACY = ((): InstanceType<typeof TextDecoder> | null => {
  try {
    return new TextDecoder('windows-1252');
  } catch {
    return null;
  }
})();

/** ICY metadata declares no character set: it is read as UTF-8 when valid, otherwise as Windows-1252. */
export function decodeIcyText(bytes: Buffer): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    return LEGACY ? LEGACY.decode(bytes) : bytes.toString('latin1');
  }
}

/** Titles stations send when there is nothing to show, compared without case. */
const PLACEHOLDER_TITLES = new Set([
  'unknown',
  'unknown - unknown',
  'unknown artist - unknown title',
  'unknown artist - unknown track',
  'untitled',
  'no title',
  'no name',
  'n/a',
  'none',
  'null',
  'undefined',
  'advert',
  'adverts',
  'advertisement',
  'advertising',
  'commercial',
  'commercials',
  'ad break',
]);

/** Separators left dangling when one half of "Artist - Title" or "Show | Host" is empty. */
const EDGE_SEPARATORS = /^[\s\-–—|:·•]+|[\s\-–—|:·•]+$/gu;

/**
 * Reads StreamTitle from an ICY metadata block. Returns undefined when the block has no title
 * field, null when the station cleared the title or sent a placeholder, and otherwise the text
 * (a song, a show or anything else the station chose) with dangling separators removed.
 */
export function parseIcyStreamTitle(block: string): string | null | undefined {
  const m = /StreamTitle='(.*?)';/s.exec(block);
  if (!m) return undefined;
  const title = m[1]!.replace(EDGE_SEPARATORS, '');
  if (title.length === 0 || title.length > 300 || !/[\p{L}\p{N}]/u.test(title)) return null;
  return PLACEHOLDER_TITLES.has(title.toLowerCase().replace(/\s+/g, ' ')) ? null : title;
}

// ---------------------------------------------------------------- HLS live reader

export class HlsReader extends Readable {
  readonly #client: SafeHttpClient;
  readonly #playlistUrl: URL;
  readonly #stats: InputStats;
  readonly #abort = new AbortController();
  #wantMore: (() => void) | null = null;
  #started = false;
  #nextSequence: number | null = null;
  #lastMap: string | null = null;
  readonly #liveEdge: number;
  #initial: HlsMedia | null;
  targetDuration = 6;
  container: string | null = null;

  constructor(
    client: SafeHttpClient,
    playlistUrl: URL,
    stats: InputStats,
    initial: HlsMedia,
    liveEdgeSegments = LIVE_EDGE_SEGMENTS,
  ) {
    super({ highWaterMark: 512 * 1024 });
    this.#client = client;
    this.#playlistUrl = playlistUrl;
    this.#stats = stats;
    this.targetDuration = initial.targetDuration;
    this.#initial = initial;
    this.#liveEdge = Math.max(1, liveEdgeSegments);
  }

  override _read(): void {
    if (!this.#started) {
      this.#started = true;
      this.#loop().catch((err: unknown) => this.destroy(err as Error));
      return;
    }
    const resume = this.#wantMore;
    this.#wantMore = null;
    resume?.();
  }

  override _destroy(err: Error | null, cb: (error?: Error | null) => void): void {
    this.#abort.abort();
    this.#wantMore?.();
    cb(err);
  }

  async #pushChecked(buf: Buffer): Promise<void> {
    if (buf.length === 0) return;
    countBytes(this.#stats, buf.length);
    if (!this.push(buf)) {
      await new Promise<void>((resolve) => {
        this.#wantMore = resolve;
      });
    }
  }

  async #fetchPlaylist(): Promise<HlsMedia> {
    const { text, finalUrl } = await this.#client.fetchText(this.#playlistUrl, {
      maxBytes: MAX_PLAYLIST_BYTES,
      signal: this.#abort.signal,
      totalTimeoutMs: 10_000,
    });
    const parsed = parseHls(text, finalUrl);
    if (parsed.type !== 'media') throw new RadioError('PLAYLIST_INVALID', 'Expected an HLS media playlist.');
    return parsed;
  }

  async #fetchSegment(uri: URL): Promise<Buffer> {
    const { bytes, finalUrl } = await this.#client.fetchBytes(uri, {
      maxBytes: MAX_SEGMENT_BYTES,
      signal: this.#abort.signal,
      totalTimeoutMs: Math.max(10_000, this.targetDuration * 2000),
    });
    this.#stats.segmentHost = finalUrl.host;
    return bytes;
  }

  /** A media segment or init section, tried twice so one transient failure doesn't end the stream. */
  async #fetchTwice(uri: URL): Promise<Buffer | null> {
    for (let attempt = 0; attempt < 2 && !this.destroyed; attempt++) {
      try {
        return await this.#fetchSegment(uri);
      } catch {
        this.#stats.segmentFailures++;
      }
    }
    return null;
  }

  async #loop(): Promise<void> {
    let playlistFailures = 0;
    let segmentFailuresInRow = 0;
    while (!this.destroyed) {
      let playlist: HlsMedia;
      try {
        playlist = this.#initial ?? (await this.#fetchPlaylist());
        this.#initial = null;
        playlistFailures = 0;
      } catch (err) {
        if (this.destroyed) return;
        this.#stats.playlistFailures++;
        playlistFailures++;
        if (playlistFailures >= 5) {
          throw new RadioError('HLS_PLAYLIST_FAILED', 'The HLS playlist could not be refreshed.', {
            cause: err,
          });
        }
        await delay(Math.min(1000 * playlistFailures, 5000), undefined, { signal: this.#abort.signal }).catch(
          () => {},
        );
        continue;
      }
      if (playlist.encryption) {
        throw new RadioError('HLS_ENCRYPTED', 'This HLS stream is encrypted and cannot be played.');
      }
      this.targetDuration = playlist.targetDuration;
      const segs = playlist.segments;
      if (this.#nextSequence === null) {
        const start = playlist.endList ? 0 : Math.max(0, segs.length - this.#liveEdge);
        this.#nextSequence = segs[start]?.sequence ?? playlist.mediaSequence;
      } else if (segs.length > 0 && segs[segs.length - 1]!.sequence + 1 < this.#nextSequence) {
        // The playlist ends before what was already sent. A little behind is a stale copy from
        // another CDN node: nothing new, so poll again. Further back than the playlist is long,
        // sequence numbers went backwards (upstream encoder restart): resync near the live edge.
        const behind = this.#nextSequence - 1 - segs[segs.length - 1]!.sequence;
        if (behind > segs.length) {
          this.#nextSequence = segs[Math.max(0, segs.length - this.#liveEdge)]!.sequence;
        }
      } else if (segs.length > 0 && this.#nextSequence < segs[0]!.sequence) {
        // We fell out of the live window (long stall): resynchronise near the live edge.
        this.#stats.skippedSegments += segs[0]!.sequence - this.#nextSequence;
        this.#stats.liveEdgeSkips++;
        this.#nextSequence = segs[Math.max(0, segs.length - this.#liveEdge)]!.sequence;
      }
      for (const seg of segs) {
        if (this.destroyed) return;
        if (seg.sequence < this.#nextSequence) continue;
        let data: Buffer | null = null;
        const mapUri = seg.mapUri;
        if (mapUri && mapUri.href !== this.#lastMap) {
          // A segment can't be decoded without its init section: if that fails, so does the segment.
          const init = await this.#fetchTwice(mapUri);
          if (init) {
            this.#lastMap = mapUri.href;
            this.container ??= 'fmp4';
            await this.#pushChecked(init);
            data = await this.#fetchTwice(seg.uri);
          }
        } else {
          data = await this.#fetchTwice(seg.uri);
        }
        this.#nextSequence = seg.sequence + 1;
        if (data === null) {
          segmentFailuresInRow++;
          this.#stats.skippedSegments++;
          if (segmentFailuresInRow > 3) {
            throw new RadioError(
              'HLS_SEGMENT_FAILED',
              'Several HLS segments in a row could not be downloaded.',
            );
          }
          continue;
        }
        segmentFailuresInRow = 0;
        this.#stats.segmentsFetched++;
        if (!seg.mapUri) {
          this.container ??= data[0] === 0x47 ? 'mpegts' : 'packed-audio';
          data = data[0] === 0x47 ? data : stripId3(data);
        }
        await this.#pushChecked(data);
      }
      if (playlist.endList && this.#nextSequence > (segs[segs.length - 1]?.sequence ?? -1)) {
        this.push(null);
        return;
      }
      // Re-poll at half the target duration, as RFC 8216 §6.3.4 permits.
      const wait = this.targetDuration * 500;
      await delay(Math.min(Math.max(wait, 1000), 10_000), undefined, { signal: this.#abort.signal }).catch(
        () => {},
      );
    }
  }
}

// ---------------------------------------------------------------- opener

const MAX_ICY_METAINT = 1_048_576;

/**
 * The ICY metadata interval: 0 when the header is absent, null when it is present but unusable
 * (not a number, or out of range). Node joins a repeated header as "8192, 8192", so the first
 * value counts.
 */
export function parseIcyMetaint(header: string | null): number | null {
  if (header === null || header.trim() === '') return 0;
  const m = /^\s*(\d+)\s*(?:,|$)/.exec(header);
  const n = m ? Number(m[1]) : Number.NaN;
  return n > 0 && n <= MAX_ICY_METAINT ? n : null;
}

export interface OpenOptions {
  signal?: AbortSignal;
  /** Segments behind the live edge to start an HLS stream (default 3; identity comparisons use 1). */
  hlsLiveEdgeSegments?: number;
  /** Request ICY in-band metadata (now-playing). */
  icyMetadata?: boolean;
  headersTimeoutMs?: number;
}

/**
 * Opens a source URL and returns a byte stream of audio, resolving PLS/M3U indirection
 * and HLS master/media playlists. All network access goes through the SafeHttpClient.
 */
export async function openSourceInput(
  client: SafeHttpClient,
  rawUrl: string,
  opts: OpenOptions = {},
  depth = 0,
): Promise<SourceInput> {
  if (depth > 2) throw new RadioError('PLAYLIST_INVALID', 'The playlist points to too many other playlists.');
  const res = await client.request(rawUrl, {
    signal: opts.signal,
    headersTimeoutMs: opts.headersTimeoutMs ?? 10_000,
    headers: opts.icyMetadata === false ? {} : { 'icy-metadata': '1' },
  });
  if (res.status < 200 || res.status >= 300) {
    res.response.destroy();
    throw statusError(res.status);
  }
  const contentType = headerString(res.headers, 'content-type');
  const ctBase = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (ctBase === 'text/html' || ctBase === 'application/json' || ctBase.startsWith('image/')) {
    res.response.destroy();
    throw new RadioError('CONTENT_TYPE_REJECTED', `That URL serves ${ctBase}, not an audio stream.`);
  }
  const kind = playlistKindFromHeaders(contentType, res.finalUrl);
  const stats = newStats();
  const baseInfo = {
    requestedHost: new URL(rawUrl).host,
    finalHost: res.finalUrl.host,
    remoteAddress: res.remoteAddress,
    remotePort: res.finalUrl.port ? Number(res.finalUrl.port) : res.finalUrl.protocol === 'https:' ? 443 : 80,
    redirects: res.redirects,
    contentType,
    headersSummary: summariseHeaders(res.headers),
  };

  if (kind !== 'none') {
    const text = (await readCapped(res.response, MAX_PLAYLIST_BYTES, 10_000)).toString('utf8');
    if (looksLikeHls(text)) return openHls(client, text, res.finalUrl, stats, baseInfo, opts);
    const entries = kind === 'pls' ? parsePls(text, res.finalUrl) : parseM3u(text, res.finalUrl);
    let lastErr: unknown = new RadioError('PLAYLIST_INVALID', 'The playlist contains no stream URLs.');
    for (const entry of entries.slice(0, 5)) {
      try {
        return await openSourceInput(client, entry.href, opts, depth + 1);
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  const metaint = parseIcyMetaint(headerString(res.headers, 'icy-metaint'));
  if (metaint === null && opts.icyMetadata !== false) {
    // The server interleaves metadata at an interval we can't read, which would corrupt the
    // audio: ask again without in-band metadata.
    res.response.destroy();
    return openSourceInput(client, rawUrl, { ...opts, icyMetadata: false }, depth);
  }
  const icyName = headerString(res.headers, 'icy-name');
  let stream: Readable = res.response;
  let input: SourceInput | null = null;
  if (metaint) {
    const demux = new IcyDemuxer(metaint, (title) => {
      input?.emit(
        'metadata',
        title === null ? null : { title, receivedAt: new Date().toISOString(), source: 'icy-stream-title' },
      );
    });
    res.response.on('error', (err) => demux.destroy(err));
    demux.on('close', () => res.response.destroy());
    stream = res.response.pipe(demux);
  }
  res.response.on('data', (chunk: Buffer) => countBytes(stats, chunk.length));
  input = new SourceInput(
    stream,
    {
      ...baseInfo,
      transport: 'http-continuous',
      advertisedBitrateKbps: advertisedBitrate(res.headers),
      icyName: icyName ? icyName.slice(0, 200) : null,
      hls: null,
    },
    stats,
  );
  return input;
}

async function openHls(
  client: SafeHttpClient,
  text: string,
  url: URL,
  stats: InputStats,
  baseInfo: Omit<InputInfo, 'transport' | 'advertisedBitrateKbps' | 'icyName' | 'hls'>,
  opts: OpenOptions,
): Promise<SourceInput> {
  const parsed = parseHls(text, url);
  let media: HlsMedia;
  let mediaUrl = url;
  let chosen: RenditionChoice | null = null;
  let alternatives: RenditionChoice[] = [];
  if (parsed.type === 'master') {
    const ranked = rankAudioRenditions(parsed);
    if (ranked.length === 0) throw new RadioError('HLS_NO_AUDIO', 'The HLS stream has no audio track.');
    let lastErr: unknown = null;
    let found: HlsMedia | null = null;
    for (const candidate of ranked) {
      try {
        const r = await client.fetchText(candidate.uri, {
          maxBytes: MAX_PLAYLIST_BYTES,
          signal: opts.signal,
        });
        const p = parseHls(r.text, r.finalUrl);
        if (p.type !== 'media' || p.segments.length === 0) continue;
        if (p.encryption) {
          lastErr = new RadioError('HLS_ENCRYPTED', 'This HLS stream is encrypted and cannot be played.');
          continue;
        }
        found = p;
        mediaUrl = r.finalUrl;
        chosen = candidate;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!found)
      throw lastErr ?? new RadioError('HLS_NO_AUDIO', 'None of the HLS audio tracks could be loaded.');
    media = found;
    alternatives = ranked.filter((r) => r !== chosen);
  } else {
    media = parsed;
  }
  if (media.encryption)
    throw new RadioError('HLS_ENCRYPTED', 'This HLS stream is encrypted and cannot be played.');
  if (media.segments.length === 0)
    throw new RadioError('PLAYLIST_INVALID', 'The HLS playlist has no segments.');
  const reader = new HlsReader(client, mediaUrl, stats, media, opts.hlsLiveEdgeSegments);
  const strip = (c: RenditionChoice) => ({ bitrateKbps: c.bitrateKbps, reason: c.reason, codecs: c.codecs });
  const info: InputInfo = {
    ...baseInfo,
    transport: 'hls',
    advertisedBitrateKbps: chosen?.bitrateKbps ?? null,
    icyName: null,
    hls: {
      playlistHost: mediaUrl.host,
      chosen: chosen ? strip(chosen) : null,
      alternatives: alternatives.map(strip),
      targetDuration: media.targetDuration,
      container: media.segments[0]?.mapUri ? 'fmp4' : null,
    },
  };
  return new SourceInput(reader, info, stats);
}
