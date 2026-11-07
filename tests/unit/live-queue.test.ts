import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_CAP_MS,
  LIVE_CATCH_UP_MIN_MS,
  LIVE_CUSHION_MAX_MS,
  LIVE_CUSHION_MS,
  LIVE_CUSHION_STEP_MS,
  LIVE_EASE_AFTER_MS,
  LIVE_LIMIT_MS,
  LIVE_SETTLE_MS,
  type LiveCatchUp,
  LiveQueue,
  type LiveQueueOptions,
  liveQueueFrom,
} from '../../src/voice/live-queue.ts';

const FRAME_MS = 20;
const MINUTE = 60_000;

/** A made-up Opus packet carrying its sequence number, so the order out can be checked. */
function packet(id: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(id);
  return buffer;
}

/** When the source's packet `i` arrives, ms (Infinity: the source sends nothing). */
type Arrival = (i: number) => number;

/**
 * A queue between a made-up source and a player that reads every 20 ms, on an injected clock, with
 * `tick()` run every second. Events at the same moment run in this order: arrival, read, tick.
 */
class Rig {
  readonly clock = { t: 0 };
  readonly events: LiveCatchUp[] = [];
  readonly played: number[] = [];
  readonly queue: LiveQueue;
  /** Reads that found nothing to play. */
  misses = 0;
  /** The next packet the source sends. */
  next = 0;
  onPacket: ((id: number, buffer: Buffer) => void) | null = null;
  #readAt = 0;
  #tickAt = 1_000;

  constructor(options: LiveQueueOptions = {}) {
    this.queue = new LiveQueue({
      now: () => this.clock.t,
      tickMs: 0,
      onCatchUp: (event) => this.events.push(event),
      ...options,
    });
  }

  get stats() {
    return this.queue.stats();
  }

  /** The source sends `count` packets at once, now. */
  burst(count: number): void {
    for (let i = 0; i < count; i++) this.#send();
  }

  /** Packets from now on at the source's own pace: one every `periodMs`, the first one period from now. */
  paced(periodMs = FRAME_MS): Arrival {
    const first = this.next;
    const from = this.clock.t;
    return (i) => from + (i - first + 1) * periodMs;
  }

  /** The player takes one packet; returns its ID, or null. */
  read(): number | null {
    const buffer = this.queue.read() as Buffer | null;
    if (buffer === null) {
      this.misses++;
      return null;
    }
    const id = buffer.readUInt32BE(0);
    this.played.push(id);
    return id;
  }

  /** Runs the clock to `until`: packets arrive as `arrival` says, the player reads if `play`. */
  run(until: number, arrival: Arrival = () => Number.POSITIVE_INFINITY, play = true): void {
    for (;;) {
      const sendAt = arrival(this.next);
      const readAt = play ? this.#readAt : Number.POSITIVE_INFINITY;
      const t = Math.min(sendAt, readAt, this.#tickAt);
      if (t > until) break;
      this.clock.t = t;
      if (sendAt === t) this.#send();
      else if (readAt === t) {
        this.read();
        this.#readAt += FRAME_MS;
      } else {
        this.queue.tick();
        this.#tickAt += 1_000;
      }
    }
    this.clock.t = until;
    if (!play) this.#readAt = Math.max(this.#readAt, until);
  }

  #send(): void {
    const id = this.next++;
    const buffer = packet(id);
    this.onPacket?.(id, buffer);
    this.queue.add(buffer);
  }
}

/** A rig whose source has sent `cushion` packets at once and has started playing (nothing trimmed). */
function startedRig(options: LiveQueueOptions = {}): Rig {
  const rig = new Rig(options);
  rig.burst(rig.stats.cushionMs / FRAME_MS);
  rig.clock.t = LIVE_SETTLE_MS;
  rig.queue.tick();
  return rig;
}

/** Reads until the queue has nothing, now. */
function readAll(rig: Rig): void {
  while (rig.read() !== null) {}
}

/** The source stalls for `stallMs` while the player reads on, then sends `backlog` packets at once. Returns when. */
function gap(rig: Rig, stallMs: number, backlog: number): number {
  rig.run(rig.clock.t + stallMs);
  const at = rig.clock.t;
  rig.burst(backlog);
  return at;
}

function expectNear(value: number | null, target: number, tolerance = FRAME_MS): void {
  expect(value).not.toBeNull();
  expect(Math.abs(value! - target)).toBeLessThanOrEqual(tolerance);
}

