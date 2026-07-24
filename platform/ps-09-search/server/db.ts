import Database from 'better-sqlite3';

/**
 * Open (or create) the database and make sure the schema exists.
 *
 * Search is backed by an FTS5 virtual table (bundled with better-sqlite3, no
 * external engine). `title`/`body` are indexed for full-text matching;
 * `collection`/`doc_id`/`tenant` are UNINDEXED columns we filter on. Facets
 * live in a side table so they can be filtered and counted.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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

  return db;
}
