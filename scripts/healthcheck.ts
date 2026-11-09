/**
 * Reads the heartbeat file written by the bot. Exit 0 = healthy. Used by `radio-bot status`,
 * `pnpm healthcheck` and bare-metal installs; the Docker image's HEALTHCHECK runs
 * `scripts/healthcheck.sh` instead, which applies the same rules without starting Node.
 */
import { dirname, join } from 'node:path';
import { checkHeartbeat } from '../src/observability/heartbeat-check.ts';

const dbPath = process.env.DATABASE_PATH ?? './data/radio-bot.sqlite';
const result = checkHeartbeat(join(dirname(dbPath), 'health.json'));
process.stdout.write(`${result.healthy ? 'healthy' : 'unhealthy'}: ${result.reason}\n`);
process.exit(result.healthy ? 0 : 1);
