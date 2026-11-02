import { describe, expect, it } from 'vitest';
import {
  type HlsMaster,
  type HlsMedia,
  MAX_PLAYLIST_LINES,
  parseAttributes,
  parseHls,
  parseM3u,
  parsePls,
  plausibleBandwidth,
  playlistKindFromHeaders,
  rankAudioRenditions,
  stripId3,
} from '../../src/streams/playlists.ts';

const base = new URL('https://radio.example.org/live/index.m3u8');
const code = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown';
  }
};

describe('playlist kind from headers', () => {
  it.each([
    [null, '/a.pls', 'pls'],
    ['audio/x-scpls; charset=utf-8', '/stream', 'pls'],
    ['application/pls+xml', '/stream', 'pls'],
    [null, '/a.M3U8', 'hls'],
    ['APPLICATION/VND.APPLE.MPEGURL', '/stream', 'm3u'],
    ['audio/x-mpegurl', '/stream', 'm3u'],
    [null, '/list.m3u', 'm3u'],
    ['audio/mpeg', '/stream.mp3', 'none'],
    ['', '/stream', 'none'],
  ])('content type %s at %s is %s', (ct, path, kind) => {
    expect(playlistKindFromHeaders(ct, new URL(path, base))).toBe(kind);
  });
});

describe('PLS and M3U parsing', () => {
  it('orders PLS entries by number and drops unusable ones', () => {
    const text = [
      '[playlist]',
      'File3=https://radio.example.org/c',
      'file1 = /relative-a',
      'Title1=ignored',
      'File2=ftp://radio.example.org/not-http',
      'File4=http://[broken/',
      'NumberOfEntries=4',
    ].join('\r\n');
    expect(parsePls(text, base).map((u) => u.href)).toEqual([
      'https://radio.example.org/relative-a',
      'https://radio.example.org/c',
    ]);
  });

  it('reads M3U entries, skipping comments, blanks, a BOM and bad URLs', () => {
    const text = '﻿#EXTM3U\n\n#EXTINF:-1,My Station\nstream.mp3\n   \nhttp://[broken/\nmailto:x@example.org\n';
    expect(parseM3u(text, base).map((u) => u.href)).toEqual(['https://radio.example.org/live/stream.mp3']);
  });

  it('refuses a playlist with too many lines', () => {
    const text = 'a\n'.repeat(MAX_PLAYLIST_LINES);
    expect(code(() => parseM3u(text, base))).toBe('PLAYLIST_INVALID');
    expect(code(() => parsePls('a\n'.repeat(MAX_PLAYLIST_LINES - 1), base))).toBeNull();
  });
});

describe('HLS attribute lists', () => {
  it('handles quoted commas, unquoted values and junk', () => {
    expect(parseAttributes('BANDWIDTH=128000,CODECS="mp4a.40.2,mp4a.40.5",NAME=Main,lower=x')).toEqual({
      BANDWIDTH: '128000',
      CODECS: 'mp4a.40.2,mp4a.40.5',
      NAME: 'Main',
    });
    expect(parseAttributes('')).toEqual({});
  });
});

describe('HLS master playlists', () => {
  it('reads variants and audio renditions with missing and malformed attributes', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Main",LANGUAGE="en",DEFAULT=YES,CHANNELS="2",URI="audio/main.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/bare.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="No URI"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",URI="subs.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="ftp://radio.example.org/x.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=abc,AUDIO="aud"',
      '# a comment between the tag and its URI',
      'video/hi.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=64000,AVERAGE-BANDWIDTH=60000,CODECS="MP4A.40.2"',
      'https://radio.example.org/low.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=1',
      'ftp://radio.example.org/unusable.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=2',
    ].join('\n');
    const m = parseHls(text, base) as HlsMaster;
    expect(m.type).toBe('master');
    expect(m.variants).toEqual([
      {
        uri: new URL('https://radio.example.org/live/video/hi.m3u8'),
        bandwidth: null,
        averageBandwidth: null,
        codecs: [],
        audioGroup: 'aud',
      },
      {
        uri: new URL('https://radio.example.org/low.m3u8'),
        bandwidth: 64_000,
        averageBandwidth: 60_000,
        codecs: ['mp4a.40.2'],
        audioGroup: null,
      },
    ]);
    expect(m.audio).toEqual([
      {
        uri: new URL('https://radio.example.org/live/audio/main.m3u8'),
        groupId: 'aud',
        name: 'Main',
        language: 'en',
        isDefault: true,
        channels: '2',
      },
      {
        uri: new URL('https://radio.example.org/live/audio/bare.m3u8'),
        groupId: '',
        name: null,
        language: null,
        isDefault: false,
        channels: null,
      },
    ]);
  });

  it('refuses a master playlist without a usable entry, and text that is not HLS', () => {
    expect(code(() => parseHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n', base))).toBe('PLAYLIST_INVALID');
    expect(code(() => parseHls('#EXTM3U\nstream.mp3\n', base))).toBe('PLAYLIST_INVALID');
    expect(code(() => parseHls('<html></html>', base))).toBe('PLAYLIST_INVALID');
  });
});

