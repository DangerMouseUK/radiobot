import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { dirname, join } from 'node:path';
import { type Logger, safeErr } from './logger.ts';

export { checkHeartbeat } from './heartbeat-check.ts';

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

/**
 * Atomically replaces the heartbeat file the Docker HEALTHCHECK reads (no network port needed):
 * written to a temporary file, then renamed over the old one. Asynchronous, so a slow disk never
 * holds up the thread that sends voice packets. Two writes to the same path must not overlap
 * (they share the temporary file); `HeartbeatWriter` takes care of that.
 */
export async function writeHeartbeat(path: string, snap: HealthSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(snap));
  await rename(tmp, path);
}

/**
 * Writes heartbeats one at a time. A heartbeat asked for while one is being written waits for it,
 * and if several are waiting only the newest is written. The promise settles once the heartbeat
 * asked for (or a newer one) is on disk; a failed write is passed to `onError`, never thrown.
 */
export class HeartbeatWriter {
  readonly #path: string;
  readonly #onError: (err: unknown) => void;
  #writing: Promise<void> | null = null;
  #next: HealthSnapshot | null = null;

  constructor(path: string, onError: (err: unknown) => void) {
    this.#path = path;
    this.#onError = onError;
  }

  write(snap: HealthSnapshot): Promise<void> {
    this.#next = snap;
    this.#writing ??= this.#drain();
    return this.#writing;
  }

  async #drain(): Promise<void> {
    try {
      for (let snap = this.#next; snap; snap = this.#next) {
        this.#next = null;
        try {
          await writeHeartbeat(this.#path, snap);
        } catch (err) {
          this.#onError(err);
        }
      }
    } finally {
      // Cleared in the same step as the last look at #next, so no heartbeat is ever left unwritten.
      this.#writing = null;
    }
  }
}

/**
 * Optional local-only diagnostics endpoint (PRD FR-014). Binds to 127.0.0.1 only and is not
 * published by the default Compose file. If it can't listen (say, the port is already in use),
 * it logs a warning and the bot carries on without it: an unhandled server error would otherwise
 * stop the bot, and a restart would only hit the same error again.
 */
export function startDiagnosticsServer(
  port: number,
  logger: Logger,
  snapshot: () => Record<string, unknown>,
): Server {
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
  server.on('error', (err) =>
    logger.warn({ port, err: safeErr(err) }, 'diagnostics endpoint unavailable; carrying on without it'),
  );
  server.listen(port, '127.0.0.1');
  return server;
}
