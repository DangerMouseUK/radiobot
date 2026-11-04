import { constants, setPriority } from 'node:os';
import { isMainThread } from 'node:worker_threads';

export interface LowerThreadPriorityDeps {
  platform?: NodeJS.Platform;
  isMainThread?: boolean;
  setPriority?: (pid: number, priority: number) => void;
}

/**
 * Called first thing in a worker thread: gives that thread the lowest scheduling priority, so on
 * a one-core host its work (checking a pack, parsing a list, a WAL checkpoint) waits for the
 * thread that sends voice packets rather than competing with it.
 *
 * Linux only. There a thread has a priority of its own, and `setPriority(0, …)` (setpriority with
 * PRIO_PROCESS and 0) sets the calling thread's alone. Elsewhere the same call would lower the
 * whole process, the voice thread included, so it does nothing. Never on the main thread either,
 * and never throws: a host that refuses only means the worker runs at normal priority.
 * Returns whether the priority was lowered.
 */
export function lowerThreadPriority(deps: LowerThreadPriorityDeps = {}): boolean {
  const platform = deps.platform ?? process.platform;
  const main = deps.isMainThread ?? isMainThread;
  if (platform !== 'linux' || main) return false;
  try {
    // PRIORITY_LOW is Node's lowest (nice 19).
    (deps.setPriority ?? setPriority)(0, constants.priority.PRIORITY_LOW);
    return true;
  } catch {
    return false;
  }
}
