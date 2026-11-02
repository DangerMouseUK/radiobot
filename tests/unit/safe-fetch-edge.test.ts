import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { type AddressInfo, getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RadioError } from '../../src/shared/errors.ts';
import { headerString, readCapped, SafeHttpClient, statusError } from '../../src/streams/safe-fetch.ts';
import { UrlPolicy } from '../../src/streams/url-policy.ts';

/**
 * Edge cases of the SSRF-safe HTTP client, against a local server on 127.0.0.1 only. Host
 * names resolve through an injected resolver; nothing leaves the machine.
 */

let server: Server;
let port: number;
/** Requests the server has seen, by path. */
const seen: string[] = [];
/** Requests the server holds open without answering. */
const held: ServerResponse[] = [];
let onHeld: (() => void) | null = null;

function route(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/';
  seen.push(url);
  if (url === '/ok') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
  } else if (url === '/echo') {
    res
      .writeHead(200, { 'set-cookie': ['a=1', 'b=2'], 'content-type': 'application/json' })
      .end(JSON.stringify({ method: req.method, accept: req.headers.accept, extra: req.headers['x-extra'] }));
  } else if (url === '/redirect-relative') {
    res.writeHead(302, { location: '/ok' }).end();
  } else if (url === '/redirect-twice') {
    res.writeHead(301, { location: `http://second.example.com:${port}/redirect-relative` }).end();
  } else if (url === '/redirect-invalid') {
    res.writeHead(302, { location: 'http://[not-an-address/' }).end();
  } else if (url === '/redirect-ftp') {
    res.writeHead(302, { location: 'ftp://radio.example.com/stream' }).end();
  } else if (url === '/redirect-ssh-port') {
    res.writeHead(307, { location: 'http://radio.example.com:22/stream' }).end();
  } else if (url === '/redirect-credentials') {
    res.writeHead(302, { location: `http://user:pw@radio.example.com:${port}/ok` }).end();
  } else if (url === '/not-modified') {
    res.writeHead(304).end();
  } else if (url.startsWith('/status/')) {
    res.writeHead(Number(url.slice('/status/'.length))).end('nope');
  } else if (url === '/chunked-big') {
    res.writeHead(200);
    for (let i = 0; i < 10; i++) res.write(Buffer.alloc(100, 1));
    res.end();
  } else if (url === '/declared-big') {
    res.writeHead(200, { 'content-length': '5000' }).end(Buffer.alloc(5000, 2));
  } else if (url === '/bytes') {
    const body = Buffer.from([0, 1, 2, 3, 254, 255]);
    res.writeHead(200, { 'content-length': String(body.length) }).end(body);
  } else if (url === '/hang') {
    held.push(res);
    onHeld?.();
  } else {
    res.writeHead(404).end();
  }
}

