import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { decodeIcyText, IcyDemuxer, parseIcyMetaint, parseIcyStreamTitle } from '../../src/streams/input.ts';
import {
  looksLikeHls,
  MAX_TARGET_DURATION_S,
  parseAttributes,
  parseHls,
  parseM3u,
  parsePls,
  plausibleBandwidth,
  playlistKindFromHeaders,
  rankAudioRenditions,
  stripId3,
} from '../../src/streams/playlists.ts';

const base = new URL('https://cdn.example.com/radio/master.m3u8');

describe('PLS / M3U', () => {
  it('parses PLS entries in order and resolves relative URLs', () => {
    const pls = '[playlist]\nFile2=http://b.example.com/s\nFile1=/live.mp3\nTitle1=x\nNumberOfEntries=2\n';
    expect(parsePls(pls, base).map((u) => u.href)).toEqual([
      'https://cdn.example.com/live.mp3',
      'http://b.example.com/s',
    ]);
  });

  it('ignores non-http schemes in playlists', () => {
    expect(
      parseM3u('#EXTM3U\nfile:///etc/passwd\nhttps://ok.example.com/a\n', base).map((u) => u.href),
    ).toEqual(['https://ok.example.com/a']);
  });

  it('detects playlist kinds', () => {
    expect(playlistKindFromHeaders('audio/x-scpls', new URL('https://x.example.com/a'))).toBe('pls');
    expect(playlistKindFromHeaders('audio/mpeg', new URL('https://x.example.com/a.m3u8'))).toBe('hls');
    expect(playlistKindFromHeaders('audio/mpeg', new URL('https://x.example.com/stream'))).toBe('none');
    expect(looksLikeHls('#EXTM3U\n#EXT-X-VERSION:3\n')).toBe(true);
    expect(looksLikeHls('#EXTM3U\nhttp://a\n')).toBe(false);
  });
});

describe('HLS parsing', () => {
  it('parses attribute lists with quoted commas', () => {
    expect(parseAttributes('BANDWIDTH=128000,CODECS="mp4a.40.2,avc1.4d401f",AUDIO="aud"')).toEqual({
      BANDWIDTH: '128000',
      CODECS: 'mp4a.40.2,avc1.4d401f',
      AUDIO: 'aud',
    });
  });

  it('parses a media playlist with sequence numbers, map and encryption', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-MEDIA-SEQUENCE:100',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:6.0,',
      'seg100.m4s',
      '#EXT-X-DISCONTINUITY',
      '#EXTINF:5.5,',
      'seg101.m4s',
    ].join('\n');
    const p = parseHls(text, base);
    expect(p.type).toBe('media');
    if (p.type !== 'media') return;
    expect(p.segments.map((s) => s.sequence)).toEqual([100, 101]);
    expect(p.segments[0]!.mapUri?.href).toBe('https://cdn.example.com/radio/init.mp4');
    expect(p.segments[1]!.discontinuity).toBe(true);
    expect(p.encryption).toBeNull();
    const enc = parseHls(`${text}\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n`, base);
    expect(enc.type === 'media' && enc.encryption).toBe('AES-128');
  });

  it('ranks audio-only renditions by audio bandwidth, not composite video bandwidth', () => {
    const master = parseHls(
      [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=5000000,CODECS="avc1.640028,mp4a.40.2"',
        'video-hd.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=64000,CODECS="mp4a.40.5"',
        'audio-64.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=192000,AVERAGE-BANDWIDTH=160000,CODECS="mp4a.40.2"',
        'audio-160.m3u8',
      ].join('\n'),
      base,
    );
    expect(master.type).toBe('master');
    if (master.type !== 'master') return;
    const ranked = rankAudioRenditions(master);
    expect(ranked.map((r) => r.uri.pathname.split('/').pop())).toEqual([
      'audio-160.m3u8',
      'audio-64.m3u8',
      'video-hd.m3u8',
    ]);
    expect(ranked[0]!.bitrateKbps).toBe(160);
    expect(ranked[2]!.bitrateKbps).toBeNull();
  });

  it('includes alternate audio renditions', () => {
    const master = parseHls(
      [
        '#EXTM3U',
        '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="Main",DEFAULT=YES,URI="main-audio.m3u8"',
        '#EXT-X-STREAM-INF:BANDWIDTH=3000000,CODECS="avc1.64001f,mp4a.40.2",AUDIO="a"',
        'video.m3u8',
      ].join('\n'),
      base,
    );
    if (master.type !== 'master') throw new Error('expected master');
    const ranked = rankAudioRenditions(master);
    expect(ranked[0]!.uri.pathname).toMatch(/main-audio\.m3u8$/);
  });

  it('keeps a window encrypted when a later #EXT-X-KEY says METHOD=NONE', () => {
    const text = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:6',
      '#EXT-X-KEY:METHOD=AES-128,URI="k"',
      '#EXTINF:6,',
      'a.ts',
      '#EXT-X-KEY:METHOD=NONE',
      '#EXTINF:6,',
      'b.ts',
    ].join('\n');
    const p = parseHls(text, base);
    expect(p.type === 'media' && p.encryption).toBe('AES-128');
  });

  it('clamps an absurd target duration so segment timers stay valid', () => {
    const p = parseHls('#EXTM3U\n#EXT-X-TARGETDURATION:99999999\n#EXTINF:6,\na.ts\n', base);
    expect(p.type === 'media' && p.targetDuration).toBe(MAX_TARGET_DURATION_S);
    const zero = parseHls('#EXTM3U\n#EXT-X-TARGETDURATION:0\n#EXTINF:6,\na.ts\n', base);
    expect(zero.type === 'media' && zero.targetDuration).toBe(1);
  });

  it('rejects text that is not HLS', () => {
    expect(() => parseHls('<html></html>', base)).toThrow();
  });
});

