import Database from 'better-sqlite3';
import { runMigrations, type Migration } from './migrations.js';

/**
 * Ordered schema migrations. 001 is the v1 baseline — idempotent
 * `CREATE TABLE IF NOT EXISTS`, so databases created before the runner adopt
 * it cleanly. Never edit a shipped migration; append a new one instead.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'baseline',
    up(db) {
      db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        actor       TEXT    NOT NULL,
        org         TEXT,
        action      TEXT    NOT NULL,
        resource    TEXT    NOT NULL,
        before_json TEXT    NOT NULL DEFAULT 'null',
        after_json  TEXT    NOT NULL DEFAULT 'null',
        metadata    TEXT    NOT NULL DEFAULT '{}',
        prev_hash   TEXT,                          -- hash of the previous row
        hash        TEXT    NOT NULL,              -- hash of this row + prev_hash
        recorded_at TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_audit_actor    ON audit_events(actor, id);
      CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_events(resource, id);
      CREATE INDEX IF NOT EXISTS idx_audit_action   ON audit_events(action, id);
      CREATE INDEX IF NOT EXISTS idx_audit_org      ON audit_events(org, id);
    `);
    },
  },
];

/** Open (or create) the database, apply pragmas, and run pending migrations. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db, MIGRATIONS);
  return db;
}
