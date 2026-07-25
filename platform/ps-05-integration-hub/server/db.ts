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
      CREATE TABLE IF NOT EXISTS connections (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        provider              TEXT    NOT NULL,
        name                  TEXT    NOT NULL,
        status                TEXT    NOT NULL DEFAULT 'connected'
                              CHECK (status IN ('connected','disconnected','error')),
        credentials_encrypted TEXT    NOT NULL,   -- AES-256-GCM; never returned
        scopes                TEXT    NOT NULL DEFAULT '',
        external_account      TEXT,
        expires_at            TEXT,
        created_at            TEXT    NOT NULL,
        updated_at            TEXT    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS connection_events (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        type          TEXT    NOT NULL
                      CHECK (type IN ('connected','refreshed','revoked','error')),
        meta          TEXT    NOT NULL DEFAULT '{}',
        created_at    TEXT    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        provider        TEXT    NOT NULL,
        connection_id   INTEGER REFERENCES connections(id),
        event_type      TEXT,
        signature_valid INTEGER NOT NULL,
        payload         TEXT    NOT NULL,
        status          TEXT    NOT NULL DEFAULT 'received'
                        CHECK (status IN ('received','processed','ignored')),
        received_at     TEXT    NOT NULL,
        processed_at    TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_jobs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        kind          TEXT    NOT NULL,
        status        TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','running','done','failed')),
        cursor        TEXT,
        records       INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT    NOT NULL,
        updated_at    TEXT    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS oauth_states (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        provider   TEXT    NOT NULL,
        state      TEXT    NOT NULL UNIQUE,
        name       TEXT,
        created_at TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_connections_provider ON connections(provider);
      CREATE INDEX IF NOT EXISTS idx_conn_events          ON connection_events(connection_id, created_at, id);
      CREATE INDEX IF NOT EXISTS idx_webhook_events       ON webhook_events(provider, received_at, id);
    `);
    },
  },
  {
    id: 2,
    name: 'sync_jobs-records',
    up(db) {
      const cols = db.prepare("PRAGMA table_info('sync_jobs')").all() as { name: string }[];
      if (!cols.some((c) => c.name === 'records')) db.exec('ALTER TABLE sync_jobs ADD COLUMN records INTEGER NOT NULL DEFAULT 0');
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
