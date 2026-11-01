import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

const require = createRequire(import.meta.url);

/** Binaries: FFMPEG_PATH/FFPROBE_PATH if set, else the ffmpeg-static/ffprobe-static dev dependencies. */
export function binaries(): { ffmpeg: string; ffprobe: string } {
  const ffmpeg = process.env.FFMPEG_PATH ?? (require('ffmpeg-static') as string);
  const ffprobe = process.env.FFPROBE_PATH ?? (require('ffprobe-static') as { path: string }).path;
  return { ffmpeg, ffprobe };
}

const DIR = join(import.meta.dirname, '..', 'fixtures', 'generated');

/**
 * Synthetic, rights-free programme material (PRD §17.2): pink noise gated by slow
 * pseudo-random rhythms. Different seeds give audibly different "programmes".
 */
function programmeFilter(seed: number, seconds: number): string {
  return (
    `anoisesrc=d=${seconds}:c=pink:seed=${seed}:a=0.5,` +
    `volume='0.15+0.85*gt(sin(2*PI*t*${(0.31 + seed * 0.07).toFixed(2)}+${seed})*sin(2*PI*t*${(1.1 + seed * 0.13).toFixed(2)}),0)':eval=frame`
  );
}

function ff(ffmpeg: string, args: string[]): void {
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'pipe' });
}

export interface Fixtures {
  mp3Stereo: Buffer;
  aacMono: Buffer;
  opusOgg: Buffer;
  progA: Buffer;
  progB: Buffer;
  hlsDir: string;
}

export function generateFixtures(): Fixtures {
  const { ffmpeg } = binaries();
  mkdirSync(DIR, { recursive: true });
  const p = (n: string) => join(DIR, n);
  if (!existsSync(p('done.flag'))) {
    ff(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      programmeFilter(1, 20),
      '-ac',
      '2',
      '-ar',
      '44100',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '128k',
      p('stereo-128.mp3'),
    ]);
    ff(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      programmeFilter(2, 20),
      '-ac',
      '1',
      '-ar',
      '22050',
      '-c:a',
      'aac',
      '-b:a',
      '48k',
      '-f',
      'adts',
      p('mono-22k.aac'),
    ]);
    ff(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      programmeFilter(3, 20),
      '-ac',
      '2',
      '-ar',
      '48000',
      '-c:a',
      'libopus',
      '-b:a',
      '96k',
      p('stereo.opus'),
    ]);
    ff(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      programmeFilter(4, 60),
      '-ac',
      '2',
      '-ar',
      '44100',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '64k',
      p('prog-a.mp3'),
    ]);
    ff(ffmpeg, [
      '-f',
      'lavfi',
      '-i',
      programmeFilter(5, 60),
      '-ac',
      '2',
      '-ar',
      '44100',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '64k',
      p('prog-b.mp3'),
    ]);
    for (const [name, br] of [
      ['lo', '64k'],
      ['hi', '160k'],
    ] as const) {
      mkdirSync(p(`hls-${name}`), { recursive: true });
      ff(ffmpeg, [
        '-f',
        'lavfi',
        '-i',
        programmeFilter(6, 16),
        '-ac',
        '2',
        '-ar',
        '44100',
        '-c:a',
        'aac',
        '-b:a',
        br,
        '-f',
        'hls',
        '-hls_time',
        '2',
        '-hls_playlist_type',
        'vod',
        '-hls_segment_filename',
        p(`hls-${name}/seg%03d.m2t`),
        p(`hls-${name}/index.m3u8`),
      ]);
    }
    writeFileSync(
      p('master.m3u8'),
      [
        '#EXTM3U',
        '#EXT-X-STREAM-INF:BANDWIDTH=4000000,CODECS="avc1.640028,mp4a.40.2"',
        'missing-video.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=70000,CODECS="mp4a.40.2"',
        'hls-lo/index.m3u8',
        '#EXT-X-STREAM-INF:BANDWIDTH=170000,CODECS="mp4a.40.2"',
        'hls-hi/index.m3u8',
        '',
      ].join('\n'),
    );
    writeFileSync(p('done.flag'), 'ok');
  }
  return {
    mp3Stereo: readFileSync(p('stereo-128.mp3')),
    aacMono: readFileSync(p('mono-22k.aac')),
    opusOgg: readFileSync(p('stereo.opus')),
    progA: readFileSync(p('prog-a.mp3')),
    progB: readFileSync(p('prog-b.mp3')),
    hlsDir: DIR,
  };
}

/** Interleaves ICY metadata every `metaint` bytes. */
function withIcy(audio: Buffer, metaint: number, title: string): Buffer {
  const parts: Buffer[] = [];
  const meta = Buffer.from(`StreamTitle='${title}';`);
  const block = Buffer.alloc(Math.ceil(meta.length / 16) * 16);
  meta.copy(block);
  for (let i = 0; i < audio.length; i += metaint) {
    parts.push(audio.subarray(i, i + metaint));
    if (i + metaint < audio.length) parts.push(Buffer.from([block.length / 16]), block);
  }
  return Buffer.concat(parts);
}

