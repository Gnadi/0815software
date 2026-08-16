import Database from 'better-sqlite3';

/**
 * Open (or create) the database and ensure the schema exists.
 *
 * Three design rules everything else hangs off:
 *
 * 1. NO STORED BALANCES. An entitlement row says what someone is owed;
 *    requests say what they took. Every remaining/taken/pending number is
 *    recomputed from those two at read time (server/absences.ts), so a balance
 *    cannot drift away from the requests that produced it. This is MOD-04's
 *    "no stored totals" rule applied to days instead of money.
 *
 * 2. NO STORED DAY COUNTS EITHER. A request stores its dates and its half-day
 *    flags; how many days that costs depends on the employee's public-holiday
 *    calendar and is derived from shared/calendar.ts. Storing it would freeze
 *    an answer that is a function of WHERE someone works — and would be wrong
 *    the moment an employee moves between Bundesländer.
 *
 * 3. APPEND-ONLY HISTORY. Every status change writes a row into
 *    `request_events` that is never updated or deleted. A rejected request is
 *    not erased and neither is a withdrawn one: a year later, only the trail
 *    explains why someone has the balance they have.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS employees (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL UNIQUE,
      -- Which public-holiday calendar applies. A Bavarian and a Berliner
      -- booking the same week are charged different numbers of days, and this
      -- column is the whole reason that comes out right.
      region     TEXT NOT NULL,
      started_on TEXT NOT NULL,
      -- Leaving is a date, never a deletion: the requests, the balances and
      -- the history all stay answerable afterwards.
      left_on    TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_employees_active ON employees (left_on);

    CREATE TABLE IF NOT EXISTS entitlements (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id           INTEGER NOT NULL REFERENCES employees(id),
      year                  INTEGER NOT NULL,
      -- Stored as tenths of a day so half days are exact integers. A REAL
      -- column would make 0.1 + 0.2 a support ticket.
      base_tenths           INTEGER NOT NULL CHECK (base_tenths >= 0),
      carry_over_tenths     INTEGER NOT NULL DEFAULT 0 CHECK (carry_over_tenths >= 0),
      -- German and Austrian practice is that unused carry-over lapses on
      -- 31 March. NULL means it never does.
      carry_over_expires_on TEXT,
      created_at            TEXT NOT NULL,
      UNIQUE (employee_id, year)
    );

    CREATE TABLE IF NOT EXISTS requests (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_id INTEGER NOT NULL REFERENCES employees(id),
      type        TEXT NOT NULL,
      from_date   TEXT NOT NULL,
      to_date     TEXT NOT NULL,
      half_start  INTEGER NOT NULL DEFAULT 0 CHECK (half_start IN (0, 1)),
      half_end    INTEGER NOT NULL DEFAULT 0 CHECK (half_end IN (0, 1)),
      status      TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
      note        TEXT,
      created_at  TEXT NOT NULL,
      CHECK (from_date <= to_date)
    );
    CREATE INDEX IF NOT EXISTS idx_requests_employee ON requests (employee_id, from_date);
    CREATE INDEX IF NOT EXISTS idx_requests_status ON requests (status);

    CREATE TABLE IF NOT EXISTS request_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id  INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
      from_status TEXT,
      to_status   TEXT NOT NULL,
      actor       TEXT NOT NULL,
      note        TEXT,
      at          TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_request ON request_events (request_id, id);
  `);

  return db;
}
