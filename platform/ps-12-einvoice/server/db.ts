import Database from 'better-sqlite3';
import { runMigrations, type Migration } from './migrations.js';

/**
 * Ordered schema migrations. Never edit a shipped migration; append a new one.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'baseline',
    up(db) {
      db.exec(`
      -- Every structured invoice this service issued, with the exact bytes.
      --
      -- Kept rather than streamed away for two reasons. An e-invoice is a
      -- COMMERCIAL DOCUMENT subject to the same retention obligation as the
      -- paper one (§147 AO in Germany, §132 BAO in Austria — ten and seven
      -- years), and "we generate it on demand" is not an answer when the
      -- generator has changed since. And the hash is what makes "the same
      -- invoice" a checkable claim rather than a hopeful one.
      CREATE TABLE IF NOT EXISTS documents (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        source      TEXT NOT NULL,
        number      TEXT NOT NULL,
        profile     TEXT NOT NULL,
        syntax      TEXT NOT NULL DEFAULT 'cii',
        xml         TEXT NOT NULL,
        sha256      TEXT NOT NULL,
        size_bytes  INTEGER NOT NULL,
        issued_at   TEXT NOT NULL
      );

      -- One issued document per (consumer, invoice number). A module retrying
      -- after a timeout gets the document it already issued rather than a
      -- second one carrying the same legally-unique invoice number.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_documents_source_number
        ON documents(source, number);
      CREATE INDEX IF NOT EXISTS idx_documents_issued ON documents(issued_at);

      -- Invoices somebody sent US. Germany has required every business to be
      -- able to RECEIVE a structured invoice since 2025-01-01, which is an
      -- obligation with no corresponding feature in any module — so the
      -- receiving side is stored here from the start rather than bolted on.
      CREATE TABLE IF NOT EXISTS inbound (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        number        TEXT,
        issue_date    TEXT,
        seller_name   TEXT,
        seller_vat_id TEXT,
        buyer_name    TEXT,
        currency      TEXT,
        net_cents     INTEGER,
        vat_cents     INTEGER,
        gross_cents   INTEGER,
        guideline_id  TEXT,
        syntax        TEXT NOT NULL DEFAULT 'cii',
        sha256        TEXT NOT NULL,
        xml           TEXT NOT NULL,
        received_at   TEXT NOT NULL
      );

      -- The same document arriving twice — a resent mail, a retried webhook —
      -- is one document. Content-addressed, so it holds however it arrived.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_sha ON inbound(sha256);
      CREATE INDEX IF NOT EXISTS idx_inbound_received ON inbound(received_at);
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
