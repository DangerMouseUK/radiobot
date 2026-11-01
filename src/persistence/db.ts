import { createHash } from 'node:crypto';
import { chownSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { rootPath } from '../shared/paths.ts';

export type Row = Record<string, SQLInputValue>;
export type Params = Record<string, SQLInputValue> | SQLInputValue[];

export interface Migration {
  version: number;
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrationResult {
  applied: number[];
  backupPath: string | null;
}

const MIGRATION_FILE = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const MAX_CACHED_STATEMENTS = 500;

export function loadMigrations(dir = rootPath('migrations')): Migration[] {
  return readdirSync(dir)
    .filter((f) => MIGRATION_FILE.test(f))
    .sort()
    .map((file) => {
      const m = MIGRATION_FILE.exec(file)!;
      const sql = readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n');
      return {
        version: Number(m[1]),
        name: m[2]!,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

/**
 * When running as root, gives `paths` the owner of `reference`. A backup taken with sudo (say, under a
 * systemd DynamicUser) would otherwise leave root-owned files the service can't write to on its next
 * migration backup.
 */
export function matchOwner(
  reference: string,
  paths: string[],
  uid = process.getuid?.(),
  chown: (path: string, uid: number, gid: number) => void = chownSync,
): void {
  if (uid !== 0) return;
  const owner = statSync(reference);
  if (owner.uid === 0) return;
  for (const p of paths) chown(p, owner.uid, owner.gid);
}

/** Thin typed wrapper around node:sqlite with transactions and versioned migrations. */
export class Db {
  readonly raw: DatabaseSync;
  readonly path: string;
  #txDepth = 0;
  readonly #statements = new Map<string, StatementSync>();

  constructor(path: string) {
    this.path = path;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA foreign_keys = ON;');
    this.raw.exec('PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') {
      this.raw.exec('PRAGMA journal_mode = WAL;');
      this.raw.exec('PRAGMA synchronous = NORMAL;');
    }
  }

  /**
   * Compiling a statement costs more than running a small query, and views such as /radio stats run
   * one per station, all on the thread that sends voice packets. So statements are kept and reused.
   */
  #prepare(sql: string): StatementSync {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      // The SQL is almost all fixed text; the limit only guards against a caller that builds it.
      if (this.#statements.size >= MAX_CACHED_STATEMENTS) this.#statements.clear();
      stmt = this.raw.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  all<T = Row>(sql: string, params: Params = []): T[] {
    const stmt = this.#prepare(sql);
    return (Array.isArray(params) ? stmt.all(...params) : stmt.all(params)) as T[];
  }

  get<T = Row>(sql: string, params: Params = []): T | undefined {
    const stmt = this.#prepare(sql);
    return (Array.isArray(params) ? stmt.get(...params) : stmt.get(params)) as T | undefined;
  }

  run(sql: string, params: Params = []): { changes: number; lastInsertRowid: number } {
    const stmt = this.#prepare(sql);
    const r = Array.isArray(params) ? stmt.run(...params) : stmt.run(params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  /** Runs fn atomically; nested calls use savepoints. */
  transaction<T>(fn: () => T): T {
    const sp = `sp_${this.#txDepth}`;
    this.raw.exec(this.#txDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.#txDepth++;
    try {
      const result = fn();
      this.#txDepth--;
      this.raw.exec(this.#txDepth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      this.#txDepth--;
      this.raw.exec(this.#txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  /**
   * Applies pending migrations. Already-applied migrations must keep their checksum; an
   * edited migration aborts startup rather than silently diverging. When an existing
   * database is about to be migrated, a consistent backup is written first.
   */
  migrate(migrations: Migration[] = loadMigrations(), keepBackups = 5): MigrationResult {
    this.raw.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      checksum TEXT NOT NULL
    )`);
    const applied = new Map(
      this.all<{ version: number; checksum: string }>('SELECT version, checksum FROM schema_migrations').map(
        (r) => [r.version, r.checksum],
      ),
    );
    for (const m of migrations) {
      const sum = applied.get(m.version);
      if (sum && sum !== m.checksum) {
        throw new Error(
          `Migration ${m.version}_${m.name} was modified after being applied (checksum mismatch). ` +
            'Restore the original file; add a new migration instead.',
        );
      }
    }
    const known = new Set(migrations.map((m) => m.version));
    const unknown = [...applied.keys()].filter((v) => !known.has(v));
    if (unknown.length > 0) {
      throw new Error(
        `Database has migrations newer than this build (${unknown.join(', ')}). ` +
          'Refusing to start an older version against a newer schema; restore a backup or upgrade.',
      );
    }
    const pending = migrations.filter((m) => !applied.has(m.version));
    if (pending.length === 0) return { applied: [], backupPath: null };

    const backupPath = applied.size > 0 ? this.backup(`pre-v${pending[0]!.version}`, keepBackups) : null;
    for (const m of pending) {
      this.transaction(() => {
        this.raw.exec(m.sql);
        this.run('INSERT INTO schema_migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)', [
          m.version,
          m.name,
          new Date().toISOString(),
          m.checksum,
        ]);
      });
    }
    return { applied: pending.map((m) => m.version), backupPath };
  }

  schemaVersion(): number {
    const r = this.get<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations');
    return r?.v ?? 0;
  }

  /** Writes a consistent copy of the database (VACUUM INTO) and prunes old backups. */
  backup(label: string, keep = 5): string | null {
    if (this.path === ':memory:') return null;
    const dir = join(dirname(this.path), 'backups');
    mkdirSync(dir, { recursive: true });
    const stem = basename(this.path).replace(/\.sqlite$/, '');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = join(dir, `${stem}-${label}-${stamp}.sqlite`);
    this.raw.prepare('VACUUM INTO ?').run(target);
    matchOwner(this.path, [dir, target]);
    // Rotate per label class ("pre-vN" migration backups vs "manual") so one kind never evicts the other.
    const cls = label.replace(/\d+$/, '');
    const backups = readdirSync(dir)
      .filter((f) => f.startsWith(`${stem}-${cls}`) && f.endsWith('.sqlite'))
      .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => a.t - b.t)
      .map((x) => x.f);
    for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
      rmSync(join(dir, old), { force: true });
    }
    return target;
  }

  close(): void {
    if (this.raw.isOpen) this.raw.close();
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseJsonArray(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
