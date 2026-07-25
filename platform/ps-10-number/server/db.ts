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
      CREATE TABLE IF NOT EXISTS sequences (
        scope      TEXT PRIMARY KEY,
        format     TEXT NOT NULL,
        period     TEXT NOT NULL DEFAULT 'none'
                   CHECK (period IN ('none','year','month','day')),
        created_at TEXT NOT NULL
      );

      -- One gapless counter per (scope, period_key). A new period key restarts
      -- the count at 1; within a period the sequence is gapless.
      CREATE TABLE IF NOT EXISTS counters (
        scope      TEXT NOT NULL,
        period_key TEXT NOT NULL,
        last_seq   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (scope, period_key)
      );
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
