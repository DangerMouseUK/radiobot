import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';
import { RadioError } from '../shared/errors.ts';
import type { UrlPolicy } from './url-policy.ts';

/**
 * Stream requests identify as FFmpeg's network library (libavformat), because FFmpeg is what
 * decodes the audio. Many stream hosts serve standard media players (FFmpeg, VLC) and refuse
 * unknown clients. At start-up the app replaces this with the exact libavformat version of the
 * installed FFmpeg; operators can override it with STREAM_USER_AGENT.
 */
export const DEFAULT_USER_AGENT = 'Lavf/61.7.100';

/** Builds FFmpeg's own User-Agent string from `ffmpeg -version` output, e.g. "Lavf/60.16.100". */
export function lavfUserAgent(versionOutput: string): string | null {
  const m = /libavformat\s+(\d+)\.\s*(\d+)\.\s*(\d+)/.exec(versionOutput);
  return m ? `Lavf/${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}
const MAX_HEADER_BYTES = 16 * 1024;

export interface SafeRequestOptions {
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  /** Time allowed until response headers arrive, per hop. */
  headersTimeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export interface SafeResponse {
  response: IncomingMessage;
  finalUrl: URL;
  redirects: string[];
  remoteAddress: string | null;
  status: number;
  headers: IncomingHttpHeaders;
}

type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const defaultResolver: Resolver = (hostname) =>
  new Promise((resolve, reject) => {
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) reject(err);
      else resolve(addresses);
    });
  });

/**
 * HTTP client that enforces the URL policy on every hop: validates the URL, resolves DNS
 * itself, rejects the hop if *any* resolved address is private/reserved, and pins the
 * socket to the validated address (no second resolution, so DNS rebinding cannot swap
 * the target between check and connect). Redirects are followed manually and re-validated.
 */
export class SafeHttpClient {
  readonly policy: UrlPolicy;
  readonly #resolve: Resolver;
  /** User-Agent sent on every request (stream, playlist, segment, redirect hop). */
  userAgent: string;

  constructor(
    policy: UrlPolicy,
    resolver: Resolver = defaultResolver,
    userAgent: string = DEFAULT_USER_AGENT,
  ) {
    this.policy = policy;
    this.#resolve = resolver;
    this.userAgent = userAgent;
  }

  /** Builds a socket lookup function that only ever returns policy-approved addresses. */
  #pinnedLookup(): LookupFunction {
    return ((hostname: string, options: unknown, callback: (...args: unknown[]) => void) => {
      const wantAll =
        typeof options === 'object' && options !== null && (options as { all?: boolean }).all === true;
      this.#resolve(hostname)
        .then((addresses) => {
          if (addresses.length === 0) throw new RadioError('DNS_FAILED', 'The stream host did not resolve.');
          for (const a of addresses) this.policy.assertAddressAllowed(a.address);
          if (wantAll) callback(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        })
        .catch((err: unknown) => {
          callback(
            err instanceof RadioError
              ? err
              : new RadioError('DNS_FAILED', 'The stream host could not be resolved.', { cause: err }),
          );
        });
    }) as LookupFunction;
  }

  async request(rawUrl: string | URL, opts: SafeRequestOptions = {}): Promise<SafeResponse> {
    const maxRedirects = opts.maxRedirects ?? 5;
    const redirects: string[] = [];
    let url = this.policy.validateUrl(rawUrl);
    for (let hop = 0; ; hop++) {
      const res = await this.#once(url, opts);
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        res.destroy();
        if (hop >= maxRedirects)
          throw new RadioError('REDIRECT_LIMIT', 'The stream redirected too many times.');
        let next: URL;
        try {
          next = new URL(location, url);
        } catch {
          throw new RadioError('URL_INVALID', 'The stream redirected to an invalid URL.');
        }
        url = this.policy.validateUrl(next);
        redirects.push(url.host);
        continue;
      }
      return {
        response: res,
        finalUrl: url,
        redirects,
        remoteAddress: res.socket?.remoteAddress ?? null,
        status,
        headers: res.headers,
      };
    }
  }

  #once(url: URL, opts: SafeRequestOptions): Promise<IncomingMessage> {
    const mod = url.protocol === 'https:' ? https : http;
    const timeoutMs = opts.headersTimeoutMs ?? 10_000;
    return new Promise((resolve, reject) => {
      let settled = false;
      const req = mod.request(url, {
        method: opts.method ?? 'GET',
        headers: { 'user-agent': this.userAgent, accept: '*/*', ...opts.headers },
        lookup: this.#pinnedLookup(),
        agent: false,
        maxHeaderSize: MAX_HEADER_BYTES,
        signal: opts.signal,
      });
      const timer = setTimeout(() => {
        fail(new RadioError('HTTP_TIMEOUT', 'The stream server did not respond in time.'));
        req.destroy();
      }, timeoutMs);
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err instanceof RadioError) reject(err);
        else if (opts.signal?.aborted) {
          // A timeout signal (e.g. a probe's time budget) is a timeout, not a cancellation.
          const timedOut = (opts.signal.reason as { name?: string } | undefined)?.name === 'TimeoutError';
          reject(
            timedOut
              ? new RadioError('HTTP_TIMEOUT', 'The stream server did not respond in time.', { cause: err })
              : new RadioError('CANCELLED', 'Request cancelled.', { cause: err }),
          );
        } else if ((err as { cause?: unknown })?.cause instanceof RadioError)
          reject((err as { cause: RadioError }).cause);
        else reject(new RadioError('HTTP_ERROR', 'Could not connect to the stream server.', { cause: err }));
      };
      req.on('response', (res) => {
        if (settled) {
          res.destroy();
          return;
        }
        settled = true;
        clearTimeout(timer);
        // Re-check the connected peer: belt and braces against any lookup bypass.
        const peer = res.socket?.remoteAddress;
        if (peer) {
          try {
            this.policy.assertAddressAllowed(peer);
          } catch (err) {
            res.destroy();
            reject(err);
            return;
          }
        }
        resolve(res);
      });
      req.on('error', fail);
      req.end();
    });
  }

  /** GET with a hard cap on body size, for playlists/manifests/pages. */
  async fetchText(
    rawUrl: string | URL,
    opts: SafeRequestOptions & { maxBytes?: number; totalTimeoutMs?: number } = {},
  ): Promise<{ text: string; finalUrl: URL; status: number; headers: IncomingHttpHeaders }> {
    const res = await this.request(rawUrl, opts);
    if (res.status < 200 || res.status >= 300) {
      res.response.destroy();
      throw statusError(res.status);
    }
    const buf = await readCapped(res.response, opts.maxBytes ?? 512 * 1024, opts.totalTimeoutMs ?? 15_000);
    return { text: buf.toString('utf8'), finalUrl: res.finalUrl, status: res.status, headers: res.headers };
  }

  /** GET returning bytes, capped. Used for HLS segments and imports. */
  async fetchBytes(
    rawUrl: string | URL,
    opts: SafeRequestOptions & { maxBytes: number; totalTimeoutMs?: number },
  ): Promise<{ bytes: Buffer; finalUrl: URL; headers: IncomingHttpHeaders }> {
    const res = await this.request(rawUrl, opts);
    if (res.status < 200 || res.status >= 300) {
      res.response.destroy();
      throw statusError(res.status);
    }
    const declared = Number(res.headers['content-length'] ?? '0');
    if (declared > opts.maxBytes) {
      res.response.destroy();
      throw new RadioError('BODY_TOO_LARGE', 'The response is too large.');
    }
    const bytes = await readCapped(res.response, opts.maxBytes, opts.totalTimeoutMs ?? 20_000);
    return { bytes, finalUrl: res.finalUrl, headers: res.headers };
  }
}

export function readCapped(stream: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new RadioError('HTTP_TIMEOUT', 'The server was too slow to send the response.'));
    }, timeoutMs);
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        clearTimeout(timer);
        stream.destroy();
        reject(new RadioError('BODY_TOO_LARGE', 'The response is larger than allowed.'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', (err) => {
      clearTimeout(timer);
      reject(
        new RadioError('HTTP_ERROR', 'The connection failed while reading the response.', { cause: err }),
      );
    });
  });
}

/** Error for a non-2xx answer: hosts that refuse access (401, 403, 451) are ACCESS_DENIED. */
export function statusError(status: number): RadioError {
  if (status === 401 || status === 403 || status === 451) {
    return new RadioError(
      'ACCESS_DENIED',
      `The stream host refused access (HTTP ${status}). Radio Bot does not bypass access restrictions.`,
    );
  }
  return new RadioError('HTTP_STATUS', `The stream server answered HTTP ${status}.`);
}

export function headerString(headers: IncomingHttpHeaders, name: string): string | null {
  const v = headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === 'string' ? v : null;
}
