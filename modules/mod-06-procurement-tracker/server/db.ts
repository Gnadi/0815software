import Database from 'better-sqlite3';

/**
 * Open (or create) the database and ensure the schema exists.
 *
 * Design rules everything else hangs off (MOD-03's ledger philosophy):
 *
 * 1. NO STORED DERIVED STATE. POs and quotes store line items only;
 *    totals are always recomputed from the lines (shared/money.ts).
 *    "quoted" (RFQ) and "approved" (PO) are derived statuses that never
 *    hit a column, so they cannot drift.
 *
 * 2. APPROVALS ARE APPEND-ONLY. `approvals` rows are never updated or
 *    deleted. A PO carries a `submission_no`; every submit freezes an
 *    immutable snapshot (total + required tiers) in `po_submissions`
 *    and bumps the number. A rejection or return-to-draft simply puts
 *    the PO back into stored `draft` — which makes the current
 *    submission's approvals void BY DERIVATION, while every history row
 *    survives forever.
 *
 * 3. FROZEN MEANS FROZEN. The CHECK constraints make impossible states
 *    unrepresentable: a non-draft PO always has a submission, an
 *    ordered PO always has an ordered_at, an awarded RFQ always has a
 *    winner.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS suppliers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      contact    TEXT,
      email      TEXT,
      notes      TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS rfqs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      title               TEXT NOT NULL,
      status              TEXT NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open', 'awarded', 'closed')),
      due_date            TEXT,
      note                TEXT,
      awarded_supplier_id INTEGER REFERENCES suppliers(id),
      awarded_po_id       INTEGER REFERENCES purchase_orders(id),
      awarded_at          TEXT,
      closed_at           TEXT,
      created_at          TEXT NOT NULL,
      CHECK ((status = 'awarded') = (awarded_supplier_id IS NOT NULL)),
      CHECK ((status = 'awarded') = (awarded_po_id IS NOT NULL)),
      CHECK ((status = 'awarded') = (awarded_at IS NOT NULL)),
      CHECK ((status = 'closed') = (closed_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS rfq_lines (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      rfq_id      INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL,
      description TEXT NOT NULL,
      quantity    REAL NOT NULL CHECK (quantity > 0),
      unit        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rfq_lines_rfq ON rfq_lines (rfq_id);

    CREATE TABLE IF NOT EXISTS rfq_invitations (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      rfq_id      INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      created_at  TEXT NOT NULL,
      UNIQUE (rfq_id, supplier_id)
    );

    CREATE TABLE IF NOT EXISTS quotes (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      rfq_id      INTEGER NOT NULL REFERENCES rfqs(id) ON DELETE CASCADE,
      supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
      valid_until TEXT,
      note        TEXT,
      created_at  TEXT NOT NULL,
      UNIQUE (rfq_id, supplier_id)
    );

    CREATE TABLE IF NOT EXISTS quote_lines (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_id         INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
      rfq_line_id      INTEGER NOT NULL REFERENCES rfq_lines(id) ON DELETE CASCADE,
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
      UNIQUE (quote_id, rfq_line_id)
    );

    CREATE TABLE IF NOT EXISTS purchase_orders (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      number        TEXT NOT NULL UNIQUE,
      supplier_id   INTEGER NOT NULL REFERENCES suppliers(id),
      rfq_id        INTEGER REFERENCES rfqs(id),
      status        TEXT NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('draft', 'submitted', 'ordered', 'closed')),
      submission_no INTEGER NOT NULL DEFAULT 0 CHECK (submission_no >= 0),
      note          TEXT,
      ordered_at    TEXT,
      closed_at     TEXT,
      created_at    TEXT NOT NULL,
      CHECK (status = 'draft' OR submission_no > 0),
      CHECK ((status IN ('ordered', 'closed')) = (ordered_at IS NOT NULL)),
      CHECK ((status = 'closed') = (closed_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_pos_supplier ON purchase_orders (supplier_id);

    CREATE TABLE IF NOT EXISTS po_lines (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id            INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      position         INTEGER NOT NULL,
      description      TEXT NOT NULL,
      quantity         REAL NOT NULL CHECK (quantity > 0),
      unit             TEXT NOT NULL,
      unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
    );
    CREATE INDEX IF NOT EXISTS idx_po_lines_po ON po_lines (po_id);

    -- Append-only: one frozen snapshot per submit (total + derived tiers).
    CREATE TABLE IF NOT EXISTS po_submissions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id          INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      submission_no  INTEGER NOT NULL CHECK (submission_no > 0),
      total_cents    INTEGER NOT NULL CHECK (total_cents >= 0),
      required_tiers TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      UNIQUE (po_id, submission_no)
    );

    -- Append-only: approval decisions are never updated or deleted.
    CREATE TABLE IF NOT EXISTS approvals (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id         INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
      submission_no INTEGER NOT NULL CHECK (submission_no > 0),
      tier          INTEGER NOT NULL CHECK (tier > 0),
      decision      TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
      approver      TEXT NOT NULL,
      note          TEXT,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_po ON approvals (po_id);

    CREATE TABLE IF NOT EXISTS po_counters (
      year     INTEGER PRIMARY KEY,
      last_seq INTEGER NOT NULL
    );
  `);

  return db;
}
