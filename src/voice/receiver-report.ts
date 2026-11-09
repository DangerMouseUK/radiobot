import { createDecipheriv } from 'node:crypto';

/**
 * Discord's voice server reports, about once a second, what it received of the bot's audio: an
 * RTCP Receiver Report (RFC 3550 §6.4.2) sent to the bot's voice UDP socket. `@discordjs/voice`
 * ignores it. This module reads it, on demand only (`/radio stats`):
 *
 * - `ReceiverReportTap` listens on the voice socket while armed and keeps the latest report in one
 *   fixed buffer, overwritten in place. Nothing is decrypted, logged or kept beyond that one slot.
 * - `openReceiverReport()` decrypts and parses the slot when the stats view is rendered.
 * - `ReportWatch` decides when a link is armed: from an admin opening or refreshing the stats
 *   until the last of them presses Close, or 15 minutes after the last open or Refresh.
 *
 * The counters in a report are cumulative for the connection, so reading one now and then loses
 * nothing. They describe what reached Discord's voice server only: loss on the way from there to
 * each listener is not included.
 */

/** RTCP payload type of a Receiver Report. */
export const RTCP_RECEIVER_REPORT = 201;
/** One report block (RFC 3550 §6.4.1): SSRC, fraction lost, cumulative lost, highest sequence, jitter, LSR, DLSR. */
const BLOCK_BYTES = 24;
/** The fixed header and the reporter's SSRC, which travel in the clear. */
const RTCP_HEADER_BYTES = 8;
const AUTH_TAG_BYTES = 16;
/** The `*_rtpsize` modes append the 32-bit nonce counter to every packet. */
const NONCE_SUFFIX_BYTES = 4;
/** A header, one report block, the tag and the nonce: the smallest report worth keeping. */
const MIN_REPORT_BYTES = RTCP_HEADER_BYTES + BLOCK_BYTES + AUTH_TAG_BYTES + NONCE_SUFFIX_BYTES;
/** The slot's size. Discord's reports are 76 bytes; anything larger than this is not kept. */
export const REPORT_SLOT_BYTES = 256;
/** Opus over RTP runs at 48 kHz, so jitter (in timestamp units) divided by this is milliseconds. */
const RTP_UNITS_PER_MS = 48;

/** How long an armed link stays armed after the last open or Refresh of `/radio stats`. */
export const REPORT_WATCH_MS = 15 * 60_000;
/** Distinct admins remembered per server; any more still arm the link and extend the timeout. */
export const MAX_REPORT_VIEWERS = 25;

/**
 * Whether a datagram looks like an RTCP Receiver Report worth keeping: version 2, payload type 201
 * and a size that fits the slot. Four comparisons: this runs for every datagram while armed (about
 * one a second, plus a keep-alive reply every few seconds), never on the send path.
 */
export function isReceiverReport(msg: Uint8Array): boolean {
  return (
    msg.length >= MIN_REPORT_BYTES &&
    msg.length <= REPORT_SLOT_BYTES &&
    (msg[0]! & 0xc0) === 0x80 &&
    msg[1] === RTCP_RECEIVER_REPORT
  );
}

/** The parts of the library's voice UDP socket the tap uses. */
export interface ReportSocket {
  on(event: 'message', listener: (msg: Buffer) => void): unknown;
  off(event: 'message', listener: (msg: Buffer) => void): unknown;
}

/**
 * Listens on one voice socket and keeps the latest Receiver Report in one fixed buffer. Created on
 * arm, closed on disarm: while it doesn't exist, no listener is attached and nothing is held.
 */
export class ReceiverReportTap {
  readonly socket: ReportSocket;
  readonly #slot = Buffer.allocUnsafe(REPORT_SLOT_BYTES);
  readonly #now: () => number;
  #length = 0;
  #at = 0;
  #open = true;
  readonly #onMessage = (msg: Buffer): void => {
    if (!isReceiverReport(msg)) return;
    msg.copy(this.#slot, 0, 0, msg.length);
    this.#length = msg.length;
    this.#at = this.#now();
  };

