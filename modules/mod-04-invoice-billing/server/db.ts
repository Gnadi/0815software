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

  // ── Additive, idempotent schema evolution ──────────────────────────
  // Guarded ALTERs so an existing database adopts them on the next boot,
  // exactly like the other hand-guarded columns in this catalogue.
  const columns = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

  // The PS-11 Customers party this customer is, when the master service is
  // wired. Null in a standalone deployment, which is why it is nullable.
  if (!columns('customers').includes('party_id')) {
    db.exec('ALTER TABLE customers ADD COLUMN party_id INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS idx_customers_party ON customers (party_id)');
  }

  // The offer this invoice was billed from. UNIQUE is what makes importing an
  // accepted offer idempotent: a retry finds the first invoice instead of
  // creating a second one. (SQLite treats NULLs as distinct, so hand-created
  // invoices are unaffected.)
  if (!columns('invoices').includes('origin_offer_number')) {
    db.exec('ALTER TABLE invoices ADD COLUMN origin_offer_number TEXT');
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_invoices_origin_offer ON invoices (origin_offer_number)',
    );
  }

  ensureReportViews(db);

  return db;
}

/**
 * The published REPORTING CONTRACT — `report_*` views (docs/REPORTING-CONTRACT.md).
 *
 * The tables above are this module's private business, free to be refactored.
 * These four views are the public surface anything else — MOD-08 Reporting
 * Suite, an operator with `sqlite3`, a nightly dump — is allowed to read, and
 * they are what stays stable across schema changes. Adding a column is fine;
 * renaming or removing one is a breaking change to the contract.
 *
 * Three rules the views encode, so a consumer cannot get them wrong:
 *
 * 1. DRAFTS NEVER APPEAR. A draft has no number and no issue date; it is not a
 *    business fact yet. Every view filters `status <> 'draft'`.
 * 2. MONEY IS COMPUTED EXACTLY AS shared/money.ts COMPUTES IT — line net is
 *    rounded PER LINE, VAT is rounded ONCE PER RATE on that rate's tax base,
 *    gross is their sum. Nothing is re-derived with different rounding, and
 *    api.test.ts asserts a view total equals computeTotals() for the same
 *    invoice. (SQLite's round() and JS's Math.round() agree on the
 *    non-negative values this schema allows: quantity > 0, unit price >= 0.)
 * 3. CANCELLED INVOICES ARE INCLUDED AND MARKED (`status`, `is_cancelled`), so
 *    a report can filter them rather than silently miss numbers that were
 *    issued. Only `report_receivables_aging` drops them — a cancelled invoice
 *    is not a receivable.
 *
 * `CREATE VIEW IF NOT EXISTS` only, no table changes: this migration is
 * append-only and idempotent like every other one in this catalogue, and a
 * database that already has the views is untouched.
 */
