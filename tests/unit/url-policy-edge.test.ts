import { describe, expect, it } from 'vitest';
import {
  isBlockedAddress,
  isBlockedIPv4,
  isBlockedIPv6,
  parseIPv6,
  UrlPolicy,
} from '../../src/streams/url-policy.ts';

const policy = new UrlPolicy({ allowInsecureHttp: true });
const code = (fn: () => unknown) => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown';
  }
};

describe('URL validation edge cases', () => {
  it('rejects text that is not a URL at all', () => {
    expect(code(() => policy.validateUrl('http://'))).toBe('URL_INVALID');
    expect(code(() => policy.validateUrl('not a url'))).toBe('URL_INVALID');
  });

  it('rejects over-long host names and over-long labels', () => {
    const label = 'a'.repeat(63);
    const longHost = `${label}.${label}.${label}.${label}.example.com`;
    expect(longHost.length).toBeGreaterThan(253);
    expect(code(() => policy.validateUrl(`https://${longHost}/`))).toBe('URL_HOST_NOT_ALLOWED');
    expect(code(() => policy.validateUrl(`https://${'b'.repeat(64)}.example.com/`))).toBe(
      'URL_HOST_NOT_ALLOWED',
    );
    expect(code(() => policy.validateUrl(`https://${label}.example.com/`))).toBeNull();
  });

  it('rejects host names with characters a public DNS name cannot have', () => {
    expect(code(() => policy.validateUrl('https://my_station.example.com/'))).toBe('URL_HOST_NOT_ALLOWED');
    expect(code(() => policy.validateUrl('https://radio..example.com/'))).toBe('URL_HOST_NOT_ALLOWED');
  });

  it('accepts a public IPv6 literal and blocks a private one', () => {
    expect(policy.validateUrl('https://[2606:4700::1111]/live').hostname).toBe('[2606:4700::1111]');
    expect(code(() => policy.validateUrl('https://[fd12::1]/live'))).toBe('ADDRESS_BLOCKED');
  });

  it('lets a test-allowed address through in brackets and as an IPv4-mapped peer only', () => {
    const p = new UrlPolicy({ allowInsecureHttp: true, testAllowedAddresses: ['127.0.0.1', '::1'] });
    expect(code(() => p.assertAddressAllowed('::ffff:127.0.0.1'))).toBeNull();
    expect(code(() => p.assertAddressAllowed('[::1]'))).toBeNull();
    expect(code(() => p.assertAddressAllowed('127.0.0.2'))).toBe('ADDRESS_BLOCKED');
    expect(code(() => policy.assertAddressAllowed('::ffff:127.0.0.1'))).toBe('ADDRESS_BLOCKED');
    expect(code(() => policy.assertAddressAllowed('203.0.114.1'))).toBeNull();
  });
});

describe('address classification edge cases', () => {
  it('treats malformed IPv4 as blocked', () => {
    expect(isBlockedIPv4('1.2.3')).toBe(true);
    expect(isBlockedIPv4('1.2.3.x')).toBe(true);
    expect(isBlockedIPv4('1.2.3.256')).toBe(true);
    expect(isBlockedIPv4('8.8.8.8')).toBe(false);
  });

  it('parses IPv6 with zones and embedded IPv4, and refuses malformed forms', () => {
    expect(parseIPv6('fe80::1%eth0')?.[0]).toBe(0xfe);
    expect([...parseIPv6('::ffff:10.0.0.1')!.subarray(12)]).toEqual([10, 0, 0, 1]);
    expect(parseIPv6('::ffff:10.0.0.999')).toBeNull();
    expect(parseIPv6('1:2:3')).toBeNull();
    expect(parseIPv6('1::2::3')).toBeNull();
    expect(parseIPv6('1:2:3:4:5:6:7::8')).toBeNull();
    expect(parseIPv6('gggg::1')).toBeNull();
    expect(parseIPv6('[2001:db8::1]')?.[1]).toBe(0x01);
  });

  it.each([
    ['::ffff:0:10.0.0.1', true], // IPv4-translated, private
    ['::ffff:0:8.8.8.8', false], // IPv4-translated, public
    ['64:ff9b:1::1', true], // local-use NAT64
    ['64:ff9b::808:808', false], // NAT64 of a public address
    ['2002:0a00:0001::1', true], // 6to4 of a private address
    ['2002:0808:0808::1', false], // 6to4 of a public address
    ['3fff::1', true], // documentation
    ['5f00::1', true], // SRv6
    ['fec0::1', true], // site-local
    ['ff02::1', true], // multicast
    ['100::1', true], // discard-only
    ['4000::1', true], // outside global unicast
    ['fe80::1%eth0', true],
    ['not-an-ip', true],
  ])('%s blocked: %s', (ip, blocked) => {
    expect(isBlockedIPv6(ip)).toBe(blocked);
  });

  it('blocks anything that is not an IP address', () => {
    expect(isBlockedAddress('radio.example.org')).toBe(true);
    expect(isBlockedAddress('[2606:4700::1111]')).toBe(false);
    expect(isBlockedAddress('93.184.216.34')).toBe(false);
  });
});