beforeAll(async () => {
  server = createServer(route);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterEach(() => {
  vi.useRealTimers();
  for (const res of held.splice(0)) res.destroy();
  onHeld = null;
  seen.length = 0;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const testPolicy = new UrlPolicy({ allowInsecureHttp: true, testAllowedAddresses: ['127.0.0.1'] });
const resolver = async (host: string) => {
  if (host === 'radio.example.com' || host === 'second.example.com')
    return [{ address: '127.0.0.1', family: 4 }];
  if (host === 'empty.example.com') return [];
  if (host === 'v6-private.example.com') return [{ address: 'fd00::1', family: 6 }];
  if (host === 'mapped.example.com') return [{ address: '::ffff:192.168.1.1', family: 6 }];
  if (host === 'nat64.example.com') return [{ address: '64:ff9b::a00:1', family: 6 }];
  throw Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' });
};
const client = () => new SafeHttpClient(testPolicy, resolver);
const at = (path: string, host = 'radio.example.com') => `http://${host}:${port}${path}`;

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (err) {
    expect(err).toBeInstanceOf(RadioError);
    return (err as RadioError).code;
  }
}

describe('SafeHttpClient redirects', () => {
  it('follows relative and cross-host redirects, recording each hop', async () => {
    const r = await client().request(at('/redirect-twice'));
    expect(r.status).toBe(200);
    expect(r.finalUrl.href).toBe(at('/ok', 'second.example.com'));
    expect(r.redirects).toEqual([`second.example.com:${port}`, `second.example.com:${port}`]);
    expect(r.remoteAddress).toBe('127.0.0.1');
    r.response.resume();
    const text = await client().fetchText(at('/redirect-relative'));
    expect(text.text).toBe('ok');
    expect(text.finalUrl.pathname).toBe('/ok');
  });

  it('enforces maxRedirects exactly', async () => {
    expect(await codeOf(client().request(at('/redirect-relative'), { maxRedirects: 0 }))).toBe(
      'REDIRECT_LIMIT',
    );
    const one = await client().request(at('/redirect-relative'), { maxRedirects: 1 });
    expect(one.status).toBe(200);
    one.response.resume();
  });

  it('refuses redirects to invalid URLs, other schemes, denied ports and credentials', async () => {
    expect(await codeOf(client().request(at('/redirect-invalid')))).toBe('URL_INVALID');
    expect(await codeOf(client().request(at('/redirect-ftp')))).toBe('URL_SCHEME_NOT_ALLOWED');
    expect(await codeOf(client().request(at('/redirect-ssh-port')))).toBe('URL_PORT_NOT_ALLOWED');
    expect(await codeOf(client().request(at('/redirect-credentials')))).toBe('URL_CREDENTIALS_NOT_ALLOWED');
    // The refused targets were never requested.
    expect(seen).not.toContain('/stream');
    expect(seen.filter((p) => p === '/ok')).toEqual([]);
  });

  it('refuses plain http before connecting when the policy is https-only', async () => {
    const strict = new SafeHttpClient(new UrlPolicy({ allowInsecureHttp: false }), resolver);
    expect(await codeOf(strict.request(at('/ok')))).toBe('URL_SCHEME_NOT_ALLOWED');
    expect(seen).toEqual([]);
  });

  it('returns a 3xx without a Location header as a plain response', async () => {
    const r = await client().request(at('/not-modified'));
    expect(r.status).toBe(304);
    expect(r.redirects).toEqual([]);
    r.response.resume();
    expect(await codeOf(client().fetchText(at('/not-modified')))).toBe('HTTP_STATUS');
  });
});

describe('SafeHttpClient DNS pinning and blocked addresses', () => {
  it('fails a host with no addresses or a failed lookup as DNS_FAILED', async () => {
    const empty = client()
      .request(at('/ok', 'empty.example.com'))
      .catch((e: unknown) => e);
    const missing = client()
      .request(at('/ok', 'missing.example.com'))
      .catch((e: unknown) => e);
    expect(await empty).toMatchObject({ code: 'DNS_FAILED' });
    const err = (await missing) as RadioError;
    expect(err.code).toBe('DNS_FAILED');
    expect(seen).toEqual([]);
  });

  it.each([
    ['unique-local IPv6', 'v6-private.example.com'],
    ['IPv4-mapped private IPv6', 'mapped.example.com'],
    ['NAT64 of a private IPv4', 'nat64.example.com'],
  ])('blocks a name that resolves to %s', async (_label, host) => {
    expect(await codeOf(client().request(at('/ok', host)))).toBe('ADDRESS_BLOCKED');
    expect(seen).toEqual([]);
  });

  it('pins the address when Node asks the lookup for a single address', async () => {
    const before = getDefaultAutoSelectFamily();
    setDefaultAutoSelectFamily(false);
    try {
      expect((await client().fetchText(at('/ok'))).text).toBe('ok');
      expect(await codeOf(client().request(at('/ok', 'v6-private.example.com')))).toBe('ADDRESS_BLOCKED');
    } finally {
      setDefaultAutoSelectFamily(before);
    }
  });

  it('re-checks the connected peer even when no lookup ran (an IP literal)', async () => {
    // The URL check lets the literal through, but the peer check refuses it: the response is dropped.
    class PeerStrictPolicy extends UrlPolicy {
      peers: string[] = [];
      override assertAddressAllowed(address: string): void {
        this.peers.push(address);
        throw new RadioError('ADDRESS_BLOCKED', 'blocked peer');
      }
    }
    const policy = new PeerStrictPolicy({ allowInsecureHttp: true, testAllowedAddresses: ['127.0.0.1'] });
    const strict = new SafeHttpClient(policy, resolver);
    expect(await codeOf(strict.request(`http://127.0.0.1:${port}/ok`))).toBe('ADDRESS_BLOCKED');
    expect(policy.peers).toEqual(['127.0.0.1']);
  });
});

describe('SafeHttpClient failures and timeouts', () => {
  it('maps a refused connection and a failed TLS handshake to HTTP_ERROR', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const closedPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    expect(await codeOf(client().request(`http://radio.example.com:${closedPort}/ok`))).toBe('HTTP_ERROR');
    // https:// to a plain-HTTP server: the TLS handshake fails.
    expect(await codeOf(client().request(`https://radio.example.com:${port}/ok`))).toBe('HTTP_ERROR');
  });

  it('times out when response headers do not arrive', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const arrived = new Promise<void>((r) => {
      onHeld = r;
    });
    const p = client()
      .request(at('/hang'))
      .catch((e: unknown) => e);
    await arrived;
    vi.advanceTimersByTime(9_999);
    vi.advanceTimersByTime(1);
    expect(await p).toMatchObject({ code: 'HTTP_TIMEOUT' });
  });

  it('honours a custom headers timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const arrived = new Promise<void>((r) => {
      onHeld = r;
    });
    const p = client()
      .request(at('/hang'), { headersTimeoutMs: 250 })
      .catch((e: unknown) => e);
    await arrived;
    vi.advanceTimersByTime(250);
    expect(await p).toMatchObject({ code: 'HTTP_TIMEOUT' });
  });

  it('reports a cancelled request as CANCELLED and a timed-out signal as HTTP_TIMEOUT', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await codeOf(client().request(at('/ok'), { signal: cancelled.signal }))).toBe('CANCELLED');
    const timedOut = new AbortController();
    timedOut.abort(new DOMException('budget spent', 'TimeoutError'));
    expect(await codeOf(client().request(at('/ok'), { signal: timedOut.signal }))).toBe('HTTP_TIMEOUT');
  });

  it('cancels a request in flight when its signal aborts', async () => {
    const arrived = new Promise<void>((r) => {
      onHeld = r;
    });
    const controller = new AbortController();
    const p = client()
      .request(at('/hang'), { signal: controller.signal })
      .catch((e: unknown) => e);
    await arrived;
    controller.abort();
    expect(await p).toMatchObject({ code: 'CANCELLED' });
  });
});