describe('packed audio and ICY metadata', () => {
  it('strips leading ID3v2 tags', () => {
    const id3 = Buffer.from([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 3, 1, 2, 3]);
    const adts = Buffer.from([0xff, 0xf1, 0x50]);
    expect(stripId3(Buffer.concat([id3, adts]))).toEqual(adts);
    expect(stripId3(adts)).toBe(adts);
  });

  it('reads the ICY interval from a repeated header and refuses unusable values', () => {
    expect(parseIcyMetaint(null)).toBe(0);
    expect(parseIcyMetaint('8192')).toBe(8192);
    expect(parseIcyMetaint('8192, 8192')).toBe(8192);
    expect(parseIcyMetaint('abc')).toBeNull();
    expect(parseIcyMetaint('0')).toBeNull();
    expect(parseIcyMetaint(String(2 * 1024 * 1024))).toBeNull();
  });

  it('parses StreamTitle, whether it names a song or a show', () => {
    expect(parseIcyStreamTitle("StreamTitle='Artist - Track';StreamUrl='';")).toBe('Artist - Track');
    expect(parseIcyStreamTitle("StreamTitle='Guns N' Roses - Paradise City';")).toBe(
      "Guns N' Roses - Paradise City",
    );
    expect(parseIcyStreamTitle("StreamTitle='Hakimakli Live';")).toBe('Hakimakli Live');
    expect(parseIcyStreamTitle("StreamTitle='The Killers - Mr. Brightside';")).toBe(
      'The Killers - Mr. Brightside',
    );
  });

  it('tells a missing title field apart from a cleared or placeholder title', () => {
    expect(parseIcyStreamTitle("StreamUrl='https://example.org/';")).toBeUndefined();
    for (const empty of ['', '   ', ' - ', '-', '–', '| ', '...', '???']) {
      expect(parseIcyStreamTitle(`StreamTitle='${empty}';`)).toBeNull();
    }
    for (const placeholder of [
      'Unknown',
      'UNKNOWN  -  UNKNOWN',
      'unknown artist - unknown title',
      'N/A',
      'Advert',
    ]) {
      expect(parseIcyStreamTitle(`StreamTitle='${placeholder}';`)).toBeNull();
    }
    expect(parseIcyStreamTitle(`StreamTitle='${'x'.repeat(301)}';`)).toBeNull();
  });

  it('removes separators left dangling by an empty half', () => {
    expect(parseIcyStreamTitle("StreamTitle='Artist - ';")).toBe('Artist');
    expect(parseIcyStreamTitle("StreamTitle=' - Title';")).toBe('Title');
    expect(parseIcyStreamTitle("StreamTitle='Morning Show | ';")).toBe('Morning Show');
  });

  it('reads UTF-8 titles, and Latin-1 or Windows-1252 ones from older servers', () => {
    expect(decodeIcyText(Buffer.from('Beyoncé – Halo', 'utf8'))).toBe('Beyoncé – Halo');
    expect(decodeIcyText(Buffer.from('Beyoncé', 'latin1'))).toBe('Beyoncé');
    expect(decodeIcyText(Buffer.from([0x44, 0x6f, 0x6e, 0x92, 0x74]))).toBe('Don’t');
  });

  it('removes metadata blocks from audio and reports titles', async () => {
    const titles: (string | null)[] = [];
    const demux = new IcyDemuxer(4, (t) => titles.push(t));
    const meta = Buffer.from("StreamTitle='Hello';");
    const padded = Buffer.alloc(Math.ceil(meta.length / 16) * 16);
    meta.copy(padded);
    const input = Buffer.concat([
      Buffer.from('AAAA'),
      Buffer.from([padded.length / 16]),
      padded,
      Buffer.from('BBBB'),
      Buffer.from([0]),
      Buffer.from('CC'),
    ]);
    const out: Buffer[] = [];
    const src = new PassThrough();
    src.pipe(demux);
    demux.on('data', (c: Buffer) => out.push(c));
    // Feed in awkward chunk sizes to exercise boundary handling.
    for (let i = 0; i < input.length; i += 3) src.write(input.subarray(i, i + 3));
    src.end();
    await new Promise((r) => demux.on('end', r));
    expect(Buffer.concat(out).toString()).toBe('AAAABBBBCC');
    expect(titles).toEqual(['Hello']);
  });

  it('reports a Latin-1 title intact and a cleared title as null', async () => {
    const titles: (string | null)[] = [];
    const demux = new IcyDemuxer(2, (t) => titles.push(t));
    const block = (text: string) => {
      const raw = Buffer.from(text, 'latin1');
      const padded = Buffer.alloc(Math.ceil(raw.length / 16) * 16);
      raw.copy(padded);
      return Buffer.concat([Buffer.from([padded.length / 16]), padded]);
    };
    const src = new PassThrough();
    src.pipe(demux);
    demux.resume();
    src.end(
      Buffer.concat([
        Buffer.from('AA'),
        block("StreamTitle='Céline Dion - Pour que tu m'aimes encore';"),
        Buffer.from('BB'),
        block("StreamTitle='';"),
        Buffer.from('CC'),
      ]),
    );
    await new Promise((r) => demux.on('end', r));
    expect(titles).toEqual(["Céline Dion - Pour que tu m'aimes encore", null]);
  });

  it('ignores HLS BANDWIDTH values that are really sample rates', () => {
    expect(plausibleBandwidth(44_100)).toBeNull();
    expect(plausibleBandwidth(48_000)).toBeNull();
    expect(plausibleBandwidth(4_000)).toBeNull();
    expect(plausibleBandwidth(128_000)).toBe(128_000);
    const master = parseHls(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=44100,CODECS="mp4a.40.2"\nmedia.m3u8\n',
      base,
    );
    if (master.type !== 'master') throw new Error('expected master');
    expect(rankAudioRenditions(master)[0]!.bitrateKbps).toBeNull();
  });
});