describe('HLS media playlists', () => {
  it('clamps the target duration and tolerates malformed numbers', () => {
    const parse = (lines: string[]) => parseHls(['#EXTM3U', ...lines].join('\n'), base) as HlsMedia;
    expect(parse(['#EXT-X-TARGETDURATION:9999']).targetDuration).toBe(60);
    expect(parse(['#EXT-X-TARGETDURATION:0']).targetDuration).toBe(1);
    expect(parse(['#EXT-X-TARGETDURATION:soon']).targetDuration).toBe(10);
    expect(parse(['#EXT-X-MEDIA-SEQUENCE:x']).mediaSequence).toBe(0);
  });

  it('reads segments with durations, sequence numbers, init sections and discontinuities', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:100',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:5.5,',
      'seg100.m4s',
      '#EXTINF:bad,',
      'seg101.m4s',
      '#EXT-X-DISCONTINUITY',
      '#EXT-X-MAP:BYTERANGE="100@0"',
      'seg102.m4s',
      '#EXTINF:4,',
      'ftp://radio.example.org/seg103.m4s',
      'seg104.m4s',
      '#EXT-X-ENDLIST',
    ].join('\n');
    const m = parseHls(text, base) as HlsMedia;
    expect(m).toMatchObject({
      type: 'media',
      targetDuration: 6,
      mediaSequence: 100,
      endList: true,
      encryption: null,
    });
    expect(
      m.segments.map((s) => [
        s.uri.pathname,
        s.duration,
        s.sequence,
        s.mapUri?.pathname ?? null,
        s.discontinuity,
      ]),
    ).toEqual([
      ['/live/seg100.m4s', 5.5, 100, '/live/init.mp4', false],
      ['/live/seg101.m4s', 0, 101, '/live/init.mp4', false],
      ['/live/seg102.m4s', 6, 102, null, true],
      // The unusable segment is dropped, and its duration and flags don't carry over.
      ['/live/seg104.m4s', 6, 103, null, false],
    ]);
  });

  it('keeps the first encryption method it sees', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-KEY:URI="k"',
      '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="k1"',
      '#EXT-X-KEY:METHOD=AES-128,URI="k2"',
      'a.ts',
    ].join('\n');
    expect((parseHls(text, base) as HlsMedia).encryption).toBe('SAMPLE-AES');
  });
});

