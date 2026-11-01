/**
 * Jittered backoff schedule. Defaults follow PRD §9.2: roughly 1 s, 3 s, 8 s, then the
 * caller escalates to failover.
 */
export function backoffDelayMs(
  attempt: number,
  schedule: readonly number[] = [1_000, 3_000, 8_000],
  jitterRatio = 0.25,
  random: () => number = Math.random,
): number {
  const base = schedule[Math.min(Math.max(0, attempt), schedule.length - 1)] ?? 1_000;
  const jitter = base * jitterRatio * (random() * 2 - 1);
  return Math.max(0, Math.round(base + jitter));
}

/** Cooldown after a source has been circuit-broken: 10 min doubling up to 2 h. */
export function cooldownMs(consecutiveTrips: number): number {
  const base = 10 * 60_000;
  return Math.min(base * 2 ** Math.max(0, consecutiveTrips - 1), 2 * 60 * 60_000);
}
