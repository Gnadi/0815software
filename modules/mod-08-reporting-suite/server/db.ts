import Database from 'better-sqlite3';

/**
 * Open (or create) the module's OWN metadata database and ensure the
 * schema exists. This file holds reports, saved charts, schedules and
 * the append-only run history — never any of your business data. The
 * database you report ON is a separate, read-only file (server/source-db.ts).
 *
 * Design rules (MOD-03's ledger philosophy):
 *
 * 1. RUN HISTORY IS APPEND-ONLY. A `runs` row is written once, at the
 *    end of a run, and never updated or deleted. It is the immutable
 *    record of every scheduled or manual export.
 *
 * 2. NO STORED DERIVED STATE. A schedule stores only its cadence and its
 *    `last_run_at`; the next-due time is always DERIVED from those, so
 *    it can never drift. A chart stores its config; its SVG is rendered
 *    on demand.
 */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      description TEXT,
      sql         TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS charts (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id  INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      name       TEXT NOT NULL,
      kind       TEXT NOT NULL CHECK (kind IN ('bar', 'line')),
      x_column   TEXT NOT NULL,
      y_column   TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_charts_report ON charts (report_id);

    CREATE TABLE IF NOT EXISTS schedules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id   INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      interval    TEXT NOT NULL CHECK (interval IN ('hourly', 'daily')),
      format      TEXT NOT NULL CHECK (format IN ('csv')),
      enabled     INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      last_run_at TEXT,
      created_at  TEXT NOT NULL,
      UNIQUE (report_id)
    );

    -- Append-only: one row per export run, written once when it finishes.
    CREATE TABLE IF NOT EXISTS runs (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id   INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL,
      trigger     TEXT NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
      status      TEXT NOT NULL CHECK (status IN ('ok', 'error')),
      started_at  TEXT NOT NULL,
      finished_at TEXT NOT NULL,
      row_count   INTEGER,
      file_path   TEXT,
      error       TEXT,
      CHECK ((status = 'ok') = (error IS NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_runs_report ON runs (report_id);
  `);

  return db;
}
