import { isIP } from 'node:net';
import { RadioError } from '../shared/errors.ts';

export const MAX_URL_LENGTH = 2048;
export const MAX_HOSTNAME_LENGTH = 253;

/** Ports of common internal services that a radio stream never legitimately uses. */
const DENIED_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104,
  109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515,
  526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049,
  2375, 2376, 2379, 2380, 3306, 3389, 4369, 5060, 5061, 5432, 5672, 5900, 5984, 6000, 6379, 6443, 6566, 6665,
  6666, 6667, 6668, 6669, 6697, 8086, 8500, 9042, 9092, 9100, 9200, 9300, 10250, 10255, 11211, 15672, 25565,
  27017, 27018, 50070,
]);

const BLOCKED_HOST_SUFFIXES = [
  '.localhost',
  '.local',
  '.localdomain',
  '.internal',
  '.intranet',
  '.lan',
  '.home',
  '.home.arpa',
  '.corp',
  '.private',
  '.arpa',
];
const BLOCKED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata',
  'metadata.google.internal',
  'instance-data',
]);

export interface UrlPolicyOptions {
  allowInsecureHttp: boolean;
  /**
   * Test-only: exact IP addresses (e.g. 127.0.0.1) that integration tests may reach.
   * Every other address still follows the full policy. Never wired to configuration.
   */
  testAllowedAddresses?: readonly string[];
}

export class UrlPolicy {
  readonly allowInsecureHttp: boolean;
  readonly #testAllowed: ReadonlySet<string>;

  constructor(opts: UrlPolicyOptions) {
    this.allowInsecureHttp = opts.allowInsecureHttp;
    this.#testAllowed = new Set(opts.testAllowedAddresses ?? []);
  }

  /** Syntactic validation of a URL before any network activity (PRD §7.3 step 1, §10.2). */
  validateUrl(raw: string | URL): URL {
    const text = typeof raw === 'string' ? raw.trim() : raw.href;
    if (text.length > MAX_URL_LENGTH) throw new RadioError('URL_TOO_LONG', 'That URL is too long.');
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      throw new RadioError('URL_INVALID', 'That is not a valid URL.');
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new RadioError('URL_SCHEME_NOT_ALLOWED', 'Only http:// and https:// stream URLs are supported.');
    }
    if (url.protocol === 'http:' && !this.allowInsecureHttp) {
      throw new RadioError('URL_SCHEME_NOT_ALLOWED', 'This installation only accepts https:// stream URLs.');
    }
    if (url.username || url.password) {
      throw new RadioError(
        'URL_CREDENTIALS_NOT_ALLOWED',
        'Stream URLs with a username or password in them are not accepted: streams that need a login are not supported.',
      );
    }
    const host = stripBrackets(url.hostname).toLowerCase();
    if (!host || host.length > MAX_HOSTNAME_LENGTH) {
      throw new RadioError('URL_HOST_NOT_ALLOWED', 'That host name is not allowed.');
    }
    const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
    if (DENIED_PORTS.has(port) || (port < 1024 && port !== 80 && port !== 443)) {
      throw new RadioError('URL_PORT_NOT_ALLOWED', `Port ${port} is not allowed for radio streams.`);
    }
    const ipVersion = isIP(host);
    if (ipVersion !== 0) {
      if (isBlockedAddress(host) && !this.#testAllowed.has(host)) {
        throw new RadioError(
          'ADDRESS_BLOCKED',
          'That address is private or reserved (a home network address, for example), so the bot won’t connect to it.',
        );
      }
      return url;
    }
    if (
      BLOCKED_HOSTS.has(host) ||
      BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix)) ||
      !host.includes('.') ||
      host.endsWith('.')
    ) {
      throw new RadioError(
        'URL_HOST_NOT_ALLOWED',
        'That host name is internal or cannot be looked up on the public internet.',
      );
    }
    if (
      !/^[a-z0-9.-]+$/.test(host) ||
      host.split('.').some((label) => label.length === 0 || label.length > 63)
    ) {
      throw new RadioError('URL_HOST_NOT_ALLOWED', 'That host name is not allowed.');
    }
    return url;
  }

  /** Checks a resolved address. Called for every connection, including redirects and reconnects. */
  assertAddressAllowed(address: string): void {
    if (this.#testAllowed.has(stripBrackets(address).replace(/^::ffff:/, ''))) return;
    if (isBlockedAddress(address)) {
      throw new RadioError(
        'ADDRESS_BLOCKED',
        'That stream’s address is private or reserved (a home network address, for example), so the bot won’t connect to it.',
      );
    }
  }
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

// ---------------------------------------------------------------- address classification

type Cidr4 = [number, number];
const BLOCKED_V4: Cidr4[] = (
  [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.31.196.0', 24],
    ['192.52.193.0', 24],
    ['192.88.99.0', 24],
    ['192.168.0.0', 16],
    ['192.175.48.0', 24],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ] as Array<[string, number]>
).map(([ip, bits]) => [ipv4ToInt(ip)!, bits]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n >>> 0;
}

function inCidr4(ip: number, [net, bits]: Cidr4): boolean {
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : ~((1 << (32 - bits)) - 1) >>> 0;
  return (ip & mask) >>> 0 === (net & mask) >>> 0;
}

export function isBlockedIPv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  return BLOCKED_V4.some((c) => inCidr4(n, c));
}

