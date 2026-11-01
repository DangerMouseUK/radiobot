import { RadioError } from '../shared/errors.ts';

export const MAX_PLAYLIST_LINES = 5000;
/** Upper bound for #EXT-X-TARGETDURATION; it sizes timers, which Node caps at about 24.8 days. */
export const MAX_TARGET_DURATION_S = 60;

export type PlaylistKind = 'hls' | 'pls' | 'm3u' | 'none';

const HLS_TYPES = [
  'application/vnd.apple.mpegurl',
  'application/x-mpegurl',
  'audio/mpegurl',
  'audio/x-mpegurl',
];
const PLS_TYPES = ['audio/x-scpls', 'application/pls+xml', 'audio/scpls'];

/** Guesses whether a response is a playlist from its content type and URL. */
export function playlistKindFromHeaders(contentType: string | null, url: URL): PlaylistKind {
  const ct = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  const path = url.pathname.toLowerCase();
  if (PLS_TYPES.includes(ct) || path.endsWith('.pls')) return 'pls';
  if (path.endsWith('.m3u8')) return 'hls';
  if (HLS_TYPES.includes(ct) || path.endsWith('.m3u')) return 'm3u';
  return 'none';
}

/** True when text is an HLS playlist (has #EXTM3U and at least one #EXT-X- tag). */
export function looksLikeHls(text: string): boolean {
  return /^﻿?#EXTM3U/.test(text.trimStart()) && /#EXT-X-/.test(text);
}

function lines(text: string): string[] {
  const all = text.replace(/^﻿/, '').split(/\r?\n/);
  if (all.length > MAX_PLAYLIST_LINES) throw new RadioError('PLAYLIST_INVALID', 'The playlist is too large.');
  return all.map((l) => l.trim()).filter((l) => l.length > 0);
}

