import { Readable } from 'node:stream';
import { opus } from 'prism-media';

/**
 * The live edge of a stream: the Opus packets between the station and the 20 ms sender, held in
 * one queue so the bot knows exactly how far behind live it plays, and keeps that small.
 *
 * Every station is live, so the delay must be as small as possible and must never grow (AGENTS.md,
 * "Live means live"). Upstream of this queue nothing holds audio back: packets are taken from the
 * Ogg stream as soon as FFmpeg writes them, so a backlog can only build up here, where it is seen.
 *
 * - **Start.** A station's server sends a burst of audio on connect (Icecast's default is 64 KB,
 *   about 4 s at 128 kbps). Nothing has been heard yet, so everything but the cushion is dropped
 *   before the first packet goes out: the stream starts the cushion's length behind live. It starts
 *   once the burst has landed (audio no longer arriving faster than real time), not in the middle.
 * - **Cushion = chunk + margin.** The chunk is how much audio arrives in one go: nothing for a
 *   continuous (ICY) stream, a whole segment for HLS (up to LIVE_CHUNK_MAX_MS). The margin is the
 *   safety margin every stream keeps on top: 1 s to start with, as VLC's network cache. When the
 *   queue runs dry (a network gap) the margin grows by 0.5 s, up to 3 s, for this stream; after 30
 *   minutes without a gap it eases back by 0.5 s at a time, taking effect at the next catch-up.
 * - **Refill.** After a gap, playback goes on only once the margin is back in hand (for HLS, as soon
 *   as the next segment arrives), as at the start and as VLC rebuffers: the listener is hearing the
 *   gap anyway, and playing on from an empty queue would make every later hiccup audible.
 * - **Settle.** A second look shortly after the start drops any late part of the connect burst
 *   (HLS fetches its first segments one after another), so it can't stay on as extra delay.
 * - **Catch-up.** Audio that piles up past the cushion is dropped where the listener has just heard
 *   a break anyway: after a network gap (the server then sends what it held back: dropped as soon as
 *   the refill is done, and looked at again a second later) and after a voice resume. A gap that has happened is not paid for again with lasting delay. Only when the excess
 *   reaches 3 s with no such moment (a station whose clock runs fast) is it dropped on its own: the
 *   queue's floor (its lowest point over the window) has risen 3 s above the margin.
 * - **Drift.** The queue's floor (its lowest level over a few seconds) rises as fast as the
 *   station's clock outruns ours; the estimate, in parts per million, is reported, not corrected
 *   by resampling (the audio is never altered). A gap, a catch-up or a resume moves the level for
 *   other reasons, so each starts the measurement again. The floor moves in whole packets, so the
 *   estimate is within about ±33 ppm after 10 minutes and sharpens as the stretch grows.
 *
 * Per packet the work is constant: an array push or an index step, a clock read and a comparison.
 * The once-a-second bookkeeping runs on its own timer. Memory is bounded by LIVE_CAP_MS, before the
 * start too.
 */

const FRAME_MS = 20;
/** The safety margin a stream starts with, on top of its chunk, ms. */
export const LIVE_CUSHION_MS = 1_000;
/** How much a network gap adds to the margin, and how much a calm half hour takes off, ms. */
export const LIVE_CUSHION_STEP_MS = 500;
/** The most a stream's margin grows to, ms. */
export const LIVE_CUSHION_MAX_MS = 3_000;
/** The largest chunk (HLS segment) the queue allows for, ms: the cushion stays well inside the cap. */
export const LIVE_CHUNK_MAX_MS = 12_000;
/** A stream without a gap for this long eases its margin back by one step. */
export const LIVE_EASE_AFTER_MS = 30 * 60_000;
/** How long after the first packet the start waits for the connect burst to land, ms. */
export const LIVE_SETTLE_MS = 300;
/** An excess smaller than this isn't worth a cut, ms. */
export const LIVE_CATCH_UP_MIN_MS = 200;
/** An excess this large is dropped even without a break to hide it, ms. */
export const LIVE_LIMIT_MS = 3_000;
/** The most the queue holds, whatever happens, ms (about 1.9 MB at 510 kbps). */
export const LIVE_CAP_MS = 30_000;
/** The queue counts as run dry once it has been empty this long (one frame is normal), ms. */
const GAP_AFTER_MS = 2 * FRAME_MS;
/** After the start or a gap, how long to wait for late audio before the second look, ms (plus a chunk). */
const AFTER_GAP_MS = 1_000;
/** The drift estimate needs this long a steady stretch, ms. */
const DRIFT_SPAN_MS = 10 * 60_000;

