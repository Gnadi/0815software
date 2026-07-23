import Database from 'better-sqlite3';

/** Open (or create) the database and make sure the schema exists. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS prompts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      key            TEXT    NOT NULL UNIQUE,
      name           TEXT    NOT NULL,
      active_version INTEGER NOT NULL DEFAULT 1,
      created_at     TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompt_versions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_id  INTEGER NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
      version    INTEGER NOT NULL,
      template   TEXT    NOT NULL,       -- JSON: [{role, content with {{vars}}}]
      notes      TEXT,
      created_at TEXT    NOT NULL,
      UNIQUE (prompt_id, version)
    );

    CREATE TABLE IF NOT EXISTS completions (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      provider          TEXT    NOT NULL,
      model             TEXT    NOT NULL,
      prompt_key        TEXT,
      request           TEXT    NOT NULL,
      response          TEXT    NOT NULL,
      prompt_tokens     INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      latency_ms        INTEGER,
      idempotency_key   TEXT UNIQUE,
      created_at        TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS embeddings (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      model      TEXT    NOT NULL,
      input_hash TEXT    NOT NULL,
      input      TEXT    NOT NULL,
      dims       INTEGER NOT NULL,
      vector     TEXT    NOT NULL,       -- JSON number[]
      created_at TEXT    NOT NULL,
      UNIQUE (model, input_hash)
    );

    CREATE TABLE IF NOT EXISTS rag_documents (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      collection TEXT    NOT NULL,
      text       TEXT    NOT NULL,
      embedding  TEXT    NOT NULL,       -- JSON number[]
      created_at TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_prompt_versions ON prompt_versions(prompt_id, version);
    CREATE INDEX IF NOT EXISTS idx_completions_at  ON completions(created_at, id);
    CREATE INDEX IF NOT EXISTS idx_rag_collection  ON rag_documents(collection);
  `);

  return db;
}
