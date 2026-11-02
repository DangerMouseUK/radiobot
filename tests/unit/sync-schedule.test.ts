import { afterEach, describe, expect, it, vi } from 'vitest';
import { scheduleCatalogueSyncs } from '../../src/catalogue/sync-schedule.ts';

afterEach(() => {
  vi.useRealTimers();
});

const HOUR = 3_600_000;

describe('catalogue sync schedule', () => {
  it('keeps one pending timer per pack however many times it has run', async () => {
    vi.useFakeTimers();
    const runs: string[] = [];
    const schedule = scheduleCatalogueSyncs({
      packIds: ['a', 'b'],
      intervalMs: 6 * HOUR,
      lastSync: () => null,
      sync: async (id) => {
        runs.push(id);
      },
      random: () => 0,
    });
    expect(schedule.pending()).toBe(2);
    // Never synced: about 10 minutes after start, then every interval.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runs).toEqual(['a', 'b']);
    await vi.advanceTimersByTimeAsync(5 * 6 * HOUR);
    expect(runs).toHaveLength(12);
    expect(schedule.pending()).toBe(2);
    expect(vi.getTimerCount()).toBe(2);
    schedule.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits the full interval when it is longer than one Node timer can wait', async () => {
    vi.useFakeTimers();
    const runs: number[] = [];
    const schedule = scheduleCatalogueSyncs({
      packIds: ['a'],
      intervalMs: 720 * HOUR,
      lastSync: () => new Date().toISOString(),
      sync: async () => {
        runs.push(Date.now());
      },
      random: () => 0,
    });
    await vi.advanceTimersByTimeAsync(719 * HOUR);
    expect(runs).toEqual([]);
    await vi.advanceTimersByTimeAsync(HOUR);
    expect(runs).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(719 * HOUR);
    expect(runs).toHaveLength(1);
    expect(schedule.pending()).toBe(1);
    schedule.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('waits until a pack is due, but at least a minute', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-01-01T12:00:00Z') });
    const runs: string[] = [];
    const schedule = scheduleCatalogueSyncs({
      packIds: ['recent', 'overdue'],
      intervalMs: 6 * HOUR,
      lastSync: (id) => (id === 'recent' ? '2026-01-01T10:00:00Z' : '2025-12-01T00:00:00Z'),
      sync: async (id) => {
        runs.push(id);
      },
      random: () => 0,
    });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runs).toEqual(['overdue']);
    await vi.advanceTimersByTimeAsync(4 * HOUR - 60_000);
    expect(runs).toEqual(['overdue', 'recent']);
    schedule.stop();
  });

  it('schedules nothing more after stop, even from a sync that was still running', async () => {
    vi.useFakeTimers();
    let finish: () => void = () => {};
    const schedule = scheduleCatalogueSyncs({
      packIds: ['a'],
      intervalMs: HOUR,
      lastSync: () => null,
      sync: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      random: () => 0,
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    schedule.stop();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(schedule.pending()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