export type CatchUpReason = 'start' | 'settle' | 'gap' | 'resume' | 'limit' | 'cap';

export interface LiveCatchUp {
  reason: CatchUpReason;
  /** Audio dropped, ms. */
  droppedMs: number;
  /** The cushion kept, ms. */
  cushionMs: number;
}

export interface LiveQueueStats {
  /** Audio waiting to be sent: how far behind the newest packet received playback is, ms. */
  depthMs: number;
  /** The lowest the queue went over the last few seconds, ms (null until measured). */
  floorMs: number | null;
  /** The cushion this stream keeps: its chunk plus its margin, ms. */
  cushionMs: number;
  /** Dropped at the start (the connect burst), ms. */
  startDroppedMs: number;
  /** Dropped since, to stay live, ms, and how many times. */
  caughtUpMs: number;
  catchUps: number;
  /** Times the queue ran dry (network gaps). */
  gaps: number;
  /** How much faster (+) or slower (-) the station's clock runs than ours, ppm (null until known). */
  driftPpm: number | null;
}

export interface LiveQueueOptions {
  /**
   * How much audio arrives in one go, ms: an HLS segment's length (the playlist's target duration),
   * at most LIVE_CHUNK_MAX_MS; 0 or absent for a continuous stream.
   */
  chunkMs?: number;
  /** Told about every catch-up, for the log. */
  onCatchUp?: (event: LiveCatchUp) => void;
  now?: () => number;
  /** The bookkeeping timer's period, ms (tests drive `tick()` themselves with 0). */
  tickMs?: number;
}

export class LiveQueue extends Readable {
  readonly #now: () => number;
  readonly #onCatchUp: ((event: LiveCatchUp) => void) | undefined;
  readonly #chunkMs: number;
  #marginMs = LIVE_CUSHION_MS;
  /** Packets not yet handed to the player: #packets[#head] onwards. */
  #packets: Buffer[] = [];
  #head = 0;
  #started = false;
  #firstAt: number | null = null;
  /** Before the start: audio received, and how far it ran ahead of real time at most, and when. */
  #receivedMs = 0;
  #aheadMs = Number.NEGATIVE_INFINITY;
  #aheadAt = 0;
  #ended = false;
  /** The player asked for a packet and none was there. */
  #wanting = false;
  #emptySince: number | null = null;
  /** After a gap: waiting for the cushion to build up again before playing on. */
  #refilling = false;
  #catchUpAt: number | null = null;
  #catchUpReason: 'settle' | 'gap' = 'gap';
  #lastGapAt: number;
  /** The lowest depth this second, and the lows of the last few seconds (the floor). */
  #secondLow = Number.POSITIVE_INFINITY;
  readonly #lows: number[] = [];
  readonly #window: number;
  #anchor: { at: number; floorMs: number } | null = null;
  #driftPpm: number | null = null;
  #startDroppedMs = 0;
  #caughtUpMs = 0;
  #catchUps = 0;
  #gaps = 0;
  readonly #timer: NodeJS.Timeout | null;