afterEach(() => {
  vi.useRealTimers();
});

describe('live queue: start-up', () => {
  it('trims the connect burst to the cushion and keeps the newest packets', () => {
    const rig = new Rig();
    rig.burst(200); // the server's 4 s connect burst
    rig.run(2_000, rig.paced());
    // At 300 ms (the settle period) packet 214 has just arrived: 215 waiting, 50 kept.
    expect(rig.events).toEqual([{ reason: 'start', droppedMs: 3_300, cushionMs: LIVE_CUSHION_MS }]);
    expect(rig.played[0]).toBe(215 - LIVE_CUSHION_MS / FRAME_MS);
    expect(rig.played.every((id, k) => id === rig.played[0]! + k)).toBe(true);
    expect(rig.misses).toBe(LIVE_SETTLE_MS / FRAME_MS); // the reads before the start
    expect(rig.stats).toMatchObject({ startDroppedMs: 3_300, caughtUpMs: 0, catchUps: 0, gaps: 0 });
    expectNear(rig.stats.depthMs, LIVE_CUSHION_MS);
  });

  it('waits for the cushion when there is no burst, then trims nothing', () => {
    const rig = new Rig();
    rig.run(990, rig.paced());
    expect(rig.played).toEqual([]);
    expect(rig.stats.depthMs).toBe(980);
    rig.run(3_000, rig.paced());
    expect(rig.events).toEqual([]);
    expect(rig.stats.startDroppedMs).toBe(0);
    expect(rig.played[0]).toBe(0);
    expect(rig.played.every((id, k) => id === k)).toBe(true);
  });

  it('waits for the settle period even when the cushion is already there', () => {
    const rig = new Rig();
    rig.burst(100);
    rig.clock.t = LIVE_SETTLE_MS - 1;
    rig.queue.tick();
    expect(rig.read()).toBeNull();
    rig.clock.t = LIVE_SETTLE_MS;
    rig.queue.tick();
    expect(rig.read()).toBe(50);
    expect(rig.events).toEqual([{ reason: 'start', droppedMs: 1_000, cushionMs: LIVE_CUSHION_MS }]);
  });

  it('plays out a stream that ends before it has the cushion', async () => {
    const rig = new Rig();
    const ended = once(rig.queue, 'end');
    rig.read(); // the player is already waiting
    rig.burst(10);
    rig.queue.finish();
    rig.burst(5); // nothing after the end
    readAll(rig);
    expect(rig.played).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(rig.events).toEqual([]);
    await ended;
  });

  it('bounds the memory before the start too, keeping the newest packets', () => {
    const rig = new Rig();
    rig.burst(LIVE_CAP_MS / FRAME_MS + 500);
    expect(rig.stats.depthMs).toBe(LIVE_CAP_MS);
    rig.clock.t = LIVE_SETTLE_MS;
    rig.queue.tick();
    const total = LIVE_CAP_MS / FRAME_MS + 500;
    expect(rig.read()).toBe(total - LIVE_CUSHION_MS / FRAME_MS);
    expect(rig.stats.startDroppedMs).toBe((total - LIVE_CUSHION_MS / FRAME_MS) * FRAME_MS);
    expect(rig.events).toEqual([
      { reason: 'start', droppedMs: rig.stats.startDroppedMs, cushionMs: LIVE_CUSHION_MS },
    ]);
  });
});