/** Expands an IPv6 literal into 16 bytes; returns null if malformed. Handles embedded dotted IPv4. */
export function parseIPv6(input: string): Uint8Array | null {
  let ip = stripBrackets(input);
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  let tailV4: number[] | null = null;
  const lastColon = ip.lastIndexOf(':');
  if (ip.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4ToInt(ip.slice(lastColon + 1));
    if (v4 === null) return null;
    tailV4 = [(v4 >>> 24) & 255, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255];
    ip = `${ip.slice(0, lastColon + 1)}0:0`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const g = groups[i]!;
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null;
    const v = Number.parseInt(g, 16);
    bytes[i * 2] = v >> 8;
    bytes[i * 2 + 1] = v & 255;
  }
  if (tailV4) bytes.set(tailV4, 12);
  return bytes;
}

function prefixMatch(bytes: Uint8Array, prefix: number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3;
    const bit = 7 - (i & 7);
    const want = ((prefix[byte] ?? 0) >> bit) & 1;
    const have = ((bytes[byte] ?? 0) >> bit) & 1;
    if (want !== have) return false;
  }
  return true;
}

const v4FromBytes = (b: Uint8Array, offset: number) =>
  `${b[offset]}.${b[offset + 1]}.${b[offset + 2]}.${b[offset + 3]}`;

export function isBlockedIPv6(ip: string): boolean {
  const b = parseIPv6(ip);
  if (!b) return true;
  // IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::/96), IPv4-translated (::ffff:0:0:0/96): judge the embedded IPv4.
  if (prefixMatch(b, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96))
    return isBlockedIPv4(v4FromBytes(b, 12));
  if (prefixMatch(b, [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0], 96))
    return isBlockedIPv4(v4FromBytes(b, 12));
  if (prefixMatch(b, [], 96)) return true; // ::, ::1 and deprecated IPv4-compatible space
  // NAT64 well-known prefix embeds IPv4; local-use NAT64 is internal.
  if (prefixMatch(b, [0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96))
    return isBlockedIPv4(v4FromBytes(b, 12));
  if (prefixMatch(b, [0x00, 0x64, 0xff, 0x9b, 0x00, 0x01], 48)) return true;
  // 6to4 embeds IPv4 in bits 16..47.
  if (prefixMatch(b, [0x20, 0x02], 16)) return isBlockedIPv4(v4FromBytes(b, 2));
  const blocked: Array<[number[], number]> = [
    [[0x01, 0x00, 0, 0, 0, 0, 0, 0], 64], // discard-only
    [[0x20, 0x01, 0x00, 0x00], 23], // IETF protocol assignments incl. Teredo (2001::/32)
    [[0x20, 0x01, 0x0d, 0xb8], 32], // documentation
    [[0x3f, 0xff], 20], // documentation (RFC 9637)
    [[0x5f, 0x00], 16], // SRv6 SIDs
    [[0xfc], 7], // unique local
    [[0xfe, 0x80], 10], // link-local
    [[0xfe, 0xc0], 10], // site-local (deprecated)
    [[0xff], 8], // multicast
  ];
  if (blocked.some(([p, bits]) => prefixMatch(b, p, bits))) return true;
  // Only global unicast (2000::/3) is reachable on the public internet.
  return !prefixMatch(b, [0x20], 3);
}

export function isBlockedAddress(address: string): boolean {
  const host = stripBrackets(address);
  const v = isIP(host);
  if (v === 4) return isBlockedIPv4(host);
  if (v === 6) return isBlockedIPv6(host);
  return true;
}