  constructor(socket: ReportSocket, now: () => number = Date.now) {
    this.socket = socket;
    this.#now = now;
    socket.on('message', this.#onMessage);
  }

  get open(): boolean {
    return this.#open;
  }

  /** A copy of the latest report and how old it is, or null before the first one arrives. */
  latest(): { packet: Buffer; ageMs: number } | null {
    if (!this.#open || this.#length === 0) return null;
    return {
      packet: Buffer.from(this.#slot.subarray(0, this.#length)),
      ageMs: Math.max(0, this.#now() - this.#at),
    };
  }

  /** Removes the listener and forgets the report. Idempotent. */
  close(): void {
    if (!this.#open) return;
    this.#open = false;
    this.socket.off('message', this.#onMessage);
    this.#length = 0;
  }
}

/** One report block, as Discord's voice server sent it. */
export interface ReportBlock {
  /** The SSRC the block is about (the bot's own audio). */
  ssrc: number;
  /** Fraction of packets lost since the previous report, 0 to 1. */
  fractionLost: number;
  /** Packets lost since the connection started (RFC 3550: may go below zero with duplicates). */
  cumulativeLost: number;
  /** Extended highest sequence number received: wrap count × 65536 + the sequence number. */
  highestSequence: number;
  /** Interarrival jitter, in RTP timestamp units (48 kHz). */
  jitter: number;
}

export type XChaChaOpen = (
  key: Uint8Array,
  nonce: Uint8Array,
  aad: Uint8Array,
  sealed: Uint8Array,
) => Uint8Array;

let xchacha: Promise<XChaChaOpen> | null = null;

/**
 * XChaCha20-Poly1305 from `@noble/ciphers`, the module the voice library itself loads for that mode.
 * Imported the first time a report is read in that mode, never at start-up.
 */
export function loadXChaCha(): Promise<XChaChaOpen> {
  xchacha ??= import('@noble/ciphers/chacha.js').then(
    ({ xchacha20poly1305 }) =>
      (key, nonce, aad, sealed) =>
        xchacha20poly1305(key, nonce, aad).decrypt(sealed),
  );
  return xchacha;
}

/**
 * The number of bytes of an RTCP packet that travel in the clear. Discord's reports carry the 8-byte
 * header and the reporter's SSRC in the clear, as SRTCP does, and those are expected to be the
 * additional authenticated data. The 12-byte form, the RTP header size the library's receiver uses
 * for audio, is tried second. Not yet checked against a report from a live call; the tag only
 * verifies with the right layout, so trying both can't yield a wrong reading.
 */
const CLEAR_BYTES = [RTCP_HEADER_BYTES, 12] as const;

function openWith(
  packet: Buffer,
  clear: number,
  mode: string,
  key: Uint8Array,
  open: XChaChaOpen | null,
): Buffer | null {
  const end = packet.length - NONCE_SUFFIX_BYTES;
  const aad = packet.subarray(0, clear);
  const encrypted = packet.subarray(clear, end - AUTH_TAG_BYTES);
  const tag = packet.subarray(end - AUTH_TAG_BYTES, end);
  try {
    if (mode === 'aead_aes256_gcm_rtpsize') {
      // As the library's receiver: the 4-byte counter at the start of a zeroed 12-byte nonce.
      const nonce = Buffer.alloc(12);
      packet.copy(nonce, 0, end);
      const decipher = createDecipheriv('aes-256-gcm', key, nonce);
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      return Buffer.concat([aad, decipher.update(encrypted), decipher.final()]);
    }
    if (mode === 'aead_xchacha20_poly1305_rtpsize' && open) {
      const nonce = Buffer.alloc(24);
      packet.copy(nonce, 0, end);
      return Buffer.concat([aad, open(key, nonce, aad, Buffer.concat([encrypted, tag]))]);
    }
  } catch {
    /* the tag didn't verify with this layout */
  }
  return null;
}

/** Parses a decrypted Receiver Report. Prefers the block about `ssrc`, else the first. */
export function parseReceiverReport(plain: Uint8Array, ssrc?: number): ReportBlock | null {
  const buf = Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength);
  if (buf.length < RTCP_HEADER_BYTES + BLOCK_BYTES || buf[1] !== RTCP_RECEIVER_REPORT) return null;
  const count = buf[0]! & 0x1f;
  // The first packet of a compound packet only: its length is in 32-bit words, minus one.
  const length = Math.min(buf.length, (buf.readUInt16BE(2) + 1) * 4);
  let first: ReportBlock | null = null;
  for (let i = 0; i < count; i++) {
    const at = RTCP_HEADER_BYTES + i * BLOCK_BYTES;
    if (at + BLOCK_BYTES > length) break;
    const lost = buf.readUIntBE(at + 5, 3);
    const block: ReportBlock = {
      ssrc: buf.readUInt32BE(at),
      fractionLost: buf[at + 4]! / 256,
      cumulativeLost: lost & 0x800000 ? lost - 0x1000000 : lost,
      highestSequence: buf.readUInt32BE(at + 8),
      jitter: buf.readUInt32BE(at + 12),
    };
    if (ssrc === undefined || block.ssrc === ssrc) return block;
    first ??= block;
  }
  return first;
}

/**
 * Decrypts a Receiver Report with the voice session's transport key and parses its report block.
 * Null when it can't be read: an unknown mode, a tag that doesn't verify, or no report block.
 */
export async function openReceiverReport(
  packet: Buffer,
  mode: string,
  key: Uint8Array,
  ssrc?: number,
): Promise<ReportBlock | null> {
  if (packet.length < MIN_REPORT_BYTES) return null;
  const open = mode === 'aead_xchacha20_poly1305_rtpsize' ? await loadXChaCha().catch(() => null) : null;
  for (const clear of CLEAR_BYTES) {
    const plain = openWith(packet, clear, mode, key, open);
    if (plain) return parseReceiverReport(plain, ssrc);
  }
  return null;
}

/** What `/radio stats` shows of Discord's report. */
export interface ReceiverReportSummary {
  /** Packets lost on the way to Discord's voice server since the connection started. */
  lost: number;
  /** Packets Discord's server expected by the time of the report (from sequence numbers), when known. */
  expected: number | null;
  /** Fraction lost since Discord's previous report, 0 to 1. */
  fractionLost: number;
  /** Interarrival jitter, ms. */
  jitterMs: number;
  /** How old the report is, ms. */
  ageMs: number;
}

export type ReceiverReportReading =
  /** Not armed (or no longer: the connection resumed, moved or ended). */
  | { state: 'off' }
  /** Armed, but no report has arrived yet. */
  | { state: 'waiting' }
  | { state: 'unreadable'; reason: string }
  | { state: 'ok'; report: ReceiverReportSummary };

/**
 * Packets Discord's server expected by the time of the report: its extended highest sequence
 * number minus the first sequence number the bot sent, plus one. The library numbers packets
 * from a random start and counts up once per packet sent, so the first is `sequence - sent`
 * (mod 2^16). Null when the result doesn't fit what was sent (a report from before a reset).
 */
export function expectedPackets(highestSequence: number, sequence: number, sent: number): number | null {
  if (!Number.isInteger(sequence) || !Number.isInteger(sent) || sent <= 0) return null;
  const first = (((sequence - sent) % 65536) + 65536) % 65536;
  const expected = highestSequence - first + 1;
  return expected >= 1 && expected <= sent ? expected : null;
}

export function summarise(
  block: ReportBlock,
  ageMs: number,
  sequence: { next: number; sent: number } | null,
): ReceiverReportSummary {
  return {
    lost: block.cumulativeLost,
    expected: sequence ? expectedPackets(block.highestSequence, sequence.next, sequence.sent) : null,
    fractionLost: block.fractionLost,
    jitterMs: Math.round((block.jitter / RTP_UNITS_PER_MS) * 10) / 10,
    ageMs,
  };
}

/**
 * When a link listens for reports: from the first open of `/radio stats` until the last admin
 * who opened it presses Close, or `timeoutMs` after the last open or Refresh, whichever is first.
 * The timeout is the backstop: Discord's "Dismiss message" never tells the bot, and the buttons of
 * an ephemeral message stop working after 15 minutes. One timer, reset on every open; one small
 * set of admin IDs. `stop()` ends it all at once (link gone, session stopped, shutdown).
 */
export class ReportWatch {
  readonly #arm: () => void;
  readonly #disarm: () => void;
  readonly #timeoutMs: number;
  readonly #viewers = new Set<string>();
  #timer: NodeJS.Timeout | null = null;
  #armed = false;

  constructor(hooks: { arm: () => void; disarm: () => void }, timeoutMs = REPORT_WATCH_MS) {
    this.#arm = hooks.arm;
    this.#disarm = hooks.disarm;
    this.#timeoutMs = timeoutMs;
  }

  get armed(): boolean {
    return this.#armed;
  }

  get viewers(): number {
    return this.#viewers.size;
  }

  /** An admin opened or refreshed the stats. Arms the link (again, if it disarmed itself) and resets the timeout. */
  open(viewer: string): void {
    if (this.#viewers.has(viewer) || this.#viewers.size < MAX_REPORT_VIEWERS) this.#viewers.add(viewer);
    this.#armed = true;
    this.#arm();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.stop(), this.#timeoutMs);
    this.#timer.unref?.();
  }

  /** An admin pressed Close. The last one out disarms. */
  close(viewer: string): void {
    this.#viewers.delete(viewer);
    if (this.#viewers.size === 0) this.stop();
  }

  /** Disarms now, whoever is still looking. Idempotent. */
  stop(): void {
    this.#viewers.clear();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    if (!this.#armed) return;
    this.#armed = false;
    this.#disarm();
  }
}