describe('live queue: gaps', () => {
  it('counts a real gap once, grows the cushion and drops the backlog about a second later', () => {
    const rig = new Rig();
    rig.run(5_000, rig.paced());
    expectNear(rig.stats.depthMs, LIVE_CUSHION_MS);
    // The source stalls for 2 s: the queue runs dry after 1 s and stays dry for a second.
    const at = gap(rig, 2_000, 0);
    expect(rig.stats.gaps).toBe(0); // counted when it ends
    rig.burst(100); // then the server sends the 2 s it held back
    expect(rig.stats).toMatchObject({ gaps: 1, cushionMs: LIVE_CUSHION_MS + LIVE_CUSHION_STEP_MS });
    rig.run(at + 990, rig.paced());
    expect(rig.events).toEqual([]);
    rig.run(at + 1_000, rig.paced());
    expect(rig.events).toHaveLength(1);
    expect(rig.events[0]).toMatchObject({ reason: 'gap', cushionMs: 1_500 });
    expectNear(rig.events[0]!.droppedMs, 500);
    expectNear(rig.stats.depthMs, 1_500);
    rig.run(at + 20_000, rig.paced());
    expect(rig.stats).toMatchObject({ gaps: 1, catchUps: 1 });
    expectNear(rig.stats.depthMs, 1_500);
    // Nothing lost but the dropped backlog: the packets play in order.
    const dropped = rig.events[0]!.droppedMs / FRAME_MS;
    const skips = rig.played.slice(1).filter((id, k) => id !== rig.played[k]! + 1);
    expect(skips).toHaveLength(1);
    expect(rig.played.length + dropped + rig.stats.depthMs / FRAME_MS).toBe(rig.next);
  });

  it('refills the cushion after a gap that lost its audio, before playing on', () => {
    const rig = new Rig();
    rig.run(5_000, rig.paced());
    // The source stalls for 2 s and that audio is lost: it then carries on at its own pace, with no
    // backlog. The queue runs dry about a second into the stall.
    rig.run(7_000);
    const before = rig.played.length;
    // 74 packets back (1.48 s): one short of the grown 1.5 s cushion, so still nothing plays.
    rig.run(8_480, rig.paced());
    expect(rig.stats).toMatchObject({ gaps: 1, cushionMs: 1_500 });
    expect(rig.played.length).toBe(before);
    // The 75th refills it: playback goes on, the cushion's length behind live, with nothing dropped.
    rig.run(12_000, rig.paced());
    expect(rig.played.length).toBeGreaterThan(before);
    expectNear(rig.stats.depthMs, 1_500);
    expect(rig.stats).toMatchObject({ gaps: 1, catchUps: 0, caughtUpMs: 0 });
    expect(rig.events).toEqual([]);
    // A later hiccup shorter than the cushion is now covered: no second gap.
    rig.run(12_800);
    rig.run(20_000, rig.paced());
    expect(rig.stats.gaps).toBe(1);
  });

  it('grows the cushion by a step per gap, up to the maximum', () => {
    const rig = new Rig();
    rig.run(5_000, rig.paced());
    const cushions: number[] = [];
    for (let i = 0; i < 5; i++) {
      gap(rig, 4_000, 200);
      rig.run(rig.clock.t + 5_000, rig.paced());
      cushions.push(rig.stats.cushionMs);
      expectNear(rig.stats.depthMs, rig.stats.cushionMs);
    }
    expect(cushions).toEqual([1_500, 2_000, 2_500, 3_000, LIVE_CUSHION_MAX_MS]);
    expect(rig.stats.gaps).toBe(5);
  });

  it('does not count a normal empty moment of under two frames as a gap', () => {
    const rig = startedRig();
    readAll(rig);
    rig.clock.t += 20;
    rig.burst(1);
    expect(rig.read()).not.toBeNull();
    rig.read(); // empty again
    rig.clock.t += 39;
    rig.burst(1);
    expect(rig.stats.gaps).toBe(0);
    readAll(rig);
    rig.clock.t += 40;
    rig.burst(1);
    expect(rig.stats).toMatchObject({ gaps: 1, cushionMs: 1_500 });
  });

  it('is not a gap when nobody asked for a packet', () => {
    const rig = startedRig();
    while (rig.stats.depthMs > 0) rig.read();
    rig.clock.t += 5_000; // the queue is empty but the player hasn't asked
    rig.burst(1);
    expect(rig.stats.gaps).toBe(0);
  });

  it('keeps the drift estimate clean across a gap that loses audio', () => {
    const rig = new Rig();
    rig.run(5 * MINUTE, rig.paced());
    // A 1.5 s stall whose audio never comes: the queue now runs about 1 s lower, for good.
    gap(rig, 1_500, 0);
    rig.run(25 * MINUTE, rig.paced());
    expect(rig.stats.gaps).toBe(1);
    expect(rig.stats.driftPpm).toBe(0);
  });
});

/** HLS-style delivery: whole segments of `chunkMs` at once, segment `k` arriving at `at(k)`. */
function segments(rig: Rig, chunkMs: number, at: (k: number) => number): Arrival {
  const perSegment = chunkMs / FRAME_MS;
  const first = rig.next;
  return (i) => at(Math.floor((i - first) / perSegment));
}