/** How long a "live" fixture route takes to deliver its file: longer than any probe's sample window. */
const LIVE_DELIVERY_MS = 4000;

export interface TestRadio {
  server: Server;
  base: string;
  close(): Promise<void>;
}

/** A self-hosted test radio (PRD §17.2) serving the generated fixtures over HTTP on 127.0.0.1. */
export async function startTestRadio(fx: Fixtures): Promise<TestRadio> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (type: string, body: Buffer, extra: Record<string, string | string[]> = {}) => {
      res.writeHead(200, { 'content-type': type, ...extra });
      res.end(body);
    };
    // Like a real station, a live route keeps delivering past the probe's sample window (and
    // then ends, so playback tests still see an upstream EOF).
    const sendLive = (type: string, body: Buffer, extra: Record<string, string | string[]> = {}) => {
      res.writeHead(200, { 'content-type': type, ...extra });
      const parts = 40;
      const size = Math.ceil(body.length / parts);
      let i = 0;
      const next = () => {
        const part = body.subarray(i * size, (i + 1) * size);
        i++;
        if (i >= parts) {
          clearInterval(timer);
          res.end(part);
        } else res.write(part);
      };
      const timer = setInterval(next, LIVE_DELIVERY_MS / parts);
      res.on('close', () => clearInterval(timer));
      next();
    };
    switch (url.pathname) {
      case '/mp3':
        return sendLive('audio/mpeg', fx.mp3Stereo, { 'icy-br': '128', 'icy-name': 'Test Radio One' });
      case '/icy':
        if (req.headers['icy-metadata'] === '1') {
          return sendLive('audio/mpeg', withIcy(fx.mp3Stereo, 8192, 'Synthetic Artist - Test Tone'), {
            'icy-metaint': '8192',
            'icy-name': 'FG DANCE',
          });
        }
        return sendLive('audio/mpeg', fx.mp3Stereo);
      case '/icy-repeated':
        // The interval header sent twice; Node joins it as "8192, 8192".
        if (req.headers['icy-metadata'] === '1') {
          return sendLive('audio/mpeg', withIcy(fx.mp3Stereo, 8192, 'Repeated Header - Test Tone'), {
            'icy-metaint': ['8192', '8192'],
          });
        }
        return sendLive('audio/mpeg', fx.mp3Stereo);
      case '/icy-garbled':
        // An unreadable interval: metadata would be interleaved at an unknown spacing.
        if (req.headers['icy-metadata'] === '1') {
          return sendLive('audio/mpeg', withIcy(fx.mp3Stereo, 8192, 'Unreadable - Test Tone'), {
            'icy-metaint': 'about 8k',
          });
        }
        return sendLive('audio/mpeg', fx.mp3Stereo);
      case '/offline':
        // A short "station offline" file that is sent in full and then ends.
        return send('audio/mpeg', fx.mp3Stereo.subarray(0, 64 * 1024));
      case '/hang':
        // Accepts the request and never answers.
        return;
      case '/hang.pls':
        return send('audio/x-scpls', Buffer.from('[playlist]\nFile1=/hang\nNumberOfEntries=1\n'));
      case '/aac':
        return sendLive('audio/aac', fx.aacMono);
      case '/opus':
        return sendLive('application/ogg', fx.opusOgg);
      case '/prog-a':
        return send('audio/mpeg', fx.progA);
      case '/prog-a-late': {
        // Same programme, 7 s later (CDN offset): 64 kbps ≈ 8000 bytes/s.
        return send('audio/mpeg', fx.progA.subarray(7 * 8000));
      }
      case '/prog-b':
        return send('audio/mpeg', fx.progB);
      case '/redirect':
        res.writeHead(302, { location: '/mp3' }).end();
        return;
      case '/station.pls':
        return send('audio/x-scpls', Buffer.from('[playlist]\nFile1=/404\nFile2=/mp3\nNumberOfEntries=2\n'));
      case '/html':
        return send('text/html', Buffer.from('<html>not audio</html>'));
      case '/forbidden':
        res.writeHead(403).end();
        return;
      case '/master.m3u8':
        return send('application/vnd.apple.mpegurl', readFileSync(join(fx.hlsDir, 'master.m3u8')));
      default: {
        const m = /^\/(hls-(?:lo|hi))\/(index\.m3u8|seg\d{3}\.m2t)$/.exec(url.pathname);
        if (m) {
          const file = join(fx.hlsDir, m[1]!, m[2]!);
          if (existsSync(file)) {
            return send(
              m[2]!.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
              readFileSync(file),
            );
          }
        }
        res.writeHead(404).end();
      }
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.close(() => r());
        server.closeAllConnections();
      }),
  };
}
