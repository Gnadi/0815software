import Database from 'better-sqlite3';

/** Open (or create) the database and make sure the schema exists. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_intents (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id       TEXT    NOT NULL UNIQUE,   -- e.g. "pi_<hex>"
      reference       TEXT    NOT NULL,          -- the caller's own reference
      provider        TEXT    NOT NULL DEFAULT 'mock',
      amount_minor    INTEGER NOT NULL,          -- integer minor units (cents)
      currency        TEXT    NOT NULL,
      idempotency_key TEXT    UNIQUE,
      created_at      TEXT    NOT NULL
    );

    -- Append-only: the intent's status is folded from this stream at read time.
    CREATE TABLE IF NOT EXISTS intent_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      intent_id    INTEGER NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
      type         TEXT    NOT NULL,             -- created|processing|succeeded|failed|refunded|canceled
      amount_minor INTEGER,                      -- set for refunded events
      meta         TEXT    NOT NULL DEFAULT '{}',
      created_at   TEXT    NOT NULL
    );

    -- Append-only money movements per intent (credit on capture, debit on refund).
    CREATE TABLE IF NOT EXISTS ledger_entries (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      intent_id    INTEGER NOT NULL REFERENCES payment_intents(id) ON DELETE CASCADE,
      direction    TEXT    NOT NULL CHECK (direction IN ('credit','debit')),
      amount_minor INTEGER NOT NULL,
      reason       TEXT    NOT NULL,
      created_at   TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_events (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      provider         TEXT    NOT NULL,
      event_type       TEXT,
      intent_public_id TEXT,
      signature_valid  INTEGER NOT NULL,
      payload          TEXT    NOT NULL,
      received_at      TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_intent_events  ON intent_events(intent_id, id);
    CREATE INDEX IF NOT EXISTS idx_ledger_intent  ON ledger_entries(intent_id, id);
    CREATE INDEX IF NOT EXISTS idx_webhook_intent ON webhook_events(intent_public_id, id);
  `);

  return db;
}
