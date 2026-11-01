/** Docker HEALTHCHECK: reads the heartbeat file written by the bot. Exit 0 = healthy. */
import { dirname, join } from 'node:path';
import { checkHeartbeat } from '../src/observability/health.ts';

const dbPath = process.env.DATABASE_PATH ?? './data/radio-bot.sqlite';
const result = checkHeartbeat(join(dirname(dbPath), 'health.json'));
process.stdout.write(`${result.healthy ? 'healthy' : 'unhealthy'}: ${result.reason}\n`);
process.exit(result.healthy ? 0 : 1);