describe('live queue: segment-sized delivery (HLS)', () => {
  const SEGMENT = 6_000;
  /** Three segments back to back at the start, as the HLS reader fetches them, then one every 6 s. */
  const live = (k: number, lateMs = 0, lateK = -1) =>
    (k < 3 ? k * 200 : (k - 2) * SEGMENT + 400) + (k === lateK ? lateMs : 0);

  it('keeps a segment plus the margin, and never runs dry on steady delivery', () => {
    const rig = new Rig({ chunkMs: SEGMENT });
    expect(rig.stats.cushionMs).toBe(SEGMENT + LIVE_CUSHION_MS);
    rig.run(
      120_000,
      segments(rig, SEGMENT, (k) => live(k)),
    );
    // Started once the burst stopped (a second of quiet, at the 2 s tick): 18 s in, 7 s kept.
    expect(rig.events[0]).toEqual({ reason: 'start', droppedMs: 11_000, cushionMs: 7_000 });
    expect(rig.stats).toMatchObject({ gaps: 0, cushionMs: 7_000 });
    expect(rig.stats.depthMs).toBeLessThanOrEqual(7_600);
    // The floor is the trough between segments: the margin and more, never less (here 2.6 s, as the
    // start fell 4.4 s before the next segment).
    expect(rig.stats.floorMs).toBeGreaterThanOrEqual(LIVE_CUSHION_MS);
    expect(rig.stats.floorMs).toBeLessThan(SEGMENT);
  });

  it('after a late segment, plays on as soon as it arrives, without waiting for another', () => {
    const rig = new Rig({ chunkMs: SEGMENT });
    // Segment 6 (due at 24.4 s) comes 3 s late: the queue, down to about 2.6 s, runs dry for 0.4 s.
    const late = segments(rig, SEGMENT, (k) => live(k, 3_000, 6));
    rig.run(24_000, late);
    const missesBefore = rig.misses;
    rig.run(60_000, late);
    expect(rig.stats.gaps).toBe(1);
    // The margin grew; the cushion is the segment plus the new margin.
    expect(rig.stats.cushionMs).toBe(SEGMENT + LIVE_CUSHION_MS + LIVE_CUSHION_STEP_MS);
    // Only the late part was silent (about 0.4 s), not a whole segment's wait on top.
    expect(rig.misses - missesBefore).toBeLessThanOrEqual(25);
  });

  it('drops a late part of the start burst at a second look, so it never stays on as delay', () => {
    const rig = new Rig({ chunkMs: SEGMENT });
    // The third start segment is slow to fetch: it lands after playback has begun.
    const slowStart = (k: number) => (k === 2 ? 2_500 : live(k));
    rig.run(30_000, segments(rig, SEGMENT, slowStart));
    expect(rig.events.map((event) => event.reason)).toEqual(['start', 'settle']);
    expect(rig.events[0]).toMatchObject({ droppedMs: 5_000 }); // 12 s in at the start, 7 s kept
    expect(rig.events[1]!.droppedMs).toBeGreaterThanOrEqual(5_000);
    rig.run(90_000, segments(rig, SEGMENT, slowStart));
    expect(rig.stats.depthMs).toBeLessThanOrEqual(7_600);
  });

  it('drops a lasting excess once the floor is 3 s above the margin, not above the whole cushion', () => {
    const rig = new Rig({ chunkMs: SEGMENT });
    rig.run(
      60_000,
      segments(rig, SEGMENT, (k) => live(k)),
    );
    // 3.5 s of audio more than the station's pace, with no gap to hide a cut.
    rig.burst(175);
    rig.run(
      90_000,
      segments(rig, SEGMENT, (k) => live(k)),
    );
    expect(rig.events.map((event) => event.reason)).toContain('limit');
    expect(rig.stats.floorMs).toBeLessThan(LIVE_CUSHION_MS + LIVE_LIMIT_MS);
  });

  it('allows for segments of at most 12 s', () => {
    expect(new Rig({ chunkMs: 60_000 }).stats.cushionMs).toBe(12_000 + LIVE_CUSHION_MS);
    expect(new Rig({ chunkMs: -5 }).stats.cushionMs).toBe(LIVE_CUSHION_MS);
  });

  it('grows the margin by a step per gap up to 3 s, and eases it back to 1 s', () => {
    const rig = new Rig({ chunkMs: 2_000 });
    rig.run(5_000, rig.paced());
    for (let i = 0; i < 6; i++) {
      gap(rig, 5_000, 0);
      rig.run(rig.clock.t + 5_000, rig.paced());
    }
    expect(rig.stats.cushionMs).toBe(2_000 + LIVE_CUSHION_MAX_MS);
    for (let i = 0; i < 6; i++) {
      rig.clock.t += LIVE_EASE_AFTER_MS;
      rig.queue.tick();
    }
    expect(rig.stats.cushionMs).toBe(2_000 + LIVE_CUSHION_MS);
  });

  it('looks back over two segments for the floor', () => {
    const rig = new Rig({ chunkMs: SEGMENT });
    const steady = segments(rig, SEGMENT, (k) => live(k));
    rig.run(14_999, steady);
    expect(rig.stats.floorMs).toBeNull(); // a 13 s window, from the start at 2 s
    rig.run(15_000, steady);
    expect(rig.stats.floorMs).not.toBeNull();
  });
});