  constructor(options: LiveQueueOptions = {}) {
    super({ objectMode: true, highWaterMark: 1 });
    this.#now = options.now ?? Date.now;
    this.#onCatchUp = options.onCatchUp;
    this.#chunkMs = Math.min(LIVE_CHUNK_MAX_MS, Math.max(0, Math.round(options.chunkMs ?? 0)));
    // The floor looks back far enough to see past HLS's segment-sized deliveries.
    this.#window = Math.max(3, Math.ceil((2 * this.#chunkMs + 1000) / 1000));
    this.#lastGapAt = this.#now();
    const tickMs = options.tickMs ?? 1_000;
    this.#timer = tickMs > 0 ? setInterval(() => this.tick(), tickMs) : null;
    this.#timer?.unref?.();
  }

  /** The cushion: the chunk plus the margin, ms. */
  get #cushionMs(): number {
    return this.#chunkMs + this.#marginMs;
  }

  /** Packets waiting, including the one the stream holds for the player. */
  get #count(): number {
    return this.#packets.length - this.#head + this.readableLength;
  }

  /** Adds one Opus packet as it arrives. Constant time. */
  add(packet: Buffer): void {
    if (this.destroyed || this.#ended) return;
    this.#packets.push(packet);
    const now = this.#now();
    if (!this.#started) {
      this.#firstAt ??= now;
      // How far the audio received runs ahead of the time since the first packet: it climbs while
      // the burst lands and levels off once audio arrives at the station's pace.
      this.#receivedMs += FRAME_MS;
      const ahead = this.#receivedMs - (now - this.#firstAt);
      if (ahead > this.#aheadMs + 2 * FRAME_MS) {
        this.#aheadMs = ahead;
        this.#aheadAt = now;
      }
      // An outsized burst: its oldest packet would go at the start anyway, and memory stays bounded.
      if (this.#count * FRAME_MS > LIVE_CAP_MS) this.#startDroppedMs += this.#drop(1);
      this.#maybeStart(now);
      return;
    }
    if (this.#emptySince !== null) {
      if (now - this.#emptySince >= GAP_AFTER_MS) this.#gapEnded(now);
      this.#emptySince = null;
    }
    if (this.#refilling) {
      // After a gap, play on only with the margin back in hand (for HLS, the next segment brings
      // it): the listener is hearing the gap anyway, and carrying on from an empty queue would leave
      // every later hiccup audible. The margin is at most 3 s, so the cap can't be reached here.
      if (this.#count * FRAME_MS < this.#marginMs) return;
      this.#refilling = false;
      // The level climbed during the refill for no reason the clocks explain: measure afresh.
      this.#resetLevel();
      // Refilled: if the server sent what it held back, the excess goes now, inside the same gap.
      this.#catchUp('gap');
    }
    if (this.#wanting) {
      this.#wanting = false;
      this.#pushNext();
    }
    if (this.#count * FRAME_MS > LIVE_CAP_MS) this.#catchUp('cap');
  }

  /** No more packets: the stream ends once the player has the rest. */
  finish(): void {
    if (this.#ended || this.destroyed) return;
    this.#ended = true;
    this.#refilling = false;
    if (!this.#started) this.#start(this.#now(), false);
    if (this.#wanting) {
      this.#wanting = false;
      this.#pushNext();
    }
  }

  /**
   * The listener has just heard a break (a voice resume): drop the audio that piled up past the
   * cushion now, where the cut is hidden. Returns the audio dropped, ms.
   */
  catchUp(reason: 'resume'): number {
    if (!this.#started) return 0;
    // The break unsettles the level whether or not enough piled up to drop: measure it afresh.
    this.#resetLevel();
    return this.#catchUp(reason);
  }

  /** The once-a-second bookkeeping: start, floor, drift, the cushion's easing, catch-ups. */
  tick(): void {
    if (this.destroyed) return;
    const now = this.#now();
    if (!this.#started) {
      this.#maybeStart(now);
      return;
    }
    // Refilling after a gap: nothing plays, so the level says nothing yet.
    if (this.#refilling) return;
    const depth = this.#count * FRAME_MS;
    this.#lows.push(Math.min(this.#secondLow, depth));
    if (this.#lows.length > this.#window) this.#lows.shift();
    this.#secondLow = depth;
    const floor = this.#floor();
    if (floor !== null) {
      if (this.#anchor === null) this.#anchor = { at: now, floorMs: floor };
      else if (now - this.#anchor.at >= DRIFT_SPAN_MS)
        this.#driftPpm = Math.round(((floor - this.#anchor.floorMs) / (now - this.#anchor.at)) * 1e6);
    }
    if (this.#marginMs > LIVE_CUSHION_MS && now - this.#lastGapAt >= LIVE_EASE_AFTER_MS) {
      // Calm for half an hour: keep less in hand. The surplus goes at the next catch-up.
      this.#marginMs = Math.max(LIVE_CUSHION_MS, this.#marginMs - LIVE_CUSHION_STEP_MS);
      this.#lastGapAt = now;
    }
    if (this.#catchUpAt !== null && now >= this.#catchUpAt) {
      this.#catchUpAt = null;
      this.#catchUp(this.#catchUpReason);
    } else if (floor !== null && floor - this.#marginMs >= LIVE_LIMIT_MS) {
      // The floor is the lowest point between deliveries: the margin, when nothing has piled up.
      this.#catchUp('limit');
    }
  }

  stats(): LiveQueueStats {
    return {
      depthMs: this.#count * FRAME_MS,
      floorMs: this.#floor(),
      cushionMs: this.#cushionMs,
      startDroppedMs: this.#startDroppedMs,
      caughtUpMs: this.#caughtUpMs,
      catchUps: this.#catchUps,
      gaps: this.#gaps,
      driftPpm: this.#driftPpm,
    };
  }

  override _read(): void {
    if (!this.#started || this.#refilling) {
      this.#wanting = true;
      return;
    }
    this.#secondLow = Math.min(this.#secondLow, this.#count * FRAME_MS);
    if (this.#packets.length > this.#head) {
      this.#pushNext();
      return;
    }
    if (this.#ended) {
      this.push(null);
      return;
    }
    this.#wanting = true;
    this.#emptySince ??= this.#now();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#packets = [];
    this.#head = 0;
    callback(error);
  }

  #floor(): number | null {
    if (this.#lows.length < this.#window) return null;
    let low = Number.POSITIVE_INFINITY;
    for (const value of this.#lows) if (value < low) low = value;
    return low;
  }

  /**
   * Starts once the connect burst has landed: the settle period has passed, audio has stopped
   * arriving faster than real time for a while (0.2 s, or 1 s when it comes a segment at a time,
   * with a fetch between segments), and the cushion is in hand. Starting in the middle of the burst
   * would trim too early and leave the rest of it to the second look, an audible jump.
   */
  #maybeStart(now: number): void {
    if (this.#firstAt === null || now - this.#firstAt < LIVE_SETTLE_MS) return;
    if (now - this.#aheadAt < (this.#chunkMs > 0 ? 1_000 : 200)) return;
    if (this.#count * FRAME_MS >= this.#cushionMs) this.#start(now, true);
  }

  /** Starts playback at the cushion's distance from the newest packet: the rest of the burst goes. */
  #start(now: number, trim: boolean): void {
    this.#started = true;
    this.#lastGapAt = now;
    this.#secondLow = Number.POSITIVE_INFINITY;
    if (trim) this.#startDroppedMs += this.#drop(this.#count - this.#cushionMs / FRAME_MS);
    if (this.#startDroppedMs > 0) {
      this.#onCatchUp?.({ reason: 'start', droppedMs: this.#startDroppedMs, cushionMs: this.#cushionMs });
    }
    // A second look once any late part of the burst has landed (HLS fetches its first segments
    // one after another), so it can't stay on as extra delay.
    if (trim) this.#lookAgain(now, 'settle');
    if (this.#wanting) {
      this.#wanting = false;
      this.#pushNext();
    }
  }

  /** Schedules a catch-up once late audio has had time to land: a second, plus a chunk. */
  #lookAgain(now: number, reason: 'settle' | 'gap'): void {
    this.#catchUpAt = now + this.#chunkMs + AFTER_GAP_MS;
    this.#catchUpReason = reason;
  }

  /** The queue ran dry and has audio again: keep more in hand, and catch up once the backlog lands. */
  #gapEnded(now: number): void {
    this.#gaps++;
    this.#lastGapAt = now;
    this.#marginMs = Math.min(LIVE_CUSHION_MAX_MS, this.#marginMs + LIVE_CUSHION_STEP_MS);
    this.#refilling = true;
    // A backlog that lands later than the refill is caught by a second look.
    this.#lookAgain(now, 'gap');
    // The level after a gap says nothing about the clocks: the floor and the drift start again.
    this.#resetLevel();
  }

  #catchUp(reason: CatchUpReason): number {
    const excess = this.#count * FRAME_MS - this.#cushionMs;
    if (excess < LIVE_CATCH_UP_MIN_MS && reason !== 'cap') return 0;
    const dropped = this.#drop(Math.floor(excess / FRAME_MS));
    if (dropped === 0) return 0;
    this.#caughtUpMs += dropped;
    this.#catchUps++;
    // The floor and the drift estimate start again from the new level.
    this.#resetLevel();
    this.#onCatchUp?.({ reason, droppedMs: dropped, cushionMs: this.#cushionMs });
    return dropped;
  }

  /** Forgets the floor and the drift anchor: the level has moved for a reason other than the clocks. */
  #resetLevel(): void {
    this.#lows.length = 0;
    this.#secondLow = Number.POSITIVE_INFINITY;
    this.#anchor = null;
  }

  /** Drops the oldest `n` waiting packets (never the one the stream already holds). Returns ms. */
  #drop(n: number): number {
    const available = this.#packets.length - this.#head;
    const count = Math.max(0, Math.min(Math.floor(n), available));
    // Free them now (a drop is rare, and at most LIVE_CAP_MS of packets), not at the next compaction.
    for (let i = this.#head; i < this.#head + count; i++) this.#packets[i] = undefined as unknown as Buffer;
    this.#head += count;
    this.#compact();
    return count * FRAME_MS;
  }

  #pushNext(): void {
    if (this.#packets.length > this.#head) {
      const packet = this.#packets[this.#head]!;
      this.#packets[this.#head] = undefined as unknown as Buffer;
      this.#head++;
      this.#compact();
      this.push(packet);
    } else if (this.#ended) this.push(null);
  }

  /** Reclaims the consumed front of the array now and then, so it can't grow without bound. */
  #compact(): void {
    if (this.#head > 1024 && this.#head * 2 > this.#packets.length) {
      this.#packets = this.#packets.slice(this.#head);
      this.#head = 0;
    }
  }
}

/**
 * Reads Ogg Opus from `source` into a new LiveQueue, eagerly (no back-pressure), so any backlog
 * builds up in the queue, where it is measured and kept small, not in the pipes before it.
 */
export function liveQueueFrom(source: Readable, options: LiveQueueOptions = {}): LiveQueue {
  const queue = new LiveQueue(options);
  const demuxer = new opus.OggDemuxer();
  demuxer.on('data', (packet: Buffer) => queue.add(packet));
  demuxer.once('end', () => queue.finish());
  const fail = (error: Error) => queue.destroy(error);
  demuxer.once('error', fail);
  source.once('error', fail);
  source.pipe(demuxer);
  queue.once('close', () => {
    source.unpipe(demuxer);
    demuxer.destroy();
    source.destroy();
  });
  return queue;
}