function ensureReportViews(db: Database.Database): void {
  db.exec(`
    -- One row per non-draft invoice: the header, the customer, the money.
    -- Key: invoice_number (unique, immutable — kept even when cancelled).
    CREATE VIEW IF NOT EXISTS report_invoices AS
    SELECT
      i.number                                        AS invoice_number,
      i.issue_date                                    AS issue_date,
      i.due_date                                      AS due_date,
      i.status                                        AS status,
      CASE WHEN i.status = 'cancelled' THEN 1 ELSE 0 END AS is_cancelled,
      i.cancelled_at                                  AS cancelled_at,
      i.cancellation_reason                           AS cancellation_reason,
      i.payment_terms_days                            AS payment_terms_days,
      c.id                                            AS customer_id,
      c.name                                          AS customer_name,
      c.vat_id                                        AS customer_vat_id,
      COALESCE(t.net_cents, 0)                        AS net_cents,
      COALESCE(t.vat_cents, 0)                        AS vat_cents,
      COALESCE(t.net_cents, 0) + COALESCE(t.vat_cents, 0) AS gross_cents,
      COALESCE(p.paid_cents, 0)                       AS paid_cents,
      COALESCE(t.net_cents, 0) + COALESCE(t.vat_cents, 0) - COALESCE(p.paid_cents, 0)
                                                      AS outstanding_cents,
      -- Whole days past due_date, and only while money is still owed. 0 for a
      -- settled, cancelled or not-yet-due invoice, so it never reads as debt.
      CASE
        WHEN i.due_date IS NULL THEN 0
        WHEN COALESCE(t.net_cents, 0) + COALESCE(t.vat_cents, 0) - COALESCE(p.paid_cents, 0) <= 0 THEN 0
        WHEN i.status = 'cancelled' THEN 0
        WHEN date('now') <= i.due_date THEN 0
        ELSE CAST(julianday(date('now')) - julianday(i.due_date) AS INTEGER)
      END                                             AS days_overdue
    FROM invoices i
    JOIN customers c ON c.id = i.customer_id
    LEFT JOIN (
      -- VAT is rounded once per rate on that rate's base, never per line.
      SELECT
        invoice_id,
        SUM(base_cents)                                    AS net_cents,
        SUM(CAST(ROUND(base_cents * vat_rate / 100.0) AS INTEGER)) AS vat_cents
      FROM (
        -- The line net is rounded per line, then summed per rate.
        SELECT
          l.invoice_id,
          l.vat_rate,
          SUM(CAST(ROUND(l.quantity * l.unit_price_cents) AS INTEGER)) AS base_cents
        FROM invoice_lines l
        GROUP BY l.invoice_id, l.vat_rate
      )
      GROUP BY invoice_id
    ) t ON t.invoice_id = i.id
    LEFT JOIN (
      SELECT invoice_id, SUM(amount_cents) AS paid_cents FROM payments GROUP BY invoice_id
    ) p ON p.invoice_id = i.id
    WHERE i.status <> 'draft';

    -- Line-level detail, joined to the invoice number a reader can cite.
    CREATE VIEW IF NOT EXISTS report_invoice_lines AS
    SELECT
      i.number                                          AS invoice_number,
      i.issue_date                                      AS issue_date,
      l.position                                        AS line_position,
      l.description                                     AS description,
      l.quantity                                        AS quantity,
      l.unit_price_cents                                AS unit_price_cents,
      l.vat_rate                                        AS vat_rate,
      CAST(ROUND(l.quantity * l.unit_price_cents) AS INTEGER) AS line_net_cents
    FROM invoice_lines l
    JOIN invoices i ON i.id = l.invoice_id
    WHERE i.status <> 'draft';

    -- Payments, joined to the invoice they settle and the customer who paid.
    CREATE VIEW IF NOT EXISTS report_payments AS
    SELECT
      pay.id                                            AS payment_id,
      i.number                                          AS invoice_number,
      c.id                                              AS customer_id,
      c.name                                            AS customer_name,
      pay.date                                          AS payment_date,
      pay.amount_cents                                  AS amount_cents,
      pay.note                                          AS note
    FROM payments pay
    JOIN invoices i ON i.id = pay.invoice_id
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status <> 'draft';

    -- Open receivables per customer in the conventional aging buckets.
    -- Cancelled invoices are excluded (not a receivable); so is anything
    -- already settled, which is why every row has outstanding_cents > 0.
    CREATE VIEW IF NOT EXISTS report_receivables_aging AS
    SELECT
      customer_id,
      customer_name,
      customer_vat_id,
      COUNT(*)                                                            AS open_invoice_count,
      SUM(outstanding_cents)                                              AS outstanding_cents,
      SUM(CASE WHEN days_overdue = 0                          THEN outstanding_cents ELSE 0 END) AS current_cents,
      SUM(CASE WHEN days_overdue BETWEEN 1 AND 30             THEN outstanding_cents ELSE 0 END) AS overdue_1_30_cents,
      SUM(CASE WHEN days_overdue BETWEEN 31 AND 60            THEN outstanding_cents ELSE 0 END) AS overdue_31_60_cents,
      SUM(CASE WHEN days_overdue BETWEEN 61 AND 90            THEN outstanding_cents ELSE 0 END) AS overdue_61_90_cents,
      SUM(CASE WHEN days_overdue > 90                         THEN outstanding_cents ELSE 0 END) AS overdue_90_plus_cents
    FROM report_invoices
    WHERE is_cancelled = 0 AND outstanding_cents > 0
    GROUP BY customer_id, customer_name, customer_vat_id;
  `);
}
