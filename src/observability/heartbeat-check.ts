import { readFileSync } from 'node:fs';
import type { HealthSnapshot } from './health.ts';

/**
 * Reads the heartbeat file and says whether the bot is healthy. Kept apart from `health.ts`, whose
 * diagnostics server needs the logger (and pino), so `scripts/healthcheck.ts` loads nothing else.
 * `scripts/healthcheck.sh` (the image's HEALTHCHECK) applies the same rules without starting Node;
 * change both together.
 */
export function checkHeartbeat(path: string, maxAgeMs = 90_000): { healthy: boolean; reason: string } {
  try {
    const snap = JSON.parse(readFileSync(path, 'utf8')) as HealthSnapshot;
    const age = Date.now() - Date.parse(snap.at);
    if (!(age >= 0 && age <= maxAgeMs))
      return { healthy: false, reason: `heartbeat is ${Math.round(age / 1000)} s old` };
    if (!snap.dbOk) return { healthy: false, reason: 'database check failed' };
    if (!snap.discordReady) return { healthy: false, reason: 'not connected to Discord' };
    if (snap.ffmpegOk === false) return { healthy: false, reason: 'ffmpeg unavailable or missing libopus' };
    return { healthy: true, reason: 'ok' };
  } catch {
    return { healthy: false, reason: 'no heartbeat file' };
  }
}
