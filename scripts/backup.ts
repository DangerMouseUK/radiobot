/** Writes a consistent SQLite backup next to the database (data/backups/). */
import { existsSync } from 'node:fs';
import { constants, setPriority } from 'node:os';
import { Db } from '../src/persistence/db.ts';

// A backup can run while the bot plays: run at the lowest priority, so it never holds up the
// live encoder. Where that isn't permitted, it simply keeps normal priority.
try {
  setPriority(constants.priority.PRIORITY_LOW);
} catch {
  /* not permitted on this host */
}

const dbPath = process.env.DATABASE_PATH ?? './data/radio-bot.sqlite';
// Opening a missing file would create an empty database and back that up instead.
if (!existsSync(dbPath)) {
  process.stderr.write(`No database at ${dbPath}; check DATABASE_PATH.\n`);
  process.exit(1);
}
const db = new Db(dbPath);
const path = db.backup('manual', 10);
db.close();
process.stdout.write(`Backup written: ${path}\n`);