function resolveEntry(entry: string, base: URL): URL | null {
  try {
    const u = new URL(entry, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u : null;
  } catch {
    return null;
  }
}

/** Parses a SHOUTcast/Icecast .pls file, returning absolute http(s) entries in order. */
export function parsePls(text: string, base: URL): URL[] {
  const out: Array<[number, URL]> = [];
  for (const line of lines(text)) {
    const m = /^File(\d+)\s*=\s*(.+)$/i.exec(line);
    if (!m) continue;
    const u = resolveEntry(m[2]!, base);
    if (u) out.push([Number(m[1]), u]);
  }
  return out.sort((a, b) => a[0] - b[0]).map(([, u]) => u);
}

/** Parses a plain (non-HLS) M3U file. */
export function parseM3u(text: string, base: URL): URL[] {
  return lines(text)
    .filter((l) => !l.startsWith('#'))
    .map((l) => resolveEntry(l, base))
    .filter((u): u is URL => u !== null);
}

// ---------------------------------------------------------------- HLS

export interface HlsVariant {
  uri: URL;
  bandwidth: number | null;
  averageBandwidth: number | null;
  codecs: string[];
  audioGroup: string | null;
}

export interface HlsAudioRendition {
  uri: URL;
  groupId: string;
  name: string | null;
  language: string | null;
  isDefault: boolean;
  channels: string | null;
}

export interface HlsMaster {
  type: 'master';
  variants: HlsVariant[];
  audio: HlsAudioRendition[];
}

export interface HlsSegment {
  uri: URL;
  duration: number;
  sequence: number;
  mapUri: URL | null;
  discontinuity: boolean;
}

export interface HlsMedia {
  type: 'media';
  targetDuration: number;
  mediaSequence: number;
  segments: HlsSegment[];
  endList: boolean;
  encryption: string | null;
}

/** Parses an HLS attribute list: KEY=VALUE,KEY="quoted, value",... */
export function parseAttributes(input: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  for (let m = re.exec(input); m !== null; m = re.exec(input)) {
    const raw = m[2]!;
    out[m[1]!] = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  }
  return out;
}

const num = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export function parseHls(text: string, base: URL): HlsMaster | HlsMedia {
  if (!looksLikeHls(text)) throw new RadioError('PLAYLIST_INVALID', 'Not a valid HLS playlist.');
  const ls = lines(text);
  if (ls.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants: HlsVariant[] = [];
    const audio: HlsAudioRendition[] = [];
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i]!;
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = parseAttributes(l.slice('#EXT-X-STREAM-INF:'.length));
        let j = i + 1;
        while (j < ls.length && ls[j]!.startsWith('#')) j++;
        const uri = ls[j] ? resolveEntry(ls[j]!, base) : null;
        if (uri) {
          variants.push({
            uri,
            bandwidth: num(attrs.BANDWIDTH),
            averageBandwidth: num(attrs['AVERAGE-BANDWIDTH']),
            codecs: (attrs.CODECS ?? '')
              .split(',')
              .map((c) => c.trim().toLowerCase())
              .filter(Boolean),
            audioGroup: attrs.AUDIO ?? null,
          });
        }
        i = j;
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const attrs = parseAttributes(l.slice('#EXT-X-MEDIA:'.length));
        if (attrs.TYPE === 'AUDIO' && attrs.URI) {
          const uri = resolveEntry(attrs.URI, base);
          if (uri) {
            audio.push({
              uri,
              groupId: attrs['GROUP-ID'] ?? '',
              name: attrs.NAME ?? null,
              language: attrs.LANGUAGE ?? null,
              isDefault: attrs.DEFAULT === 'YES',
              channels: attrs.CHANNELS ?? null,
            });
          }
        }
      }
    }
    if (variants.length === 0 && audio.length === 0) {
      throw new RadioError('PLAYLIST_INVALID', 'The HLS master playlist has no usable entries.');
    }
    return { type: 'master', variants, audio };
  }

  let targetDuration = 10;
  let mediaSequence = 0;
  let endList = false;
  let encryption: string | null = null;
  let pendingDuration: number | null = null;
  let pendingDiscontinuity = false;
  let mapUri: URL | null = null;
  const segments: HlsSegment[] = [];
  for (const l of ls) {
    if (l.startsWith('#EXT-X-TARGETDURATION:')) {
      const declared = num(l.split(':')[1]) ?? targetDuration;
      targetDuration = Math.min(Math.max(declared, 1), MAX_TARGET_DURATION_S);
    } else if (l.startsWith('#EXT-X-MEDIA-SEQUENCE:')) mediaSequence = num(l.split(':')[1]) ?? 0;
    else if (l === '#EXT-X-ENDLIST') endList = true;
    else if (l === '#EXT-X-DISCONTINUITY') pendingDiscontinuity = true;
    else if (l.startsWith('#EXT-X-KEY:')) {
      // Sticky: once any segment in the window is encrypted, the playlist is refused as a whole.
      const method = parseAttributes(l.slice('#EXT-X-KEY:'.length)).METHOD ?? 'NONE';
      if (method !== 'NONE') encryption ??= method;
    } else if (l.startsWith('#EXT-X-MAP:')) {
      const uri = parseAttributes(l.slice('#EXT-X-MAP:'.length)).URI;
      mapUri = uri ? resolveEntry(uri, base) : null;
    } else if (l.startsWith('#EXTINF:')) {
      pendingDuration = num(l.slice('#EXTINF:'.length).split(',')[0]) ?? 0;
    } else if (!l.startsWith('#')) {
      const uri = resolveEntry(l, base);
      if (uri) {
        segments.push({
          uri,
          duration: pendingDuration ?? targetDuration,
          sequence: mediaSequence + segments.length,
          mapUri,
          discontinuity: pendingDiscontinuity,
        });
      }
      pendingDuration = null;
      pendingDiscontinuity = false;
    }
  }
  return { type: 'media', targetDuration, mediaSequence, segments, endList, encryption };
}

