import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorCode } from '../../src/shared/errors.ts';
import { DEFAULT_USER_AGENT, lavfUserAgent, SafeHttpClient } from '../../src/streams/safe-fetch.ts';
import { isBlockedAddress, isBlockedIPv6, parseIPv6, UrlPolicy } from '../../src/streams/url-policy.ts';

const policy = new UrlPolicy({ allowInsecureHttp: true });

function code(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return errorCode(err);
  }
}

describe('address classification', () => {
  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '198.18.0.1',
    '192.0.2.1',
  ])('blocks IPv4 %s', (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '100.128.0.1'])(
    'allows public IPv4 %s',
    (ip) => {
      expect(isBlockedAddress(ip)).toBe(false);
    },
  );

  it.each([
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '64:ff9b::a00:1',
    '2002:7f00:0001::1',
    '2002:c0a8:0101::1',
    '2001:db8::1',
    '2001::1',
    'fec0::1',
  ])('blocks IPv6 %s', (ip) => {
    expect(isBlockedIPv6(ip)).toBe(true);
  });

  it.each([
    '2606:4700:4700::1111',
    '2a00:1450:4007:80f::200e',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808',
    '2002:0808:0808::1',
  ])('allows public IPv6 %s', (ip) => {
    expect(isBlockedIPv6(ip)).toBe(false);
  });

  it('parses IPv6 with embedded IPv4 and rejects malformed input', () => {
    expect(parseIPv6('::ffff:1.2.3.4')?.slice(12)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(parseIPv6('1::2::3')).toBeNull();
    expect(parseIPv6('12345::')).toBeNull();
    expect(isBlockedAddress('not-an-ip')).toBe(true);
  });
});

describe('URL validation', () => {
  it('accepts normal public stream URLs', () => {
    expect(policy.validateUrl('https://stream.rcs.revma.com/gk9y379uquhvv').host).toBe(
      'stream.rcs.revma.com',
    );
    expect(policy.validateUrl('http://ice.example.org:8000/live.mp3').port).toBe('8000');
  });

  it.each([
    ['file:///etc/passwd', 'URL_SCHEME_NOT_ALLOWED'],
    ['ftp://example.com/a', 'URL_SCHEME_NOT_ALLOWED'],
    ['data:audio/mp3;base64,AAAA', 'URL_SCHEME_NOT_ALLOWED'],
    ['concat:http://a|http://b', 'URL_SCHEME_NOT_ALLOWED'],
    ['https://user:pass@example.com/s', 'URL_CREDENTIALS_NOT_ALLOWED'],
    ['http://localhost:8000/', 'URL_HOST_NOT_ALLOWED'],
    ['http://radio.localhost/', 'URL_HOST_NOT_ALLOWED'],
    ['http://metadata.google.internal/computeMetadata', 'URL_HOST_NOT_ALLOWED'],
    ['http://nas.local/stream', 'URL_HOST_NOT_ALLOWED'],
    ['http://intranet/stream', 'URL_HOST_NOT_ALLOWED'],
    ['http://127.0.0.1/', 'ADDRESS_BLOCKED'],
    ['http://2130706433/', 'ADDRESS_BLOCKED'],
    ['http://0x7f.1/', 'ADDRESS_BLOCKED'],
    ['http://017700000001/', 'ADDRESS_BLOCKED'],
    ['http://[::1]/', 'ADDRESS_BLOCKED'],
    ['http://[::ffff:127.0.0.1]/', 'ADDRESS_BLOCKED'],
    ['http://169.254.169.254/latest/meta-data/', 'ADDRESS_BLOCKED'],
    ['http://example.com:22/', 'URL_PORT_NOT_ALLOWED'],
    ['http://example.com:6379/', 'URL_PORT_NOT_ALLOWED'],
    ['http://example.com:25/', 'URL_PORT_NOT_ALLOWED'],
    [`https://example.com/${'a'.repeat(2100)}`, 'URL_TOO_LONG'],
  ])('rejects %s', (url, expected) => {
    expect(code(() => policy.validateUrl(url))).toBe(expected);
  });

  it('can refuse plain http when configured', () => {
    const strict = new UrlPolicy({ allowInsecureHttp: false });
    expect(code(() => strict.validateUrl('http://example.com/a'))).toBe('URL_SCHEME_NOT_ALLOWED');
    expect(code(() => strict.validateUrl('https://example.com/a'))).toBeNull();
  });
});

