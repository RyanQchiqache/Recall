import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { LATEST_SCHEMA_VERSION, MIGRATIONS } from './migrations.ts';

export type DB = Database.Database;

export interface OpenOptions {
  /** Directory for the automatic pre-migration snapshot. */
  snapshotDir?: string;
  now?: () => Date;
  log?: (msg: string) => void;
}

export function currentSchemaVersion(db: DB): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}

export function snapshotFileName(prefix: string, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return `${prefix}-${stamp}.sqlite`;
}

export async function openDatabase(dbPath: string, opts: OpenOptions = {}): Promise<DB> {
  const now = opts.now ?? (() => new Date());
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');

  const version = currentSchemaVersion(db);
  if (version > LATEST_SCHEMA_VERSION) {
    db.close();
    throw new Error(
      `The database at ${dbPath} uses schema version ${version}, which is newer than this app supports (${LATEST_SCHEMA_VERSION}). Update Recall instead of downgrading.`,
    );
  }
  const pending = MIGRATIONS.filter((m) => m.version > version);
  if (pending.length > 0 && version > 0 && opts.snapshotDir) {
    // Consistent online snapshot (SQLite backup API) before changing the schema.
    fs.mkdirSync(opts.snapshotDir, { recursive: true });
    const target = path.join(opts.snapshotDir, snapshotFileName(`pre-migration-v${version}`, now()));
    await db.backup(target);
    opts.log?.(`Created pre-migration snapshot ${target}`);
  }
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        now().toISOString(),
      );
    })();
    opts.log?.(`Applied migration ${m.version}: ${m.name}`);
  }
  return db;
}