describe('HLS rendition ranking', () => {
  const variant = (uri: string, o: Partial<HlsMaster['variants'][number]> = {}) => ({
    uri: new URL(uri, base),
    bandwidth: null,
    averageBandwidth: null,
    codecs: [] as string[],
    audioGroup: null,
    ...o,
  });

  it('treats sample rates and tiny values as no bandwidth at all', () => {
    expect(plausibleBandwidth(null)).toBeNull();
    expect(plausibleBandwidth(4_000)).toBeNull();
    expect(plausibleBandwidth(44_100)).toBeNull();
    expect(plausibleBandwidth(128_000)).toBe(128_000);
  });

  it('orders audio-only, then unknown, then renditions, then muxed variants, without duplicates', () => {
    const master: HlsMaster = {
      type: 'master',
      variants: [
        variant('muxed-big.m3u8', { codecs: ['avc1.4d401f', 'mp4a.40.2'], bandwidth: 2_000_000 }),
        variant('muxed-unknown.m3u8', { codecs: ['avc1.4d401f', 'mp4a.40.2'] }),
        variant('muxed-small.m3u8', { codecs: ['avc1.4d401f', 'mp4a.40.2'], bandwidth: 800_000 }),
        variant('muxed-grouped.m3u8', { codecs: ['avc1.4d401f'], audioGroup: 'aud' }),
        variant('unknown-lo.m3u8', { bandwidth: 40_000 }),
        variant('unknown-none.m3u8', { bandwidth: 44_100 }),
        variant('aac-lo.m3u8', { codecs: ['mp4a.40.5'], bandwidth: 64_000 }),
        variant('aac-hi.m3u8', { codecs: ['mp4a.40.2'], averageBandwidth: 192_000, bandwidth: 200_000 }),
        variant('aac-none.m3u8', { codecs: ['mp4a.40.2'], bandwidth: 48_000 /* a sample rate */ }),
        variant('aac-hi.m3u8', { codecs: ['mp4a.40.2'], bandwidth: 100_000 }),
      ],
      audio: [
        {
          uri: new URL('alt.m3u8', base),
          groupId: 'aud',
          name: null,
          language: null,
          isDefault: false,
          channels: null,
        },
        {
          uri: new URL('main.m3u8', base),
          groupId: 'aud',
          name: 'Main',
          language: 'en',
          isDefault: true,
          channels: '2',
        },
      ],
    };
    const ranked = rankAudioRenditions(master);
    expect(ranked.map((r) => [r.uri.pathname.split('/').pop(), r.bitrateKbps])).toEqual([
      ['aac-hi.m3u8', 192],
      ['aac-lo.m3u8', 64],
      ['aac-none.m3u8', null],
      ['unknown-lo.m3u8', 40],
      ['unknown-none.m3u8', null],
      ['main.m3u8', null],
      ['alt.m3u8', null],
      ['muxed-small.m3u8', null],
      ['muxed-big.m3u8', null],
      ['muxed-unknown.m3u8', null],
    ]);
    expect(ranked.find((r) => r.uri.pathname.endsWith('main.m3u8'))?.reason).toBe(
      'alternate audio rendition "Main"',
    );
    expect(ranked.find((r) => r.uri.pathname.endsWith('alt.m3u8'))?.reason).toBe('alternate audio rendition');
  });
});

describe('ID3 stripping', () => {
  const id3 = (size: number, flags = 0) => {
    const h = Buffer.from([0x49, 0x44, 0x33, 4, 0, flags, 0, 0, 0, 0]);
    h[9] = size & 0x7f;
    h[8] = (size >> 7) & 0x7f;
    return Buffer.concat([
      h,
      Buffer.alloc(size, 0xaa),
      flags & 0x10 ? Buffer.alloc(10, 0xbb) : Buffer.alloc(0),
    ]);
  };
  const audio = Buffer.from([0xff, 0xfb, 0x90, 0x00]);

  it('removes consecutive tags, including one with a footer', () => {
    expect(stripId3(Buffer.concat([id3(200), id3(5, 0x10), audio]))).toEqual(audio);
  });

  it('returns the same buffer without a tag, and an empty one when the tag overruns it', () => {
    expect(stripId3(audio)).toBe(audio);
    expect(stripId3(Buffer.from('ID3'))).toEqual(Buffer.from('ID3'));
    const truncated = id3(300).subarray(0, 50);
    expect(stripId3(truncated)).toHaveLength(0);
  });
});

describe('choosing among alternate audio renditions', () => {
  it('takes the group used by the higher-bandwidth variants first, whatever the default', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac-64",NAME="Low",DEFAULT=YES,URI="audio/low.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac-256",NAME="High",URI="audio/high.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aac-64"',
      'video/sd.m3u8',
      '#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.640028,mp4a.40.2",AUDIO="aac-256"',
      'video/hd.m3u8',
    ].join('\n');
    const order = rankAudioRenditions(parseHls(text, base) as HlsMaster).map((c) => c.uri.pathname);
    expect(order.slice(0, 2)).toEqual(['/live/audio/high.m3u8', '/live/audio/low.m3u8']);
  });
});
