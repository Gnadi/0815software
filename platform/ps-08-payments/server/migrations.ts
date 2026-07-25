import type Database from 'better-sqlite3';

/**
 * Minimal, dependency-free schema migration runner.
 *
 * Each service declares an ordered list of migrations in `db.ts`; applied ids
 * are recorded in `schema_migrations`, and `openDb` runs whatever is pending
 * inside a transaction. Migration 001 is the v1 baseline (idempotent
 * `CREATE TABLE IF NOT EXISTS`, so pre-runner databases adopt it cleanly);
 * later migrations guard their own `ALTER TABLE`s the same way. Rules:
 * ids are unique and ascending, and a shipped migration is never edited —
 * schema changes are always a NEW migration.
 */

export interface Migration {
  id: number;
  name: string;
  up(db: Database.Database): void;
}

function ensureTable(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id         INTEGER PRIMARY KEY,
       name       TEXT NOT NULL,
       applied_at TEXT NOT NULL
     )`,
  );
}

function validate(migrations: Migration[]): void {
  const seen = new Set<number>();
  let last = 0;
  for (const m of migrations) {
    if (!Number.isInteger(m.id) || m.id <= 0) throw new Error(`migration id must be a positive integer: ${m.id}`);
    if (seen.has(m.id)) throw new Error(`duplicate migration id: ${m.id}`);
    if (m.id <= last) throw new Error(`migrations must be declared in ascending order (at id ${m.id})`);
    seen.add(m.id);
    last = m.id;
  }
}

/** Apply every pending migration. Returns how many were applied. */
export function runMigrations(db: Database.Database, migrations: Migration[]): number {
  validate(migrations);
  ensureTable(db);
  const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?');
  const record = db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)');
  let applied = 0;
  for (const m of migrations) {
    if (isApplied.get(m.id)) continue;
    db.transaction(() => {
      m.up(db);
      record.run(m.id, m.name, new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'));
    })();
    applied++;
  }
  return applied;
}

/** How many declared migrations have not been applied (for readiness checks). */
export function pendingCount(db: Database.Database, migrations: Migration[]): number {
  ensureTable(db);
  const isApplied = db.prepare('SELECT 1 FROM schema_migrations WHERE id = ?');
  return migrations.filter((m) => !isApplied.get(m.id)).length;
}
