import Database from 'better-sqlite3';

/**
 * Open (or create) the database and ensure the schema exists.
 *
 * Two design rules everything else hangs off:
 *
 * 1. TIME IS INTEGER MINUTES, MONEY IS DERIVED. `time_entries.minutes`
 *    is a positive integer (a CHECK forbids 0/negative and caps a single
 *    entry at 24h); the whole-day cap across several entries is enforced
 *    in a transaction in tracking.ts. No billable amount is ever stored
 *    — it is always round(minutes × rate_cents ÷ 60) from the project's
 *    current rate (shared/time.ts), so hours and money can never drift.
 *
 * 2. APPROVAL IS APPEND-ONLY. A `timesheets` row holds the stored status
 *    of one (employee, week) — draft / submitted / approved. Every
 *    transition also writes a `timesheet_events` row (who / when / note)
 *    that is never updated or deleted, so the approval trail is a full
 *    history. An approved week LOCKS its entries: tracking.ts refuses any
 *    insert/update/delete that touches an approved week with a 409.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      name             TEXT NOT NULL,
      client           TEXT,
      billable_default INTEGER NOT NULL DEFAULT 1 CHECK (billable_default IN (0, 1)),
      rate_cents       INTEGER NOT NULL DEFAULT 0 CHECK (rate_cents >= 0),
      active           INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      created_at       TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks (project_id);

    CREATE TABLE IF NOT EXISTS employees (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      email      TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS time_entries (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      project_id  INTEGER NOT NULL REFERENCES projects(id),
      task_id     INTEGER REFERENCES tasks(id),
      entry_date  TEXT NOT NULL,
      minutes     INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
      billable    INTEGER NOT NULL DEFAULT 1 CHECK (billable IN (0, 1)),
      note        TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entries_emp_date ON time_entries (employee_id, entry_date);
    CREATE INDEX IF NOT EXISTS idx_entries_project ON time_entries (project_id);
    CREATE INDEX IF NOT EXISTS idx_entries_task ON time_entries (task_id);

    -- Stored status of one (employee, week) timesheet. A missing row is
    -- treated as an implicit 'draft'.
    CREATE TABLE IF NOT EXISTS timesheets (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      week_start  TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'submitted', 'approved')),
      updated_at  TEXT NOT NULL,
      UNIQUE (employee_id, week_start)
    );

    -- Append-only: approval decisions are never updated or deleted.
    CREATE TABLE IF NOT EXISTS timesheet_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      week_start  TEXT NOT NULL,
      action      TEXT NOT NULL CHECK (action IN ('submit', 'approve', 'reject')),
      from_status TEXT NOT NULL,
      to_status   TEXT NOT NULL,
      actor       TEXT NOT NULL,
      note        TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_week ON timesheet_events (employee_id, week_start);
  `);

  // ── Additive, idempotent schema evolution ──────────────────────────
  // Guarded ALTERs so an existing database adopts them on the next boot,
  // exactly like MOD-04's and MOD-13's (their server/db.ts).
  const columns = (table: string): string[] =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);

  // Where a project came from, when it was not typed here — the reference of
  // the document transfer it was planned from, e.g. an offer number. Null for
  // every project someone created in this module, which is most of them.
  //
  // This is what makes an import IDEMPOTENT: a unique index means a second
  // import of the same offer finds the project the first one produced instead
  // of splitting one job's hours across two projects, which is the failure
  // that only shows up weeks later when someone tries to bill them.
  // `NULLS DISTINCT` is SQLite's default for unique indexes, so the many
  // projects with no origin do not collide with each other.
  if (!columns('projects').includes('origin_reference')) {
    db.exec('ALTER TABLE projects ADD COLUMN origin_reference TEXT');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_origin ON projects (origin_reference)');
  }

  // ── Absences (server/leave.ts) ───────────────────────────────────────
  // Which weekdays a person works (ISO, Monday = 1): part-time staff take a
  // day of leave only on a day they would have worked.
  if (!columns('employees').includes('work_days')) db.exec("ALTER TABLE employees ADD COLUMN work_days TEXT NOT NULL DEFAULT '12345'");

  db.exec(`
    -- The leave each person is entitled to, as an append-only ledger per year:
    -- the yearly allowance, what was carried over, corrections. Remaining
    -- leave is derived from it and the approved requests, never stored.
    CREATE TABLE IF NOT EXISTS leave_entitlements (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      year        INTEGER NOT NULL,
      kind        TEXT    NOT NULL CHECK (kind IN ('allowance', 'carryover', 'adjustment')),
      days        REAL    NOT NULL CHECK (days <> 0),
      note        TEXT,
      actor       TEXT    NOT NULL,
      created_at  TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_leave_entitlements_employee ON leave_entitlements (employee_id, year);

    -- A request and where it stands. What it costs in days is derived from
    -- the dates, the person's work days and the holidays — never stored.
    CREATE TABLE IF NOT EXISTS leave_requests (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id   INTEGER NOT NULL REFERENCES employees(id),
      type          TEXT    NOT NULL CHECK (type IN ('vacation', 'sick', 'special', 'unpaid', 'comp_time')),
      start_date    TEXT    NOT NULL,
      end_date      TEXT    NOT NULL,
      half_day      INTEGER NOT NULL DEFAULT 0 CHECK (half_day IN (0, 1)),
      note          TEXT,
      status        TEXT    NOT NULL CHECK (status IN ('requested', 'approved', 'rejected', 'withdrawn')),
      created_by    TEXT    NOT NULL,
      created_at    TEXT    NOT NULL,
      decided_by    TEXT,
      decided_at    TEXT,
      decision_note TEXT,
      CHECK (start_date <= end_date),
      CHECK (half_day = 0 OR start_date = end_date)
    );
    CREATE INDEX IF NOT EXISTS idx_leave_requests_employee ON leave_requests (employee_id, start_date);

    -- Every step of every request, append-only, with the person.
    CREATE TABLE IF NOT EXISTS leave_events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER NOT NULL REFERENCES leave_requests(id),
      type       TEXT    NOT NULL,
      actor      TEXT    NOT NULL,
      note       TEXT,
      at         TEXT    NOT NULL
    );

    -- The holiday calendar: the country, and regional or company days off.
    CREATE TABLE IF NOT EXISTS leave_settings (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      settings   TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
  `);

  return db;
}