describe('live queue: catch-ups', () => {
  it("drops the excess over the cushion on catchUp('resume'), oldest first", () => {
    const rig = startedRig();
    rig.burst(30); // the player was held while 0.6 s more arrived
    expect(rig.stats.depthMs).toBe(1_600);
    expect(rig.queue.catchUp('resume')).toBe(600);
    expect(rig.events).toEqual([{ reason: 'resume', droppedMs: 600, cushionMs: LIVE_CUSHION_MS }]);
    expect(rig.stats).toMatchObject({ depthMs: LIVE_CUSHION_MS, caughtUpMs: 600, catchUps: 1 });
    expect(rig.read()).toBe(30);
  });

  it('does not cut for an excess under the minimum', () => {
    const rig = startedRig();
    rig.burst(LIVE_CATCH_UP_MIN_MS / FRAME_MS - 1);
    expect(rig.queue.catchUp('resume')).toBe(0);
    expect(rig.events).toEqual([]);
    rig.burst(1);
    expect(rig.queue.catchUp('resume')).toBe(LIVE_CATCH_UP_MIN_MS);
    expect(rig.stats).toMatchObject({ caughtUpMs: LIVE_CATCH_UP_MIN_MS, catchUps: 1 });
  });

  it('does nothing on a resume before the start', () => {
    const rig = new Rig();
    rig.burst(500);
    expect(rig.queue.catchUp('resume')).toBe(0);
    expect(rig.stats.depthMs).toBe(10_000);
  });

  it('measures the drift afresh after a resume, even when nothing is dropped', () => {
    const rig = new Rig();
    const source = rig.paced();
    rig.run(5 * MINUTE, source);
    rig.run(rig.clock.t + 160, source, false); // the player held for 160 ms: the level is 160 ms higher
    expect(rig.queue.catchUp('resume')).toBe(0);
    rig.run(25 * MINUTE, source);
    expect(rig.stats.driftPpm).toBe(0);
  });

  it('drops a lasting excess of the limit on its own', () => {
    const rig = new Rig();
    rig.run(5_000, rig.paced());
    rig.burst((LIVE_LIMIT_MS + 200) / FRAME_MS);
    rig.run(8_000, rig.paced()); // the floor looks back 3 s
    expect(rig.events).toEqual([]);
    rig.run(12_000, rig.paced());
    expect(rig.events).toHaveLength(1);
    expect(rig.events[0]).toMatchObject({ reason: 'limit', cushionMs: LIVE_CUSHION_MS });
    expectNear(rig.events[0]!.droppedMs, LIVE_LIMIT_MS + 200);
    expectNear(rig.stats.depthMs, LIVE_CUSHION_MS);
  });

  it('leaves an excess under the limit alone', () => {
    const rig = new Rig();
    rig.run(5_000, rig.paced());
    rig.burst((LIVE_LIMIT_MS - 200) / FRAME_MS);
    rig.run(60_000, rig.paced());
    expect(rig.events).toEqual([]);
    expectNear(rig.stats.depthMs, LIVE_CUSHION_MS + LIVE_LIMIT_MS - 200);
  });

  it('caps the queue, whatever happens', () => {
    const rig = startedRig();
    rig.burst(LIVE_CAP_MS / FRAME_MS - LIVE_CUSHION_MS / FRAME_MS); // nobody reads
    expect(rig.stats.depthMs).toBe(LIVE_CAP_MS);
    expect(rig.events).toEqual([]);
    rig.burst(1);
    expect(rig.events).toEqual([{ reason: 'cap', droppedMs: 29_020, cushionMs: LIVE_CUSHION_MS }]);
    expect(rig.stats.depthMs).toBe(LIVE_CUSHION_MS);
    expect(rig.read()).toBe(rig.next - LIVE_CUSHION_MS / FRAME_MS);
  });

  it('eases the cushion back after 30 calm minutes, at the next catch-up', () => {
    const rig = new Rig();
    rig.run(5_000, rig.paced());
    gap(rig, 3_000, 150);
    gap(rig, 4_000, 200);
    const lastGap = rig.clock.t;
    rig.run(rig.clock.t + 5_000, rig.paced());
    expect(rig.stats.cushionMs).toBe(2_000);
    const depth = rig.stats.depthMs;
    rig.clock.t = lastGap + LIVE_EASE_AFTER_MS - 1;
    rig.queue.tick();
    expect(rig.stats.cushionMs).toBe(2_000);
    rig.clock.t = lastGap + LIVE_EASE_AFTER_MS;
    rig.queue.tick();
    expect(rig.stats.cushionMs).toBe(1_500);
    expect(rig.stats.depthMs).toBe(depth); // the surplus waits for the next catch-up
    expect(rig.queue.catchUp('resume')).toBe(depth - 1_500);
    rig.clock.t += LIVE_EASE_AFTER_MS;
    rig.queue.tick();
    expect(rig.stats.cushionMs).toBe(LIVE_CUSHION_MS);
    rig.clock.t += LIVE_EASE_AFTER_MS;
    rig.queue.tick();
    expect(rig.stats.cushionMs).toBe(LIVE_CUSHION_MS); // never below where it started
  });

  it('restarts the calm half hour at every gap', () => {
    const rig = new Rig();
    rig.run(5_000, rig.paced());
    gap(rig, 3_000, 150);
    rig.run(20 * MINUTE, rig.paced());
    gap(rig, 3_000, 150);
    rig.run(45 * MINUTE, rig.paced());
    expect(rig.stats.cushionMs).toBe(2_000);
    rig.run(51 * MINUTE, rig.paced());
    expect(rig.stats.cushionMs).toBe(1_500);
  });
});

