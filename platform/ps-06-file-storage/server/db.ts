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
      CREATE TABLE IF NOT EXISTS buckets (
        name       TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS objects (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        bucket       TEXT    NOT NULL REFERENCES buckets(name) ON DELETE CASCADE,
        key          TEXT    NOT NULL,
        content_type TEXT    NOT NULL DEFAULT 'application/octet-stream',
        size         INTEGER NOT NULL,
        sha256       TEXT    NOT NULL,
        metadata     TEXT    NOT NULL DEFAULT '{}',
        content      BLOB    NOT NULL,
        created_at   TEXT    NOT NULL,
        updated_at   TEXT    NOT NULL,
        UNIQUE (bucket, key)
      );

      CREATE INDEX IF NOT EXISTS idx_objects_bucket ON objects(bucket, key);
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
