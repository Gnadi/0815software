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
      CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
        collection UNINDEXED,
        doc_id     UNINDEXED,
        tenant     UNINDEXED,
        title,
        body,
        tokenize = 'porter unicode61'
      );

      CREATE TABLE IF NOT EXISTS facets (
        rowid_ref INTEGER NOT NULL,          -- search.rowid of the owning document
        key       TEXT    NOT NULL,
        value     TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_facets_ref ON facets(rowid_ref);
      CREATE INDEX IF NOT EXISTS idx_facets_kv  ON facets(key, value);
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