describe('live queue: floor and drift', () => {
  it('reports the floor once it has a window of seconds, the lowest of them', () => {
    const rig = new Rig();
    const source = rig.paced();
    rig.run(1_000, source); // starts at 1 s
    rig.run(2_999, source);
    expect(rig.stats.floorMs).toBeNull();
    rig.run(3_000, source);
    expect(rig.stats.floorMs).toBe(980);
    rig.run(10_000, source);
    expect(rig.stats.floorMs).toBe(980);
    // The player misses four reads (10 020 to 10 080): the level is 80 ms higher from then on,
    // but the floor keeps the lower second until it leaves the window.
    rig.run(10_100, source, false);
    rig.run(13_000, source);
    expect(rig.stats.floorMs).toBe(980);
    rig.run(14_000, source);
    expect(rig.stats.floorMs).toBe(1_060);
  });

  it('reports no drift for a steady source, and only after ten minutes', () => {
    const rig = new Rig();
    rig.run(10 * MINUTE, rig.paced());
    expect(rig.stats.driftPpm).toBeNull();
    rig.run(20 * MINUTE, rig.paced());
    expect(rig.stats.driftPpm).toBe(0);
  });

  it('estimates how fast a station runs ahead of our clock', () => {
    const rig = new Rig();
    rig.run(40 * MINUTE, rig.paced(FRAME_MS / (1 + 50e-6)));
    expect(rig.stats.driftPpm).toBeGreaterThanOrEqual(40);
    expect(rig.stats.driftPpm).toBeLessThanOrEqual(60);
    expect(rig.events).toEqual([]); // 120 ms in 40 minutes: no cut
  });

  it('estimates how far a station falls behind our clock', () => {
    const rig = new Rig();
    rig.run(40 * MINUTE, rig.paced(FRAME_MS / (1 - 50e-6)));
    expect(rig.stats.driftPpm).toBeGreaterThanOrEqual(-60);
    expect(rig.stats.driftPpm).toBeLessThanOrEqual(-40);
    expect(rig.stats.gaps).toBe(0);
  });

  it('measures the drift afresh after a catch-up', () => {
    const rig = new Rig();
    rig.run(15 * MINUTE, rig.paced());
    expect(rig.stats.driftPpm).toBe(0);
    rig.burst(30);
    expect(rig.queue.catchUp('resume')).toBeGreaterThan(0);
    expect(rig.stats).toMatchObject({ floorMs: null, driftPpm: 0 });
    rig.run(rig.clock.t + 2_000, rig.paced());
    expect(rig.stats.floorMs).toBeNull();
  });
});