const VIDEO_CODEC = /^(avc|hvc|hev|vp0|vp8|vp9|av01|dvh|dvhe|mp4v)/;
const AUDIO_CODEC = /^(mp4a|mp3|\.mp3|opus|flac|ac-3|ec-3|alac)/;

export interface RenditionChoice {
  uri: URL;
  bitrateKbps: number | null;
  /** Why this rendition was ranked where it was. */
  reason: string;
  codecs: string[];
}

/**
 * Orders the audio renditions of a master playlist best-first (PRD §7.3 step 5): audio-only
 * variants by declared audio bandwidth, then alternate audio renditions, then muxed
 * audio+video variants (whose BANDWIDTH says nothing about audio fidelity) cheapest first.
 */
/** Some hosts put the sample rate (e.g. 44100) in BANDWIDTH; such values say nothing about bitrate. */
const SAMPLE_RATES = new Set([8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000]);
export function plausibleBandwidth(bw: number | null): number | null {
  if (bw === null || bw < 8000 || SAMPLE_RATES.has(bw)) return null;
  return bw;
}

export function rankAudioRenditions(master: HlsMaster): RenditionChoice[] {
  const audioOnly: RenditionChoice[] = [];
  const unknown: RenditionChoice[] = [];
  const muxed: Array<RenditionChoice & { bw: number }> = [];
  for (const v of master.variants) {
    const bw = plausibleBandwidth(v.averageBandwidth ?? v.bandwidth);
    const hasVideo = v.codecs.some((c) => VIDEO_CODEC.test(c));
    const hasAudio = v.codecs.some((c) => AUDIO_CODEC.test(c));
    if (v.codecs.length > 0 && hasAudio && !hasVideo) {
      audioOnly.push({
        uri: v.uri,
        bitrateKbps: bw ? Math.round(bw / 1000) : null,
        reason: 'audio-only variant (declared bandwidth)',
        codecs: v.codecs,
      });
    } else if (v.codecs.length === 0) {
      unknown.push({
        uri: v.uri,
        bitrateKbps: bw ? Math.round(bw / 1000) : null,
        reason: 'variant without CODECS (bandwidth may include overhead)',
        codecs: [],
      });
    } else if (!v.audioGroup) {
      muxed.push({
        uri: v.uri,
        bitrateKbps: null,
        reason: 'audio muxed with video; audio bitrate not declared',
        codecs: v.codecs,
        bw: bw ?? Number.MAX_SAFE_INTEGER,
      });
    }
  }
  const byBitrate = (a: RenditionChoice, b: RenditionChoice) => (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0);
  const renditions = [...master.audio]
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault))
    .map<RenditionChoice>((r) => ({
      uri: r.uri,
      bitrateKbps: null,
      reason: `alternate audio rendition${r.name ? ` "${r.name}"` : ''}`,
      codecs: [],
    }));
  const seen = new Set<string>();
  return [
    ...audioOnly.sort(byBitrate),
    ...unknown.sort(byBitrate),
    ...renditions,
    ...muxed.sort((a, b) => a.bw - b.bw).map(({ bw: _bw, ...rest }) => rest),
  ].filter((c) => {
    if (seen.has(c.uri.href)) return false;
    seen.add(c.uri.href);
    return true;
  });
}

/** Removes a leading ID3v2 tag (packed-audio HLS segments carry timestamps in one). */
export function stripId3(buf: Buffer): Buffer {
  let offset = 0;
  while (buf.length - offset >= 10 && buf.toString('latin1', offset, offset + 3) === 'ID3') {
    const flags = buf[offset + 5]!;
    const size =
      ((buf[offset + 6]! & 0x7f) << 21) |
      ((buf[offset + 7]! & 0x7f) << 14) |
      ((buf[offset + 8]! & 0x7f) << 7) |
      (buf[offset + 9]! & 0x7f);
    offset += 10 + size + (flags & 0x10 ? 10 : 0);
  }
  return offset > 0 ? buf.subarray(Math.min(offset, buf.length)) : buf;
}
