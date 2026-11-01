import { describe, expect, it } from 'vitest';
import { latePacketsLine } from '../../src/discord/ui/format.ts';
import { setPacketTiming, timePackets } from '../../src/voice/link.ts';
import { PacketTiming } from '../../src/voice/packet-timing.ts';

/** Sends a packet at each of the given times (ms). */
function sendAt(timing: PacketTiming, clock: { t: number }, times: number[]): void {
  for (const t of times) {
    clock.t = t;
    timing.sent();
  }
}

describe('packet timing', () => {
  it('counts packets sent more than 40 ms after the one before and keeps the longest gap', () => {
    const clock = { t: 0 };
    const timing = new PacketTiming(() => clock.t);
    expect(timing.summary()).toEqual({ late: 0, worstGapMs: null });
    // Steady 20 ms, a 60 ms stall, then the catch-up burst.
    sendAt(timing, clock, [0, 20, 40, 60, 120, 121, 122, 140, 160]);
    expect(timing.summary()).toEqual({ late: 1, worstGapMs: 60 });
    sendAt(timing, clock, [205]);
    expect(timing.summary()).toEqual({ late: 2, worstGapMs: 60 });
  });

  it('does not count the gap across a pause or a reconnect', () => {
    const clock = { t: 0 };
    const timing = new PacketTiming(() => clock.t);
    sendAt(timing, clock, [0, 20]);
    timing.pause();
    sendAt(timing, clock, [5_000, 5_020]);
    expect(timing.summary()).toEqual({ late: 0, worstGapMs: 20 });
  });

  it('times the packets a connection actually sends, for the link using it', () => {
    let sends = [true, false, true];
    const connection = { dispatchAudio: () => sends.shift() ?? false };
    const clock = { t: 0 };
    const first = new PacketTiming(() => clock.t);
    timePackets(connection);
    timePackets(connection); // wrapped once only
    setPacketTiming(connection, first);
    clock.t = 0;
    expect(connection.dispatchAudio()).toBe(true);
    clock.t = 20;
    expect(connection.dispatchAudio()).toBe(false); // nothing prepared, nothing timed
    clock.t = 100;
    expect(connection.dispatchAudio()).toBe(true);
    expect(first.summary()).toEqual({ late: 1, worstGapMs: 100 });
    // A newer link on the same connection takes over the timing.
    const second = new PacketTiming(() => clock.t);
    setPacketTiming(connection, second);
    sends = [true];
    connection.dispatchAudio();
    expect(first.summary().late).toBe(1);
    expect(second.summary()).toEqual({ late: 0, worstGapMs: null });
  });

  it('describes the count in /radio stats', () => {
    expect(latePacketsLine(undefined, undefined)).toBe('Late packets: —');
    expect(latePacketsLine(0, 21)).toBe(
      'Late packets (over 40 ms apart) since joining: 0 · longest gap 21 ms',
    );
    expect(latePacketsLine(3, 60)).toMatch(/: 3 · longest gap 60 ms \(long enough to be heard\)$/);
  });
});
