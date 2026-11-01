import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';

export interface HealthSnapshot {
  at: string;
  pid: number;
  discordReady: boolean;
  activeStreams: number;
  ffmpegProcesses: number;
  dbOk: boolean;
  /** FFmpeg was found with libopus. Missing in heartbeats from older versions, which counts as ok. */
  ffmpegOk?: boolean;
}

export function heartbeatPath(databasePath: string): string {
  return join(dirname(databasePath), 'health.json');
}

/** Atomically writes the heartbeat file the Docker HEALTHCHECK reads (no network port needed). */
export function writeHeartbeat(path: string, snap: HealthSnapshot): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(snap));
  renameSync(tmp, path);
}

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

/**
 * Optional local-only diagnostics endpoint (PRD FR-014). Binds to 127.0.0.1 only and is not
 * published by the default Compose file.
 */
export function startDiagnosticsServer(port: number, snapshot: () => Record<string, unknown>): Server {
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || (req.url !== '/healthz' && req.url !== '/diagnostics')) {
      res.writeHead(404).end();
      return;
    }
    const body = req.url === '/healthz' ? { ok: true } : snapshot();
    res
      .writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      .end(JSON.stringify(body));
  });
  server.listen(port, '127.0.0.1');
  return server;
}
