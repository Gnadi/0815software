import Database from 'better-sqlite3';

/**
 * Open (or create) the database and ensure the schema exists.
 *
 * Two design rules everything else hangs off:
 *
 * 1. NO STORED TOTALS. Invoices store line items only (qty, unit net
 *    price in cents, VAT rate). Net, VAT and gross are always derived
 *    from the lines (shared/money.ts), so they cannot drift. Likewise
 *    payment status and "overdue" are derived, never stored.
 *
 * 2. GAPLESS NUMBERING. `invoice_counters` holds one row per year with
 *    the last sequence number handed out. A number is assigned in the
 *    same transaction that flips a draft to `sent` — drafts have no
 *    number (enforced by a CHECK), deleted drafts leave no gap, and a
 *    cancelled invoice keeps its number forever (cancellation is a
 *    status, not a deletion).
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      email      TEXT,
      vat_id     TEXT,
      address    TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      number              TEXT UNIQUE,
      customer_id         INTEGER NOT NULL REFERENCES customers(id),
      status              TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'sent', 'cancelled')),
      issue_date          TEXT,
      due_date            TEXT,
      payment_terms_days  INTEGER NOT NULL DEFAULT 14
                            CHECK (payment_terms_days BETWEEN 0 AND 365),
      note                TEXT,
      cancelled_at        TEXT,
      cancellation_reason TEXT,
      created_at          TEXT NOT NULL,
      CHECK ((status = 'draft') = (number IS NULL)),
      CHECK ((status = 'draft') = (issue_date IS NULL)),
      CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_invoices_customer ON invoices (customer_id);

    CREATE TABLE IF NOT EXISTS invoice_lines (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id       INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      position         INTEGER NOT NULL,
      description      TEXT NOT NULL,
      quantity         REAL NOT NULL CHECK (quantity > 0),
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      vat_rate         INTEGER NOT NULL CHECK (vat_rate IN (0, 10, 20))
    );
    CREATE INDEX IF NOT EXISTS idx_lines_invoice ON invoice_lines (invoice_id);

    CREATE TABLE IF NOT EXISTS payments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id   INTEGER NOT NULL REFERENCES invoices(id),
      date         TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      note         TEXT,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments (invoice_id);

    CREATE TABLE IF NOT EXISTS invoice_counters (
      year     INTEGER PRIMARY KEY,
      last_seq INTEGER NOT NULL
    );
  `);

  return db;
}
