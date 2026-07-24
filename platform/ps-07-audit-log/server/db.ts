import Database from 'better-sqlite3';

/** Open (or create) the database and make sure the schema exists. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      actor       TEXT    NOT NULL,
      org         TEXT,
      action      TEXT    NOT NULL,
      resource    TEXT    NOT NULL,
      before_json TEXT    NOT NULL DEFAULT 'null',
      after_json  TEXT    NOT NULL DEFAULT 'null',
      metadata    TEXT    NOT NULL DEFAULT '{}',
      prev_hash   TEXT,                          -- hash of the previous row
      hash        TEXT    NOT NULL,              -- hash of this row + prev_hash
      recorded_at TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_actor    ON audit_events(actor, id);
    CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_events(resource, id);
    CREATE INDEX IF NOT EXISTS idx_audit_action   ON audit_events(action, id);
    CREATE INDEX IF NOT EXISTS idx_audit_org      ON audit_events(org, id);
  `);

  return db;
}
