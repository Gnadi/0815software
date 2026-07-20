import Database from 'better-sqlite3';

/**
 * Open (or create) the database and ensure the schema exists.
 *
 * Design rules everything else hangs off:
 *
 * 1. THE MANAGER GRAPH IS A FOREST. `manager_id` points at another
 *    employee; a CHECK rules out direct self-management and the domain
 *    layer walks the chain inside every write transaction to rule out
 *    transitive cycles (see directory.ts). Roots are employees without
 *    a manager — the seed data has two of them.
 *
 * 2. NO HARD DELETE OF EMPLOYEES. Leaving is a status flip to
 *    `offboarded` (with a timestamp, enforced by a CHECK); the record
 *    and its manager reference stay for history, but offboarded
 *    employees vanish from the org chart. Departments CAN be deleted,
 *    but only while empty (no employees of any status, no children).
 *
 * 3. Departments form a tree via `parent_id`, guarded the same way as
 *    the manager forest.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS departments (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      code       TEXT NOT NULL UNIQUE,
      parent_id  INTEGER REFERENCES departments(id),
      created_at TEXT NOT NULL,
      CHECK (parent_id IS NULL OR parent_id <> id)
    );

    CREATE TABLE IF NOT EXISTS employees (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
      job_title     TEXT NOT NULL,
      department_id INTEGER NOT NULL REFERENCES departments(id),
      manager_id    INTEGER REFERENCES employees(id),
      phone         TEXT,
      location      TEXT,
      start_date    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'offboarded')),
      offboarded_at TEXT,
      created_at    TEXT NOT NULL,
      CHECK (manager_id IS NULL OR manager_id <> id),
      CHECK ((status = 'offboarded') = (offboarded_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_employees_department ON employees (department_id);
    CREATE INDEX IF NOT EXISTS idx_employees_manager ON employees (manager_id);

    CREATE TABLE IF NOT EXISTS onboarding_checklists (
      employee_id          INTEGER PRIMARY KEY
                             REFERENCES employees(id) ON DELETE CASCADE,
      account_created      INTEGER NOT NULL DEFAULT 0 CHECK (account_created IN (0, 1)),
      hardware_issued      INTEGER NOT NULL DEFAULT 0 CHECK (hardware_issued IN (0, 1)),
      intro_meeting_booked INTEGER NOT NULL DEFAULT 0 CHECK (intro_meeting_booked IN (0, 1))
    );
  `);

  return db;
}
