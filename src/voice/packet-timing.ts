/** Packets more than this far apart count as late: one 20 ms frame overdue. */
export const LATE_PACKET_GAP_MS = 40;

/** How many of the most recent late packets are kept, with when they happened and how late. */
export const RECENT_LATE_PACKETS = 16;

export interface LatePacket {
  /** Wall-clock time of the late packet (`Date.now()`). */
  at: number;
  /** Gap since the packet before, ms. */
  gapMs: number;
}

export interface PacketTimingSummary {
  /** Packets sent more than LATE_PACKET_GAP_MS after the one before. */
  late: number;
  /** Longest gap between two packets, ms (null before two packets in a row). */
  worstGapMs: number | null;
  /** The last RECENT_LATE_PACKETS late packets, oldest first. */
  recent: ReadonlyArray<LatePacket>;
}

/**
 * Times the gaps between voice packets. The voice player sends one every 20 ms from its event
 * loop, so a gap well over that means the loop was busy and the listener's client had to stretch
 * the audio. Gaps across a pause or a voice reconnect are not lateness, so `pause()` forgets the
 * last packet.
 *
 * `sent()` runs for every packet, so it reads one clock and allocates nothing: the recent late
 * packets go into rings allocated once, and only in the (rare) late branch.
 */
export class PacketTiming {
  readonly #now: () => number;
  readonly #wallClock: () => number;
  #last: number | null = null;
  #late = 0;
  #worst: number | null = null;
  readonly #recentAt = new Float64Array(RECENT_LATE_PACKETS);
  readonly #recentGap = new Float64Array(RECENT_LATE_PACKETS);

  constructor(now: () => number = () => performance.now(), wallClock: () => number = Date.now) {
    this.#now = now;
    this.#wallClock = wallClock;
  }

  sent(): void {
    const at = this.#now();
    if (this.#last !== null) {
      const gap = at - this.#last;
      if (gap > LATE_PACKET_GAP_MS) {
        const slot = this.#late % RECENT_LATE_PACKETS;
        this.#recentAt[slot] = this.#wallClock();
        this.#recentGap[slot] = gap;
        this.#late++;
      }
      if (this.#worst === null || gap > this.#worst) this.#worst = gap;
    }
    this.#last = at;
  }

  pause(): void {
    this.#last = null;
  }

  summary(): PacketTimingSummary {
    const kept = Math.min(this.#late, RECENT_LATE_PACKETS);
    const recent: LatePacket[] = [];
    for (let i = this.#late - kept; i < this.#late; i++) {
      const slot = i % RECENT_LATE_PACKETS;
      recent.push({ at: this.#recentAt[slot]!, gapMs: Math.round(this.#recentGap[slot]!) });
    }
    return { late: this.#late, worstGapMs: this.#worst === null ? null : Math.round(this.#worst), recent };
  }
}
