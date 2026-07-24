import Database from 'better-sqlite3';

/** Open (or create) the database and make sure the schema exists. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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

  return db;
}