describe('SafeHttpClient connection pinning (DNS rebinding, redirects)', () => {
  let server: Server;
  let port: number;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/to-metadata') {
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
      } else if (req.url === '/to-private-name') {
        res.writeHead(302, { location: `http://internal-rebind.example.com:${port}/ok` }).end();
      } else if (req.url === '/ua') {
        res.writeHead(200).end(String(req.headers['user-agent']));
      } else if (req.url === '/loop') {
        res.writeHead(302, { location: '/loop' }).end();
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.close();
  });

  // The fixture server lives on 127.0.0.1, which the test policy allows explicitly. Every
  // other private address keeps the production rules.
  const testPolicy = new UrlPolicy({ allowInsecureHttp: true, testAllowedAddresses: ['127.0.0.1'] });
  const resolver = async (host: string) => {
    if (host === 'radio.example.com') return [{ address: '127.0.0.1', family: 4 }];
    if (host === 'internal-rebind.example.com') return [{ address: '10.0.0.5', family: 4 }];
    if (host === 'mixed.example.com')
      return [
        { address: '127.0.0.1', family: 4 },
        { address: '192.168.0.10', family: 4 },
      ];
    throw new Error('ENOTFOUND');
  };
  const client = () => new SafeHttpClient(testPolicy, resolver);

  it('fetches from an allowed address', async () => {
    const r = await client().fetchText(`http://radio.example.com:${port}/ok`);
    expect(r.text).toBe('ok');
  });

  it('blocks a hostname that resolves to a private address', async () => {
    await expect(client().request(`http://internal-rebind.example.com:${port}/ok`)).rejects.toMatchObject({
      code: 'ADDRESS_BLOCKED',
    });
  });

  it('blocks when any resolved address is private', async () => {
    await expect(client().request(`http://mixed.example.com:${port}/ok`)).rejects.toMatchObject({
      code: 'ADDRESS_BLOCKED',
    });
  });

  it('re-validates every redirect hop (metadata IP)', async () => {
    await expect(client().request(`http://radio.example.com:${port}/to-metadata`)).rejects.toMatchObject({
      code: 'ADDRESS_BLOCKED',
    });
  });

  it('re-resolves and blocks redirect targets that rebind to private space', async () => {
    await expect(client().request(`http://radio.example.com:${port}/to-private-name`)).rejects.toMatchObject({
      code: 'ADDRESS_BLOCKED',
    });
  });

  it('caps redirects', async () => {
    await expect(client().request(`http://radio.example.com:${port}/loop`)).rejects.toMatchObject({
      code: 'REDIRECT_LIMIT',
    });
  });

  it('refuses loopback with the production policy', async () => {
    const prod = new SafeHttpClient(policy);
    await expect(prod.request(`http://127.0.0.1:${port}/ok`)).rejects.toMatchObject({
      code: 'ADDRESS_BLOCKED',
    });
  });

  it('identifies as FFmpeg (libavformat) by default and can be overridden', async () => {
    expect((await client().fetchText(`http://radio.example.com:${port}/ua`)).text).toBe(DEFAULT_USER_AGENT);
    const custom = new SafeHttpClient(testPolicy, resolver, 'VLC/3.0.21 LibVLC/3.0.21');
    expect((await custom.fetchText(`http://radio.example.com:${port}/ua`)).text).toBe(
      'VLC/3.0.21 LibVLC/3.0.21',
    );
    expect(lavfUserAgent('libavutil      58. 29.100\nlibavformat    60. 16.100 / 60. 16.100')).toBe(
      'Lavf/60.16.100',
    );
    expect(lavfUserAgent('no version here')).toBeNull();
  });
});
