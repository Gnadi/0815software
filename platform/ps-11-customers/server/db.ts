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
  {
    id: 2,
    name: 'supplier-kind-and-merge',
    up(db) {
      // Two changes, both needed to make this party master data rather than a
      // customer list:
      //
      // 1. `kind` gains 'supplier'. Widening a CHECK constraint means rebuilding
      //    the table — SQLite cannot ALTER one — so this copies through a new
      //    table. The migration runner wraps it in a transaction.
      // 2. `merged_into` records that a party was merged away, so a consumer
      //    holding the old id is redirected to the survivor instead of reading a
      //    stale record. Merging is how duplicates that predate this service
      //    (or that arrived without a VAT id or email) get reconciled.
      db.exec(`
      CREATE TABLE parties_new (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        kind           TEXT NOT NULL DEFAULT 'customer'
                       CHECK (kind IN ('customer','supplier','self')),
        name           TEXT NOT NULL,
        contact_person TEXT,
        email          TEXT,
        vat_id         TEXT,
        address_lines  TEXT NOT NULL DEFAULT '',
        iban           TEXT,
        bic            TEXT,
        merged_into    INTEGER REFERENCES parties(id),
        archived_at    TEXT,
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );

      INSERT INTO parties_new
        (id, kind, name, contact_person, email, vat_id, address_lines, iban, bic,
         merged_into, archived_at, created_at, updated_at)
      SELECT
         id, kind, name, contact_person, email, vat_id, address_lines, iban, bic,
         NULL, archived_at, created_at, updated_at
      FROM parties;

      DROP TABLE parties;
      ALTER TABLE parties_new RENAME TO parties;

      CREATE INDEX IF NOT EXISTS idx_parties_vat ON parties(vat_id);
      CREATE INDEX IF NOT EXISTS idx_parties_email ON parties(email);
      CREATE INDEX IF NOT EXISTS idx_parties_merged ON parties(merged_into);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_parties_one_self
        ON parties(kind) WHERE kind = 'self';
    `);
    },
  },
];

/** Open (or create) the database, apply pragmas, and run pending migrations. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');

  // Migration 002 rebuilds `parties`, because SQLite cannot widen a CHECK
  // constraint in place. `DROP TABLE` with foreign-key enforcement ON runs an
  // implicit DELETE, which would cascade away every party_refs row — the exact
  // data a rebuild must preserve. So migrations run with enforcement off (the
  // standard SQLite rebuild recipe; the pragma is a no-op inside a transaction,
  // which is why it cannot live in the migration itself), and the schema is
  // checked for dangling references immediately afterwards.
  db.pragma('foreign_keys = OFF');
  runMigrations(db, MIGRATIONS);
  db.pragma('foreign_keys = ON');

  const violations = db.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0) {
    throw new Error(`refusing to serve: ${violations.length} dangling foreign-key reference(s) after migration`);
  }
  return db;
}
