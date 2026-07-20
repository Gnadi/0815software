import Database from 'better-sqlite3';

/**
 * Open (or create) the database and ensure the schema exists.
 *
 * The design rules everything else hangs off (MOD-03's ledger philosophy
 * and MOD-06's append-only history, from the APPLICANT's point of view):
 *
 * 1. NO STORED DERIVED BALANCE. An application stores its eligible costs,
 *    the amount it requested and — once granted — the approved amount.
 *    The FUNDING CAP (what the program's rate justifies), the DISBURSED
 *    total and the REMAINING balance are always recomputed from the
 *    program's rate and the append-only `disbursements` rows
 *    (server/applications.ts, shared/money.ts). No counter can drift.
 *
 * 2. THE STATUS TIMELINE IS APPEND-ONLY. Every lifecycle move is a new
 *    `application_events` row (from → to, actor, note, and — on approval —
 *    the granted amount). Rows are never updated or deleted. The
 *    `applications.status` column is just the folded head of that stream,
 *    written in the SAME transaction as the event, so the audit trail and
 *    the current status can never disagree.
 *
 * 3. DISBURSEMENTS ARE APPEND-ONLY TRANCHES. Recording money we received
 *    inserts a `disbursements` row; nothing mutates a running total. An
 *    over-disbursement is rejected inside the transaction, so a rejected
 *    tranche writes nothing at all.
 *
 * 4. IMPOSSIBLE STATES ARE UNREPRESENTABLE. CHECK constraints keep the
 *    money non-negative, the funding rate in 0–100, and force an approved
 *    application to carry an approved_amount (and a non-approved one not to).
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS programs (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      name                 TEXT NOT NULL,
      funding_body         TEXT NOT NULL,
      category             TEXT NOT NULL,
      description          TEXT,
      funding_rate         INTEGER NOT NULL CHECK (funding_rate >= 0 AND funding_rate <= 100),
      max_grant_cents      INTEGER NOT NULL CHECK (max_grant_cents > 0),
      currency             TEXT NOT NULL DEFAULT 'EUR',
      application_deadline TEXT,
      status               TEXT NOT NULL DEFAULT 'open'
                             CHECK (status IN ('open', 'closed')),
      created_at           TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS applications (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      ref                   TEXT NOT NULL UNIQUE,
      program_id            INTEGER NOT NULL REFERENCES programs(id),
      title                 TEXT NOT NULL,
      status                TEXT NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','submitted','under_review','approved','rejected','withdrawn')),
      eligible_costs_cents  INTEGER NOT NULL CHECK (eligible_costs_cents > 0),
      requested_amount_cents INTEGER NOT NULL CHECK (requested_amount_cents > 0),
      approved_amount_cents INTEGER CHECK (approved_amount_cents IS NULL OR approved_amount_cents > 0),
      submission_date       TEXT,
      reference             TEXT,
      notes                 TEXT,
      created_at            TEXT NOT NULL,
      -- An approved application always carries an approved amount, and only
      -- an approved one may: the two facts are frozen together.
      CHECK ((status = 'approved') = (approved_amount_cents IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_applications_program ON applications (program_id);

    -- Append-only status timeline. One row per move; never updated/deleted.
    -- The opening 'created' row has from_status NULL. 'approved_amount_cents'
    -- is set only on the row that granted the application.
    CREATE TABLE IF NOT EXISTS application_events (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id        INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      type                  TEXT NOT NULL CHECK (type IN ('created','status_change')),
      from_status           TEXT,
      to_status             TEXT NOT NULL,
      actor                 TEXT NOT NULL,
      note                  TEXT,
      approved_amount_cents INTEGER,
      created_at            TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_application ON application_events (application_id, created_at, id);

    -- Append-only disbursement tranches. The remaining balance is
    -- approved_amount − SUM(amount_cents); it is NEVER stored.
    CREATE TABLE IF NOT EXISTS disbursements (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      disbursed_on   TEXT NOT NULL,
      amount_cents   INTEGER NOT NULL CHECK (amount_cents > 0),
      reference      TEXT,
      note           TEXT,
      created_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_disbursements_application ON disbursements (application_id);

    -- Post-award reporting obligations. 'done' is a genuine mutable flag
    -- (the one thing we toggle); its overdue/upcoming state is DERIVED from
    -- the injected clock at read time, never stored.
    CREATE TABLE IF NOT EXISTS obligations (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      title          TEXT NOT NULL,
      due_date       TEXT NOT NULL,
      done           INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
      done_at        TEXT,
      created_at     TEXT NOT NULL,
      CHECK ((done = 1) = (done_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_obligations_application ON obligations (application_id);

    -- Per-year sequence for the human ref (APP-<year>-<seq>).
    CREATE TABLE IF NOT EXISTS application_counters (
      year     INTEGER PRIMARY KEY,
      last_seq INTEGER NOT NULL
    );
  `);

  return db;
}
