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
    },
  },
  {
    id: 2,
    name: 'audit_events-idempotency_key',
    up(db) {
      // Not part of the hash canonical form, so existing chains stay valid.
      //
      // Guarded, like every other ALTER in the catalogue: a database created
      // before the migration runner existed has no `schema_migrations`, so
      // every migration is pending against a schema that may already carry the
      // column — and an unguarded ADD COLUMN then fails the boot outright,
      // which is the opposite of the "adopt a pre-runner database cleanly"
      // property this runner is documented to have.
      const columns = (db.prepare("PRAGMA table_info('audit_events')").all() as { name: string }[]).map(
        (c) => c.name,
      );
      if (!columns.includes('idempotency_key')) {
        db.exec('ALTER TABLE audit_events ADD COLUMN idempotency_key TEXT');
      }
      db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_idempotency
        ON audit_events(idempotency_key) WHERE idempotency_key IS NOT NULL;
    `);
    },
  },
  {
    id: 3,
    name: 'audit_meta',
    up(db) {
      // Small key/value store; holds the retention anchor (the hash of the
      // most recently pruned event) so verification continues past a prune.
      db.exec(`
      CREATE TABLE IF NOT EXISTS audit_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    },
  },
  {
    id: 4,
    name: 'chain_head',
    up(db) {
      // The truncation marker (see `getHead`). Backfilled from the current tail
      // so a database written before this migration starts being protected
      // immediately, rather than staying unjudgeable until its next append.
      // The empty string means "chain empty, nothing pruned".
      const tail = db.prepare('SELECT hash FROM audit_events ORDER BY id DESC LIMIT 1').get() as
        | { hash: string }
        | undefined;
      const anchor = db.prepare("SELECT value FROM audit_meta WHERE key = 'retention_anchor'").get() as
        | { value: string }
        | undefined;
      db.prepare(
        "INSERT INTO audit_meta (key, value) VALUES ('chain_head', ?) ON CONFLICT(key) DO NOTHING",
      ).run(tail?.hash ?? anchor?.value ?? '');
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