describe('live queue: stats, ending and clean-up', () => {
  it('starts with empty stats', () => {
    const queue = new LiveQueue({ tickMs: 0 });
    expect(queue.stats()).toEqual({
      depthMs: 0,
      floorMs: null,
      cushionMs: LIVE_CUSHION_MS,
      startDroppedMs: 0,
      caughtUpMs: 0,
      catchUps: 0,
      gaps: 0,
      driftPpm: null,
    });
    queue.destroy();
  });

  it('adds up the catch-ups', () => {
    const rig = startedRig();
    rig.burst(30);
    rig.queue.catchUp('resume');
    rig.burst(20);
    rig.queue.catchUp('resume');
    expect(rig.stats).toMatchObject({ caughtUpMs: 1_000, catchUps: 2, startDroppedMs: 0 });
  });

  it('ends after the last packet once finished', async () => {
    const rig = new Rig();
    rig.run(2_000, rig.paced());
    const ended = once(rig.queue, 'end');
    const waiting = rig.stats.depthMs / FRAME_MS;
    rig.queue.finish();
    rig.queue.finish();
    rig.burst(3); // ignored
    readAll(rig);
    expect(rig.played).toHaveLength(rig.next - 3);
    expect(rig.played.slice(-waiting)).toEqual(
      Array.from({ length: waiting }, (_, k) => rig.next - 3 - waiting + k),
    );
    await ended;
  });

  it('ends at once when the player is already waiting on an empty queue', async () => {
    const rig = startedRig();
    readAll(rig);
    const ended = once(rig.queue, 'end');
    rig.queue.finish();
    expect(rig.read()).toBeNull();
    await ended;
  });

  it('clears its timer and frees its packets when destroyed', () => {
    vi.useFakeTimers();
    const queue = new LiveQueue({ tickMs: 1_000 });
    for (let i = 0; i < 60; i++) queue.add(packet(i));
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1_000); // the timer's tick starts it
    expect(queue.stats()).toMatchObject({ depthMs: LIVE_CUSHION_MS, startDroppedMs: 200 });
    queue.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(queue.stats().depthMs).toBe(0);
    queue.add(packet(60));
    queue.tick();
    queue.finish();
    expect(queue.stats().depthMs).toBe(0);
  });

  it('holds no reference to packets it has played or dropped, over a long run', async () => {
    setFlagsFromString('--expose-gc');
    const gc = runInNewContext('gc') as () => void;
    const rig = new Rig();
    const sent: WeakRef<Buffer>[] = [];
    rig.onPacket = (id, buffer) => {
      if (id % 100 === 0) sent.push(new WeakRef(buffer));
    };
    let arrival = rig.paced();
    while (rig.next < 100_000) {
      rig.run(rig.clock.t + 60_000, arrival);
      rig.burst(40); // a hold, and the resume that drops it
      rig.queue.catchUp('resume');
      arrival = rig.paced();
    }
    expect(rig.stats.depthMs).toBeLessThanOrEqual(LIVE_CUSHION_MS);
    await new Promise((resolve) => setImmediate(resolve));
    gc();
    // Nothing older than the compaction threshold and the queue itself is held on to.
    const kept = sent.filter((ref, k) => ref.deref() !== undefined && k * 100 < rig.next - 3_000);
    expect(kept).toEqual([]);
    rig.queue.destroy();
  });
});

/** One Ogg page (RFC 3533) holding `packets`; prism's demuxer doesn't check the CRC, so it's left 0. */
function oggPage(sequence: number, packets: Buffer[], serial = 0x5eed): Buffer {
  const lacing: number[] = [];
  for (const p of packets) {
    let size = p.length;
    for (; size >= 255; size -= 255) lacing.push(255);
    lacing.push(size);
  }
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'latin1');
  header.writeUInt8(0, 4); // stream structure version
  header.writeUInt8(sequence === 0 ? 2 : 0, 5); // beginning of stream
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header.writeUInt8(lacing.length, 26);
  return Buffer.concat([header, Buffer.from(lacing), ...packets]);
}

function opusHead(): Buffer {
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head.writeUInt8(1, 8); // version
  head.writeUInt8(2, 9); // channels
  head.writeUInt16LE(312, 10); // pre-skip
  head.writeUInt32LE(48_000, 12); // input sample rate
  return head;
}

