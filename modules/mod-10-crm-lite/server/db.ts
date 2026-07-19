import Database from 'better-sqlite3';

/**
 * Open (or create) the database and ensure the schema exists.
 *
 * Design rules everything else hangs off (MOD-06's ledger philosophy):
 *
 * 1. STAGE HISTORY IS APPEND-ONLY. Every stage change of a deal writes a
 *    row into `deal_stage_events` and is never updated or deleted. The
 *    deal's `stage` column is a convenience cache for querying — the
 *    domain layer guarantees it always equals the LATEST event's
 *    `to_stage`. A test asserts that invariant across a move sequence.
 *
 * 2. NO STORED DERIVED STATE. A deal's expected value (value ×
 *    stage probability) and every pipeline metric (per-stage counts and
 *    sums, win rate) are recomputed on read from the deals + the one
 *    pipeline config file. Nothing derived is ever written down.
 *
 * 3. THE ACTIVITY LOG IS APPEND-ONLY. Activity rows are immutable once
 *    written, with ONE deliberate exception: the follow-up `done` flag
 *    can be toggled (and the toggle is recorded in `done_at`). Nothing
 *    else about an activity ever changes.
 *
 * 4. REFERENTIAL GUARDS. A company with contacts or deals cannot be
 *    deleted (409, enforced in the domain layer, mirrored by ON DELETE
 *    RESTRICT here). Deleting a contact clears it from deals/activities.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      domain     TEXT,
      notes      TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      email      TEXT,
      phone      TEXT,
      title      TEXT,
      company_id INTEGER REFERENCES companies(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts (company_id);

    CREATE TABLE IF NOT EXISTS deals (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      title              TEXT NOT NULL,
      company_id         INTEGER NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
      primary_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
      value_cents        INTEGER NOT NULL DEFAULT 0 CHECK (value_cents >= 0),
      stage              TEXT NOT NULL,
      note               TEXT,
      created_at         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_deals_company ON deals (company_id);
    CREATE INDEX IF NOT EXISTS idx_deals_stage ON deals (stage);

    -- Append-only: one row per stage transition (incl. the opening one).
    CREATE TABLE IF NOT EXISTS deal_stage_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      deal_id    INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      from_stage TEXT,
      to_stage   TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'move'
                   CHECK (kind IN ('open', 'move', 'reopen')),
      note       TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_stage_events_deal ON deal_stage_events (deal_id, id);

    -- Append-only activity log. The only mutable columns are done/done_at
    -- (the follow-up toggle); everything else is frozen once written.
    CREATE TABLE IF NOT EXISTS activities (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      type       TEXT NOT NULL CHECK (type IN ('call', 'email', 'meeting', 'note')),
      subject    TEXT NOT NULL,
      body       TEXT,
      contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
      deal_id    INTEGER REFERENCES deals(id) ON DELETE SET NULL,
      due_date   TEXT,
      done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
      done_at    TEXT,
      created_at TEXT NOT NULL,
      CHECK (contact_id IS NOT NULL OR deal_id IS NOT NULL),
      CHECK ((done = 1) = (done_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_activities_contact ON activities (contact_id);
    CREATE INDEX IF NOT EXISTS idx_activities_deal ON activities (deal_id);
    CREATE INDEX IF NOT EXISTS idx_activities_followup ON activities (due_date, done);
  `);

  return db;
}
