import { constants } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { lowerThreadPriority } from '../../src/shared/lower-thread-priority.ts';

describe('lowerThreadPriority', () => {
  it('lowers a worker thread to the lowest priority on Linux', () => {
    const setPriority = vi.fn();
    expect(lowerThreadPriority({ platform: 'linux', isMainThread: false, setPriority })).toBe(true);
    // 0: the calling thread alone, on Linux.
    expect(setPriority).toHaveBeenCalledWith(0, constants.priority.PRIORITY_LOW);
  });

  it('does nothing on other platforms, where it would lower the whole process', () => {
    const setPriority = vi.fn();
    for (const platform of ['win32', 'darwin', 'freebsd'] as const)
      expect(lowerThreadPriority({ platform, isMainThread: false, setPriority })).toBe(false);
    expect(setPriority).not.toHaveBeenCalled();
  });

  it('never lowers the main thread, which sends the voice packets', () => {
    const setPriority = vi.fn();
    expect(lowerThreadPriority({ platform: 'linux', isMainThread: true, setPriority })).toBe(false);
    // Tests run on a main thread, so the defaults leave it alone too.
    expect(lowerThreadPriority({ platform: 'linux', setPriority })).toBe(false);
    expect(setPriority).not.toHaveBeenCalled();
  });

  it('carries on at normal priority when the host refuses', () => {
    const setPriority = vi.fn(() => {
      throw new Error('EACCES');
    });
    expect(lowerThreadPriority({ platform: 'linux', isMainThread: false, setPriority })).toBe(false);
    expect(lowerThreadPriority()).toBe(false);
  });
});
