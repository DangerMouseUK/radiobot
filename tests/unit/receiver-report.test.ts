import { createCipheriv, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Networking } from '@discordjs/voice';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { receiverReportLine } from '../../src/discord/ui/format.ts';
import {
  expectedPackets,
  isReceiverReport,
  MAX_REPORT_VIEWERS,
  openReceiverReport,
  parseReceiverReport,
  REPORT_SLOT_BYTES,
  REPORT_WATCH_MS,
  ReceiverReportTap,
  ReportWatch,
  summarise,
} from '../../src/voice/receiver-report.ts';

const AES = 'aead_aes256_gcm_rtpsize';
const XCHACHA = 'aead_xchacha20_poly1305_rtpsize';
const SSRC = 0x1234_5678;

/** A report block (RFC 3550 §6.4.1). `lost` is the 24-bit signed cumulative count. */
function block(
  o: { ssrc?: number; fraction?: number; lost?: number; highest?: number; jitter?: number } = {},
) {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(o.ssrc ?? SSRC, 0);
  b[4] = o.fraction ?? 0;
  b.writeUIntBE((o.lost ?? 0) & 0xffffff, 5, 3);
  b.writeUInt32BE(o.highest ?? 0, 8);
  b.writeUInt32BE(o.jitter ?? 0, 12);
  return b;
}

/** The clear part of a Receiver Report: `81 c9 00 07` (one block, 32 bytes) and the reporter's SSRC. */
function header(count = 1, words = 7): Buffer {
  const h = Buffer.alloc(8);
  h[0] = 0x80 | count;
  h[1] = 201;
  h.writeUInt16BE(words, 2);
  h.writeUInt32BE(SSRC, 4);
  return h;
}

/**
 * Seals a report the way the voice library seals outgoing audio (its own `encryptOpusPacket`):
 * the clear bytes as additional data, the 4-byte nonce counter appended. Discord's reports are
 * 76 bytes: 8 clear, 48 encrypted (the report block and 24 more bytes of a compound packet), a
 * 16-byte tag and the nonce.
 */