describe('SafeHttpClient bodies and statuses', () => {
  it('sends the method and extra headers and reads repeated headers', async () => {
    const r = await client().fetchText(at('/echo'), { headers: { 'x-extra': 'yes' } });
    expect(JSON.parse(r.text)).toEqual({ method: 'GET', accept: '*/*', extra: 'yes' });
    expect(headerString(r.headers, 'Set-Cookie')).toBe('a=1');
    expect(headerString(r.headers, 'Content-Type')).toBe('application/json');
    expect(headerString(r.headers, 'x-missing')).toBeNull();
    expect(headerString({ 'set-cookie': [] }, 'set-cookie')).toBeNull();
    const head = await client().request(at('/echo'), { method: 'HEAD' });
    expect(head.status).toBe(200);
    head.response.resume();
  });

  it('caps text bodies', async () => {
    expect((await client().fetchText(at('/chunked-big'), { maxBytes: 1000 })).text).toHaveLength(1000);
    expect(await codeOf(client().fetchText(at('/chunked-big'), { maxBytes: 999 }))).toBe('BODY_TOO_LARGE');
  });

  it('caps byte bodies by the declared length and by what arrives', async () => {
    const ok = await client().fetchBytes(at('/bytes'), { maxBytes: 6 });
    expect([...ok.bytes]).toEqual([0, 1, 2, 3, 254, 255]);
    expect(ok.finalUrl.pathname).toBe('/bytes');
    expect(await codeOf(client().fetchBytes(at('/declared-big'), { maxBytes: 4999 }))).toBe('BODY_TOO_LARGE');
    expect(await codeOf(client().fetchBytes(at('/chunked-big'), { maxBytes: 500 }))).toBe('BODY_TOO_LARGE');
    expect(await codeOf(client().fetchBytes(at('/redirect-relative'), { maxBytes: 1 }))).toBe(
      'BODY_TOO_LARGE',
    );
  });

  it.each([
    [401, 'ACCESS_DENIED'],
    [403, 'ACCESS_DENIED'],
    [451, 'ACCESS_DENIED'],
    [404, 'NOT_FOUND'],
    [410, 'NOT_FOUND'],
    [500, 'HTTP_STATUS'],
    [503, 'HTTP_STATUS'],
  ])('maps HTTP %i to %s for text and bytes alike', async (status, expected) => {
    expect(await codeOf(client().fetchText(at(`/status/${status}`)))).toBe(expected);
    expect(await codeOf(client().fetchBytes(at(`/status/${status}`), { maxBytes: 100 }))).toBe(expected);
  });

  it('says plainly that access restrictions are not bypassed', () => {
    expect(statusError(403).message).toMatch(/HTTP 403\)\. Radio Bot does not bypass access restrictions/);
    expect(statusError(410).message).toMatch(/HTTP 410/);
    expect(statusError(502).message).toContain('The stream server returned an error (HTTP 502).');
  });
});

describe('readCapped', () => {
  const stream = () => new PassThrough() as unknown as IncomingMessage & PassThrough;

  it('collects the whole body', async () => {
    const s = stream();
    const p = readCapped(s, 10, 1_000);
    s.write(Buffer.from('abc'));
    s.end(Buffer.from('def'));
    expect((await p).toString()).toBe('abcdef');
  });

  it('stops and destroys the stream once the cap is passed', async () => {
    const s = stream();
    const p = readCapped(s, 4, 1_000);
    s.write(Buffer.from('abc'));
    s.write(Buffer.from('de'));
    await expect(p).rejects.toMatchObject({ code: 'BODY_TOO_LARGE' });
    expect(s.destroyed).toBe(true);
  });

  it('times out a body that is too slow', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const s = stream();
    const p = readCapped(s, 100, 5_000);
    s.write(Buffer.from('a'));
    vi.advanceTimersByTime(5_000);
    await expect(p).rejects.toMatchObject({ code: 'HTTP_TIMEOUT' });
    expect(s.destroyed).toBe(true);
  });

  it('reports a connection that fails mid-body', async () => {
    const s = stream();
    const p = readCapped(s, 100, 5_000);
    s.write(Buffer.from('a'));
    s.destroy(new Error('socket hang up'));
    const err = (await p.catch((e: unknown) => e)) as RadioError;
    expect(err.code).toBe('HTTP_ERROR');
    expect((err.cause as Error).message).toBe('socket hang up');
  });
});
