import Database from 'better-sqlite3';

/** Open (or create) the database and make sure the schema exists. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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

  return db;
}
