import Database from 'better-sqlite3';

/** Open (or create) the database and make sure the schema exists. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_definitions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      key        TEXT    NOT NULL,
      version    INTEGER NOT NULL,
      name       TEXT    NOT NULL,
      definition TEXT    NOT NULL,          -- JSON: {initial, steps[], transitions{}, terminal[]}
      enabled    INTEGER NOT NULL DEFAULT 1,
      created_at TEXT    NOT NULL,
      UNIQUE (key, version)
    );

    CREATE TABLE IF NOT EXISTS triggers (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_key TEXT    NOT NULL,
      type         TEXT    NOT NULL
                   CHECK (type IN ('event', 'schedule', 'webhook', 'manual')),
      config       TEXT    NOT NULL DEFAULT '{}',
      enabled      INTEGER NOT NULL DEFAULT 1,
      last_run_at  TEXT,
      created_at   TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_instances (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_key     TEXT    NOT NULL,
      workflow_version INTEGER NOT NULL,
      trigger_id       INTEGER REFERENCES triggers(id),
      idempotency_key  TEXT,
      input            TEXT    NOT NULL DEFAULT '{}',
      created_at       TEXT    NOT NULL,
      UNIQUE (workflow_key, idempotency_key)
    );

    CREATE TABLE IF NOT EXISTS workflow_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      instance_id INTEGER NOT NULL REFERENCES workflow_instances(id) ON DELETE CASCADE,
      type        TEXT    NOT NULL
                  CHECK (type IN ('created', 'step_entered', 'step_completed',
                                  'step_failed', 'completed', 'failed')),
      payload     TEXT    NOT NULL DEFAULT '{}',
      created_at  TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhooks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT    NOT NULL,
      url        TEXT    NOT NULL,
      secret     TEXT    NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1,
      created_at TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS webhook_deliveries (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      webhook_id      INTEGER NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
      event_type      TEXT    NOT NULL,
      payload         TEXT    NOT NULL,
      status          TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'delivered', 'failed', 'dead')),
      attempts        INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT    NOT NULL,
      last_error      TEXT,
      response_status INTEGER,
      created_at      TEXT    NOT NULL,
      updated_at      TEXT    NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_wf_events_instance  ON workflow_events(instance_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_deliveries_due      ON webhook_deliveries(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_triggers_type       ON triggers(type, enabled);
    CREATE INDEX IF NOT EXISTS idx_instances_key       ON workflow_instances(workflow_key);
  `);

  return db;
}
