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
    },
  },
  {
    id: 2,
    name: 'person-notifications',
    up(db) {
      // server/notify.ts: devices, preferences, events addressed to a person,
      // and which digests went out. A digest row is claimed BEFORE it is
      // sent, so two overlapping ticks cannot both send the morning briefing.
      db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient    TEXT    NOT NULL,
        endpoint     TEXT    NOT NULL UNIQUE,
        p256dh       TEXT    NOT NULL,
        auth         TEXT    NOT NULL,
        device       TEXT,
        created_at   TEXT    NOT NULL,
        last_sent_at TEXT,
        failures     INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_push_subscriptions_recipient ON push_subscriptions(recipient);

      CREATE TABLE IF NOT EXISTS notify_settings (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        settings   TEXT    NOT NULL,
        updated_at TEXT    NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notify_prefs (
        recipient  TEXT PRIMARY KEY,
        prefs      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notify_events (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        module          TEXT    NOT NULL,
        kind            TEXT    NOT NULL,
        category        TEXT    NOT NULL,
        urgency         TEXT    NOT NULL CHECK (urgency IN ('now','digest','badge')),
        oncall          INTEGER NOT NULL DEFAULT 0,
        security        INTEGER NOT NULL DEFAULT 0,
        recipient       TEXT    NOT NULL,
        title           TEXT    NOT NULL,
        detail          TEXT,
        href            TEXT,
        idempotency_key TEXT    NOT NULL,
        state           TEXT    NOT NULL
                        CHECK (state IN ('pending','digest','pushed','emailed','counted','muted','digested')),
        created_at      TEXT    NOT NULL,
        delivered_at    TEXT,
        UNIQUE (recipient, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_notify_events_state ON notify_events(state, recipient);
      CREATE INDEX IF NOT EXISTS idx_notify_events_recipient ON notify_events(recipient, id);

      CREATE TABLE IF NOT EXISTS notify_digests (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        recipient  TEXT    NOT NULL,
        kind       TEXT    NOT NULL CHECK (kind IN ('briefing','wrapup')),
        local_date TEXT    NOT NULL,
        item_count INTEGER NOT NULL,
        created_at TEXT    NOT NULL,
        UNIQUE (recipient, kind, local_date)
      );
    `);
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
