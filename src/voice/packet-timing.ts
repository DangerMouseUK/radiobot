/** Packets more than this far apart count as late: one 20 ms frame overdue. */
export const LATE_PACKET_GAP_MS = 40;

export interface PacketTimingSummary {
  /** Packets sent more than LATE_PACKET_GAP_MS after the one before. */
  late: number;
  /** Longest gap between two packets, ms (null before two packets in a row). */
  worstGapMs: number | null;
}

/**
 * Times the gaps between voice packets. The voice player sends one every 20 ms from the main
 * thread, so a gap well over that means the thread was busy and the listener's client had to
 * stretch the audio. Gaps across a pause or a voice reconnect are not lateness, so `pause()`
 * forgets the last packet.
 */
export class PacketTiming {
  readonly #now: () => number;
  #last: number | null = null;
  #late = 0;
  #worst: number | null = null;

  constructor(now: () => number = () => performance.now()) {
    this.#now = now;
  }

  sent(): void {
    const at = this.#now();
    if (this.#last !== null) {
      const gap = at - this.#last;
      if (gap > LATE_PACKET_GAP_MS) this.#late++;
      if (this.#worst === null || gap > this.#worst) this.#worst = gap;
    }
    this.#last = at;
  }

  pause(): void {
    this.#last = null;
  }

  summary(): PacketTimingSummary {
    return { late: this.#late, worstGapMs: this.#worst === null ? null : Math.round(this.#worst) };
  }
}
