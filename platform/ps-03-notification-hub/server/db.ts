import Database from 'better-sqlite3';

/** Open (or create) the database and make sure the schema exists. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS channels (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT    NOT NULL
                 CHECK (type IN ('email','sms','push','slack','teams','discord','webhook')),
      name       TEXT    NOT NULL UNIQUE,
      provider   TEXT    NOT NULL DEFAULT 'console',
      config     TEXT    NOT NULL DEFAULT '{}',
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS templates (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      key          TEXT    NOT NULL,
      version      INTEGER NOT NULL,
      channel_type TEXT    NOT NULL,
      locale       TEXT    NOT NULL DEFAULT 'en',
      subject      TEXT,
      body         TEXT    NOT NULL,
      created_at   TEXT    NOT NULL,
      UNIQUE (key, version)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id          INTEGER NOT NULL REFERENCES channels(id),
      template_key        TEXT,
      to_address          TEXT    NOT NULL,
      subject             TEXT,
      body                TEXT    NOT NULL,
      variables           TEXT    NOT NULL DEFAULT '{}',
      status              TEXT    NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued','sent','failed','dead')),
      attempts            INTEGER NOT NULL DEFAULT 0,
      next_attempt_at     TEXT    NOT NULL,
      last_error          TEXT,
      provider_message_id TEXT,
      idempotency_key     TEXT UNIQUE,
      created_at          TEXT    NOT NULL,
      updated_at          TEXT    NOT NULL,
      sent_at             TEXT
    );

    CREATE TABLE IF NOT EXISTS message_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      type       TEXT    NOT NULL
                 CHECK (type IN ('queued','attempted','sent','failed','dead')),
      meta       TEXT    NOT NULL DEFAULT '{}',
      created_at TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_due      ON messages(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_message_events    ON message_events(message_id, created_at, id);
  `);

  return db;
}
