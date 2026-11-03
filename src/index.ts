import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './config/env.ts';
import { createLogger, safeErr } from './observability/logger.ts';

async function main(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`${err.message}\nSee .env.example and docs/install-docker.md.\n`);
      process.exit(78);
    }
    throw err;
  }
  const logger = createLogger(config.logLevel, [config.discordToken]);
  const app = createApp(config, logger);
  let stopping = false;
  const shutdown = async (reason: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    const force = setTimeout(() => process.exit(code || 1), 10_000);
    force.unref();
    try {
      await app.stop(reason);
    } finally {
      process.exit(code);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  // `radio-bot packs` sends SIGHUP after changing the installed packs: load them without a restart.
  process.on('SIGHUP', () => void app.reloadPacks());
  process.on('unhandledRejection', (err) => logger.error({ err: safeErr(err) }, 'unhandled rejection'));
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: safeErr(err) }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
  await app.start();
}

main().catch((err: unknown) => {
  process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
