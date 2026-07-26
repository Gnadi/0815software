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
      -- The master party record. Addresses are stored newline-separated and
      -- exposed as string[]; VAT ids are stored normalized (upper case, no
      -- whitespace) so matching cannot depend on how someone typed it.
      CREATE TABLE IF NOT EXISTS parties (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        kind           TEXT NOT NULL DEFAULT 'customer'
                       CHECK (kind IN ('customer','self')),
        name           TEXT NOT NULL,
        contact_person TEXT,
        email          TEXT,
        vat_id         TEXT,
        address_lines  TEXT NOT NULL DEFAULT '',
        iban           TEXT,
        bic            TEXT,
        archived_at    TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_parties_vat ON parties(vat_id);
      CREATE INDEX IF NOT EXISTS idx_parties_email ON parties(email);

      -- Exactly one 'self' party per stack: the owner's own identity, which is
      -- where the duplicated SELLER_* configuration finally lives.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_parties_one_self
        ON parties(kind) WHERE kind = 'self';

      -- How a module's local customer table maps onto the master record. This
      -- is the migration path: a module keeps its own ids forever and registers
      -- them here, so importing the same row twice resolves to one party.
      CREATE TABLE IF NOT EXISTS party_refs (
        party_id    INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
        source      TEXT NOT NULL,
        external_id TEXT NOT NULL,
        created_at  TEXT NOT NULL,
        PRIMARY KEY (source, external_id)
      );

      CREATE INDEX IF NOT EXISTS idx_party_refs_party ON party_refs(party_id);

      -- Replayed creates return the original party instead of a duplicate,
      -- matching the idempotency convention of PS-02/03/04/07/08.
      CREATE TABLE IF NOT EXISTS idempotency (
        key        TEXT PRIMARY KEY,
        party_id   INTEGER NOT NULL REFERENCES parties(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL
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