async function libraryReport(mode: string, key: Uint8Array, clear: Buffer, body: Buffer, nonce = 7) {
  const connectionData = {
    secretKey: key,
    encryptionMode: mode,
    nonce: nonce - 1,
    nonceBuffer: Buffer.alloc(mode === AES ? 12 : 24),
  };
  // Private in its types, but it is the very code that seals every packet the bot sends.
  const encrypt = (Networking.prototype as unknown as Record<string, unknown>).encryptOpusPacket as (
    this: unknown,
    packet: Buffer,
    data: typeof connectionData,
    aad: Buffer,
    dave: undefined,
  ) => Buffer[];
  // The library loads its XChaCha20 module in the background when it is imported.
  for (let i = 0; ; i++) {
    try {
      const [sealed, suffix] = encrypt.call({}, body, connectionData, clear, undefined);
      return Buffer.concat([clear, sealed!, suffix!]);
    } catch (err) {
      if (i > 100) throw err;
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

const compound = (b: Buffer) => Buffer.concat([b, Buffer.alloc(24, 0xee)]);

describe('Discord receiver reports: decrypting and parsing', () => {
  for (const mode of [AES, XCHACHA]) {
    it(`reads a report sealed by the voice library's own code (${mode})`, async () => {
      const key = randomBytes(32);
      const body = compound(block({ fraction: 64, lost: 9, highest: 0x0001_0010, jitter: 96 }));
      const packet = await libraryReport(mode, key, header(), body);
      expect(packet.length).toBe(76);
      expect(packet.subarray(0, 4).toString('hex')).toBe('81c90007');
      expect(isReceiverReport(packet)).toBe(true);
      expect(await openReceiverReport(packet, mode, key, SSRC)).toEqual({
        ssrc: SSRC,
        fractionLost: 0.25,
        cumulativeLost: 9,
        highestSequence: 0x0001_0010,
        jitter: 96,
      });
    });

    it(`refuses a report it cannot authenticate (${mode})`, async () => {
      const key = randomBytes(32);
      const packet = await libraryReport(mode, key, header(), compound(block({ lost: 3 })));
      expect(await openReceiverReport(packet, mode, randomBytes(32))).toBeNull();
      const tampered = Buffer.from(packet);
      tampered[12]! ^= 1;
      expect(await openReceiverReport(tampered, mode, key)).toBeNull();
      // The clear header is authenticated too.
      const relabelled = Buffer.from(packet);
      relabelled[7]! ^= 1;
      expect(await openReceiverReport(relabelled, mode, key)).toBeNull();
    });
  }

  it('also reads a report whose first 12 bytes are the clear part, and refuses an unknown mode', async () => {
    const key = randomBytes(32);
    const plain = Buffer.concat([header(), compound(block({ lost: 5 }))]);
    const nonce = Buffer.alloc(12);
    nonce.writeUInt32BE(3, 0);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(plain.subarray(0, 12));
    const sealed = Buffer.concat([cipher.update(plain.subarray(12)), cipher.final(), cipher.getAuthTag()]);
    const packet = Buffer.concat([plain.subarray(0, 12), sealed, nonce.subarray(0, 4)]);
    expect((await openReceiverReport(packet, AES, key))?.cumulativeLost).toBe(5);
    expect(await openReceiverReport(packet, 'xsalsa20_poly1305', key)).toBeNull();
    expect(await openReceiverReport(packet.subarray(0, 40), AES, key)).toBeNull();
  });

  it('decrypts XChaCha20-Poly1305 with a 24-byte nonce carrying the counter first, as the library does', async () => {
    const key = randomBytes(32);
    const clear = header();
    const nonce = Buffer.alloc(24);
    nonce.writeUInt32BE(0xdeadbeef, 0);
    const sealed = xchacha20poly1305(key, nonce, clear).encrypt(compound(block({ lost: 77 })));
    const packet = Buffer.concat([clear, sealed, nonce.subarray(0, 4)]);
    expect((await openReceiverReport(packet, XCHACHA, key))?.cumulativeLost).toBe(77);
  });

  it('parses negative losses, picks the block about our stream, and stays within the packet', () => {
    const negative = parseReceiverReport(Buffer.concat([header(), block({ lost: -2 })]));
    expect(negative?.cumulativeLost).toBe(-2);
    const two = Buffer.concat([header(2, 13), block({ ssrc: 1, lost: 1 }), block({ lost: 2 })]);
    expect(parseReceiverReport(two, SSRC)?.cumulativeLost).toBe(2);
    expect(parseReceiverReport(two, 999)?.cumulativeLost).toBe(1);
    // The header claims two blocks, but its length covers one: the second belongs to the next packet.
    expect(parseReceiverReport(Buffer.concat([header(2, 7), block({ ssrc: 1 }), block()]), SSRC)?.ssrc).toBe(
      1,
    );
    expect(parseReceiverReport(Buffer.concat([header(0, 1)]))).toBeNull();
    expect(parseReceiverReport(Buffer.alloc(40))).toBeNull();
  });

  it('keeps only datagrams that look like a Receiver Report', () => {
    const report = Buffer.alloc(76);
    report[0] = 0x81;
    report[1] = 201;
    expect(isReceiverReport(report)).toBe(true);
    // An RTP audio packet (payload type 120), a keep-alive reply, a sender report, a version 1 packet.
    expect(isReceiverReport(Buffer.from([0x80, 0x78, ...Buffer.alloc(74)]))).toBe(false);
    expect(isReceiverReport(Buffer.alloc(8))).toBe(false);
    expect(isReceiverReport(Buffer.from([0x81, 200, ...Buffer.alloc(74)]))).toBe(false);
    expect(isReceiverReport(Buffer.from([0x41, 201, ...Buffer.alloc(74)]))).toBe(false);
    const big = Buffer.alloc(REPORT_SLOT_BYTES + 1);
    big[0] = 0x81;
    big[1] = 201;
    expect(isReceiverReport(big)).toBe(false);
  });

  it('counts the packets Discord expected from sequence numbers, across a wrap', () => {
    // 1000 packets sent from sequence 65000: the next is 464 (wrapped). Discord's highest: one wrap, 463.
    expect(expectedPackets(0x0001_0000 + 463, 464, 1000)).toBe(1000);
    // A report a second old: Discord had seen 100 of them by then.
    expect(expectedPackets(65000 + 99, 464, 1000)).toBe(100);
    // A report that doesn't fit what was sent (from before a reset) gives no share.
    expect(expectedPackets(5, 100, 50)).toBeNull();
    expect(expectedPackets(10, 0, 0)).toBeNull();
    const summary = summarise(
      { ssrc: SSRC, fractionLost: 0, cumulativeLost: 4, highestSequence: 199, jitter: 240 },
      1500,
      { next: 300, sent: 300 },
    );
    expect(summary).toEqual({ lost: 4, expected: 200, fractionLost: 0, jitterMs: 5, ageMs: 1500 });
  });
});

describe('Discord receiver reports: the one-slot tap', () => {
  const report = (lost: number) => {
    const b = Buffer.concat([header(), block({ lost }), Buffer.alloc(44)]);
    return b;
  };

  it('attaches one listener on arm, keeps only the latest report, and removes it all on close', () => {
    const socket = new EventEmitter();
    let now = 1_000;
    const tap = new ReceiverReportTap(socket, () => now);
    expect(socket.listenerCount('message')).toBe(1);
    expect(tap.latest()).toBeNull();
    socket.emit('message', report(1));
    now = 1_400;
    socket.emit('message', Buffer.alloc(8)); // a keep-alive reply: not kept
    socket.emit('message', Buffer.from([0x80, 0x78, ...Buffer.alloc(74)])); // RTP: not kept
    let latest = tap.latest()!;
    expect(latest.ageMs).toBe(400);
    expect(latest.packet.readUIntBE(8 + 5, 3)).toBe(1);
    socket.emit('message', report(2));
    latest = tap.latest()!;
    expect(latest.ageMs).toBe(0);
    expect(latest.packet.readUIntBE(8 + 5, 3)).toBe(2);
    expect(latest.packet.length).toBe(76);
    // The copy handed out is the reader's: a later report doesn't change it.
    socket.emit('message', report(3));
    expect(latest.packet.readUIntBE(8 + 5, 3)).toBe(2);
    tap.close();
    expect(socket.listenerCount('message')).toBe(0);
    expect(tap.latest()).toBeNull();
    expect(tap.open).toBe(false);
    tap.close();
    expect(socket.listenerCount('message')).toBe(0);
  });
});

describe('Discord receiver reports: when a link is armed', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function watch(timeoutMs?: number) {
    const calls: string[] = [];
    const w = new ReportWatch(
      { arm: () => calls.push('arm'), disarm: () => calls.push('disarm') },
      timeoutMs,
    );
    return { w, calls };
  }

  it('shares one arm between admins and disarms after the last Close', () => {
    vi.useFakeTimers();
    const { w, calls } = watch();
    w.open('a');
    w.open('a');
    w.open('b');
    expect(w.viewers).toBe(2);
    expect(w.armed).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    w.close('a');
    expect(w.armed).toBe(true);
    w.close('a'); // twice: harmless
    w.close('b');
    expect(w.armed).toBe(false);
    expect(calls.filter((c) => c === 'disarm')).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    w.close('b');
    w.stop();
    expect(calls.filter((c) => c === 'disarm')).toHaveLength(1);
  });

  it('disarms on its own 15 minutes after the last open or Refresh', () => {
    vi.useFakeTimers();
    const { w, calls } = watch();
    w.open('a');
    vi.advanceTimersByTime(10 * 60_000);
    w.open('b'); // a Refresh resets the timeout
    vi.advanceTimersByTime(REPORT_WATCH_MS - 1);
    expect(w.armed).toBe(true);
    vi.advanceTimersByTime(1);
    expect(w.armed).toBe(false);
    expect(w.viewers).toBe(0);
    expect(calls).toEqual(['arm', 'arm', 'disarm']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops at once whoever is looking, and opening again arms again', () => {
    vi.useFakeTimers();
    const { w, calls } = watch(1_000);
    w.open('a');
    w.open('b');
    w.stop();
    expect(w.armed).toBe(false);
    expect(w.viewers).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    w.open('c');
    expect(calls).toEqual(['arm', 'arm', 'disarm', 'arm']);
    vi.advanceTimersByTime(1_000);
    expect(calls.at(-1)).toBe('disarm');
  });

  it('remembers a bounded number of admins; any more still arm and extend it', () => {
    vi.useFakeTimers();
    const { w } = watch();
    for (let i = 0; i < MAX_REPORT_VIEWERS + 10; i++) w.open(`admin-${i}`);
    expect(w.viewers).toBe(MAX_REPORT_VIEWERS);
    expect(w.armed).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('lets the process exit while armed (the timer is unref’d)', () => {
    const { w } = watch();
    const spy = vi.spyOn(globalThis, 'setTimeout');
    w.open('a');
    const handle = spy.mock.results[0]!.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    spy.mockRestore();
    w.stop();
  });
});

describe('Discord receiver reports: the stats line', () => {
  it('says what Discord’s server saw, and that loss after it is not included', () => {
    const line = receiverReportLine({
      state: 'ok',
      report: { lost: 9, expected: 210_000, fractionLost: 0.01, jitterMs: 2.5, ageMs: 1_400 },
    });
    expect(line).toBe(
      'Lost on the way to Discord: 9 packets (0.0043% of 210,000) since the voice connection began · 1% since its previous report · jitter 2.5 ms (Discord’s voice server report, 1 s ago; loss from there to each listener isn’t included)',
    );
    expect(
      receiverReportLine({
        state: 'ok',
        report: { lost: -1, expected: null, fractionLost: 0, jitterMs: 0, ageMs: 0 },
      }),
    ).toMatch(/^Lost on the way to Discord: 0 packets since the voice connection began · jitter 0 ms/);
    expect(receiverReportLine({ state: 'waiting' })).toMatch(/waiting for Discord’s voice server report/);
    expect(receiverReportLine({ state: 'off' })).toMatch(/press Refresh/);
    expect(receiverReportLine(null)).toMatch(/press Refresh/);
    expect(receiverReportLine({ state: 'unreadable', reason: 'no key' })).toMatch(
      /couldn’t be read: no key$/,
    );
  });
});
