import Database from 'better-sqlite3';

/** Open (or create) the database and make sure the schema exists. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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
      created_at    TEXT    NOT NULL,
      updated_at    TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_connections_provider ON connections(provider);
    CREATE INDEX IF NOT EXISTS idx_conn_events          ON connection_events(connection_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_webhook_events       ON webhook_events(provider, received_at, id);
  `);

  return db;
}
