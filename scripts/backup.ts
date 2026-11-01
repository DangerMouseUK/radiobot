/** Writes a consistent SQLite backup next to the database (data/backups/). */
import { existsSync } from 'node:fs';
import { Db } from '../src/persistence/db.ts';

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