function opusTags(): Buffer {
  const vendor = Buffer.from('test', 'latin1');
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write('OpusTags', 0, 'latin1');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  return tags;
}

/** A made-up 20 ms Opus packet (a TOC byte and a sequence number; nothing decodes it). */
function audio(id: number, size = 5): Buffer {
  const buffer = Buffer.alloc(size);
  buffer.writeUInt8(0xfc, 0);
  buffer.writeUInt16BE(id, 1);
  return buffer;
}

/** The Ogg Opus stream FFmpeg would write: OpusHead, OpusTags, then `count` packets, `perPage` to a page. */
function oggOpus(count: number, perPage = 5): Buffer[] {
  const pages = [oggPage(0, [opusHead()]), oggPage(1, [opusTags()])];
  for (let first = 0; first < count; first += perPage) {
    const ids = Array.from({ length: Math.min(perPage, count - first) }, (_, k) => first + k);
    pages.push(
      oggPage(
        pages.length,
        ids.map((id) => audio(id, id === 3 ? 300 : 5)),
      ),
    );
  }
  return pages;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Resolves on 'close' (registered up front: `once()` would reject on the 'error' before it). */
const closing = (queue: LiveQueue) => new Promise<void>((resolve) => queue.once('close', () => resolve()));

describe('liveQueueFrom', () => {
  it('demuxes Ogg Opus into the queue in order, and ends when the source does', async () => {
    const source = new PassThrough();
    const queue = liveQueueFrom(source, { tickMs: 0, now: () => 0 });
    const out: Buffer[] = [];
    queue.on('data', (p: Buffer) => out.push(p));
    const ended = once(queue, 'end');
    const closed = closing(queue);
    const stream = Buffer.concat(oggOpus(12));
    // Split mid-page, as a pipe would.
    source.write(stream.subarray(0, 61));
    source.write(stream.subarray(61, 200));
    source.end(stream.subarray(200));
    await ended;
    expect(out.map((p) => p.readUInt16BE(1))).toEqual(Array.from({ length: 12 }, (_, k) => k));
    expect(out[3]).toHaveLength(300); // a packet laced over two segments
    expect(out[0]).toEqual(audio(0));
    await closed;
    expect(source.destroyed).toBe(true);
  });

  it('reads eagerly, so the backlog builds up in the queue where it is measured', async () => {
    const source = new PassThrough();
    let now = 0;
    const queue = liveQueueFrom(source, { tickMs: 0, now: () => now });
    for (const page of oggOpus(200)) source.write(page);
    await tick();
    expect(queue.stats().depthMs).toBe(4_000);
    now = LIVE_SETTLE_MS;
    queue.tick();
    expect(queue.stats()).toMatchObject({ depthMs: LIVE_CUSHION_MS, startDroppedMs: 3_000 });
    expect((queue.read() as Buffer).readUInt16BE(1)).toBe(150);
    queue.destroy();
  });

  it('destroys the queue with the error when the source fails', async () => {
    const source = new PassThrough();
    const queue = liveQueueFrom(source, { tickMs: 0, now: () => 0 });
    const failed = once(queue, 'error');
    const closed = closing(queue);
    source.write(Buffer.concat(oggOpus(3)));
    source.destroy(new Error('stream lost'));
    const [error] = await failed;
    expect((error as Error).message).toBe('stream lost');
    await closed;
    expect(queue.destroyed).toBe(true);
    expect(queue.stats().depthMs).toBe(0);
  });

  it('destroys the queue when the bytes are not Ogg', async () => {
    const source = new PassThrough();
    const queue = liveQueueFrom(source, { tickMs: 0, now: () => 0 });
    const failed = once(queue, 'error');
    const closed = closing(queue);
    source.write(Buffer.from('ICY 200 OK\r\nicy-name: not ogg at all\r\n'));
    const [error] = await failed;
    expect((error as Error).message).toMatch(/capture_pattern/);
    await closed;
    expect(source.destroyed).toBe(true);
  });

  it('destroys the source when the queue is destroyed', async () => {
    const source = new PassThrough();
    const queue = liveQueueFrom(source, { tickMs: 0, now: () => 0 });
    source.write(Buffer.concat(oggOpus(3)));
    await tick();
    expect(queue.stats().depthMs).toBe(60);
    const closed = closing(queue);
    queue.destroy();
    await closed;
    expect(source.destroyed).toBe(true);
  });
});
