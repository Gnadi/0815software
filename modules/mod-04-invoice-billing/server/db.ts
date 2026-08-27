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

    -- ── Payables: bills we owe, and the bank files that pay them ──────
    -- The other direction of the same module. Everything above is money
    -- coming in; everything below is money going out, and the two share
    -- nothing but the seller identity: our own IBAN is the debtor account
    -- of every transfer, exactly as it is the account printed on every
    -- invoice. See server/bills.ts and shared/sepa.ts.

    CREATE TABLE IF NOT EXISTS creditors (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      -- Normalized (no spaces, upper case) and check-digit validated before
      -- it is ever written. A typo here is money sent to a stranger.
      iban       TEXT NOT NULL,
      bic        TEXT,
      note       TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bills (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      creditor_id  INTEGER NOT NULL REFERENCES creditors(id),
      reference    TEXT NOT NULL,
      remittance   TEXT,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      issue_date   TEXT,
      due_date     TEXT NOT NULL,
      note         TEXT,
      paid_at      TEXT,
      cancelled_at TEXT,
      created_at   TEXT NOT NULL,
      -- A bill is settled or abandoned, never both.
      CHECK (paid_at IS NULL OR cancelled_at IS NULL),
      -- Entering the same supplier invoice twice is the cheapest way to pay
      -- it twice, so the database refuses it outright.
      UNIQUE (creditor_id, reference)
    );
    CREATE INDEX IF NOT EXISTS idx_bills_creditor ON bills (creditor_id);

    -- One produced pain.001 file. The debtor block is a SNAPSHOT: the file
    -- the bank holds must stay exactly reproducible even after the seller
    -- letterhead changes underneath it.
    CREATE TABLE IF NOT EXISTS payment_runs (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id     TEXT NOT NULL UNIQUE,
      execution_date TEXT NOT NULL,
      batch_booking  INTEGER NOT NULL DEFAULT 0 CHECK (batch_booking IN (0, 1)),
      debtor_name    TEXT NOT NULL,
      debtor_iban    TEXT NOT NULL,
      debtor_bic     TEXT,
      created_by     TEXT,
      executed_at    TEXT,
      discarded_at   TEXT,
      created_at     TEXT NOT NULL,
      CHECK (executed_at IS NULL OR discarded_at IS NULL)
    );

    -- One transfer in that file, frozen the same way and for the same reason.
    CREATE TABLE IF NOT EXISTS payment_run_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id        INTEGER NOT NULL REFERENCES payment_runs(id),
      bill_id       INTEGER NOT NULL REFERENCES bills(id),
      position      INTEGER NOT NULL,
      end_to_end_id TEXT NOT NULL,
      amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
      creditor_name TEXT NOT NULL,
      creditor_iban TEXT NOT NULL,
      creditor_bic  TEXT,
      remittance    TEXT NOT NULL,
      -- Cleared only when the run is discarded — see the index below.
      active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      UNIQUE (run_id, bill_id)
    );
    CREATE INDEX IF NOT EXISTS idx_run_items_run ON payment_run_items (run_id);

    -- THE INVARIANT OF THIS HALF OF THE MODULE: a bill can be in at most one
    -- live payment run, so it cannot be paid twice. bills.ts checks it before
    -- inserting and reports it as a 409; this index is what makes a check that
    -- somehow slipped — a concurrent request, a future caller — impossible
    -- rather than merely unlikely. It lives in the items table because a
    -- partial index can only read the row it indexes, which is exactly why
    -- "discarded" is a flag here and not a join to payment_runs.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_run_items_live_bill
      ON payment_run_items (bill_id) WHERE active = 1;
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

  // Where a payment run went when PS-12 Banking is wired: the order's public
  // id, when it was handed over, and what the bank said. Null everywhere in a
  // standalone deployment, which is the whole point — the download is still
  // the primary path and always will be.
  //
  // `bank_status` is PS-12's own word for the order and is stored rather than
  // derived, because it is the *bank's* fact, not ours: nothing in this
  // database can recompute "the bank refused it". The run's own status still
  // derives from the timestamps beside it.
  if (!columns('payment_runs').includes('banking_order_id')) {
    db.exec('ALTER TABLE payment_runs ADD COLUMN banking_order_id TEXT');
    db.exec('ALTER TABLE payment_runs ADD COLUMN submitted_at TEXT');
    db.exec('ALTER TABLE payment_runs ADD COLUMN rejected_at TEXT');
    db.exec('ALTER TABLE payment_runs ADD COLUMN bank_status TEXT');
    db.exec('ALTER TABLE payment_runs ADD COLUMN bank_message TEXT');
    // One run, one bank order. A second submission of the same run would be a
    // second payment of the same bills, so it is refused by the schema and not
    // only by the code path that happens to check.
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_banking_order ON payment_runs (banking_order_id)',
    );
  }

  // Where a payment came from, when it was not typed in by hand.
  //
  // `external_ref` is a BANK booking's identity (shared/matching.ts), and the
  // UNIQUE index on it is the whole point: one arrival can become at most one
  // payment, however many times the bookings are fetched, re-read from stored
  // bytes, or offered again by a bank that never saw our receipt.
  //
  // Null for every payment entered by hand, which is every payment in a
  // standalone deployment — and a partial index, so those nulls do not collide
  // with each other.
  if (!columns('payments').includes('external_ref')) {
    db.exec('ALTER TABLE payments ADD COLUMN external_ref TEXT');
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_external ON payments (external_ref) WHERE external_ref IS NOT NULL',
    );
  }

  // The Austrian special credit transfers: a Finanzamtszahlung (TAXS) or a
  // Postbarzahlung (CPPP) carries a category purpose that an ordinary transfer
  // does not. A property of the whole run rather than of one bill, because
  // that is how they are filed and because ISO 20022 allows PmtTpInf at one
  // level only. Null means an ordinary SEPA credit transfer, which is what
  // every existing run is.
  if (!columns('payment_runs').includes('category_purpose')) {
    db.exec('ALTER TABLE payment_runs ADD COLUMN category_purpose TEXT');
    // Whether a remittance format was configured when this run was made. Null
    // for an ordinary run, which has none to check. Stored rather than derived
    // because the configuration can change and this is a fact about the run.
    db.exec('ALTER TABLE payment_runs ADD COLUMN remittance_checked INTEGER');
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
 * 3. CANCELLED INVOICES ARE INCLUDED AND MARKED, so a report can filter them
 *    rather than silently miss numbers that were issued. Every row-level view
 *    carries the flag, not just the header: `report_invoices` and
 *    `report_invoice_lines` as `status` / `is_cancelled`, `report_payments` as
 *    `invoice_status` / `invoice_is_cancelled` (disambiguated, because that
 *    view already carries payment-level fields). Only
 *    `report_receivables_aging` drops them — a cancelled invoice is not a
 *    receivable.
 *
 * NO TABLE CHANGES: this migration only ever touches views.
 *
 * The views are DROPPED AND RECREATED on every open, deliberately. A view
 * holds no data, so rebuilding one costs nothing and loses nothing — whereas
 * `CREATE VIEW IF NOT EXISTS` is inert on any database that has already run
 * it, which would mean an added column reached fresh test databases and never
 * reached a deployed stack. Tests would pass while the contract stayed broken
 * in production. Rebuilding is what makes the "adding a column is a compatible
 * change" promise in docs/REPORTING-CONTRACT.md actually true on upgrade.
 *
 * Order matters in one direction only: `report_receivables_aging` reads
 * `report_invoices`, so drop runs in reverse dependency order and create in
 * dependency order.
 */
function ensureReportViews(db: Database.Database): void {
  // Reverse dependency order: dependants first.
  db.exec(`
    DROP VIEW IF EXISTS report_receivables_aging;
    DROP VIEW IF EXISTS report_payments;
    DROP VIEW IF EXISTS report_invoice_lines;
    DROP VIEW IF EXISTS report_invoices;
  `);

  db.exec(`
    -- One row per non-draft invoice: the header, the customer, the money.
    -- Key: invoice_number (unique, immutable — kept even when cancelled).
    CREATE VIEW report_invoices AS
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
    -- Carries the PARENT invoice's cancellation state: without it a plain
    -- SUM(line_net_cents) silently counts revenue that was cancelled.
    CREATE VIEW report_invoice_lines AS
    SELECT
      i.number                                          AS invoice_number,
      i.issue_date                                      AS issue_date,
      l.position                                        AS line_position,
      l.description                                     AS description,
      l.quantity                                        AS quantity,
      l.unit_price_cents                                AS unit_price_cents,
      l.vat_rate                                        AS vat_rate,
      CAST(ROUND(l.quantity * l.unit_price_cents) AS INTEGER) AS line_net_cents,
      i.status                                          AS status,
      CASE WHEN i.status = 'cancelled' THEN 1 ELSE 0 END AS is_cancelled
    FROM invoice_lines l
    JOIN invoices i ON i.id = l.invoice_id
    WHERE i.status <> 'draft';

    -- Payments, joined to the invoice they settle and the customer who paid.
    -- The invoice's cancellation state is named invoice_* here: this view
    -- already carries payment-level fields, so an unqualified "status" would
    -- read as the payment's own.
    CREATE VIEW report_payments AS
    SELECT
      pay.id                                            AS payment_id,
      i.number                                          AS invoice_number,
      c.id                                              AS customer_id,
      c.name                                            AS customer_name,
      pay.date                                          AS payment_date,
      pay.amount_cents                                  AS amount_cents,
      pay.note                                          AS note,
      i.status                                          AS invoice_status,
      CASE WHEN i.status = 'cancelled' THEN 1 ELSE 0 END AS invoice_is_cancelled
    FROM payments pay
    JOIN invoices i ON i.id = pay.invoice_id
    JOIN customers c ON c.id = i.customer_id
    WHERE i.status <> 'draft';

    -- Open receivables per customer in the conventional aging buckets.
    -- Cancelled invoices are excluded (not a receivable); so is anything
    -- already settled, which is why every row has outstanding_cents > 0.
    CREATE VIEW report_receivables_aging AS
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
