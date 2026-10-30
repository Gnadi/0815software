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

    ${CHARTS_TABLE('charts')}
    CREATE INDEX IF NOT EXISTS idx_charts_report ON charts (report_id);

    ${SCHEDULES_TABLE('schedules')}

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

    -- One row: what an administrator sets in the UI.
    CREATE TABLE IF NOT EXISTS report_settings (
      id         INTEGER PRIMARY KEY CHECK (id = 1),
      timezone   TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const columns = (table: string): string[] => (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  // Parameters: declared on the report, given on a schedule or a chart,
  // recorded on the run that bound them.
  if (!columns('reports').includes('params')) db.exec("ALTER TABLE reports ADD COLUMN params TEXT NOT NULL DEFAULT '[]'");
  if (!columns('runs').includes('params')) db.exec('ALTER TABLE runs ADD COLUMN params TEXT');
  // New chart kinds and export formats widen a CHECK constraint, which SQLite
  // cannot alter in place: the table is rebuilt once, rows and ids kept
  // (the procedure in https://sqlite.org/lang_altertable.html#otheralter).
  rebuildIfOld(db, 'charts', "CHECK (kind IN ('bar', 'line'))", CHARTS_TABLE, 'id, report_id, name, kind, x_column, y_column, created_at', 'CREATE INDEX IF NOT EXISTS idx_charts_report ON charts (report_id)');
  rebuildIfOld(db, 'schedules', "CHECK (format IN ('csv'))", SCHEDULES_TABLE, 'id, report_id, interval, format, enabled, last_run_at, created_at');

  return db;
}

function CHARTS_TABLE(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id     INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      kind          TEXT NOT NULL CHECK (kind IN ('bar', 'line', 'area', 'pie')),
      x_column      TEXT NOT NULL,
      y_column      TEXT NOT NULL,
      series_column TEXT,
      stacked       INTEGER NOT NULL DEFAULT 0 CHECK (stacked IN (0, 1)),
      param_values  TEXT NOT NULL DEFAULT '{}',
      created_at    TEXT NOT NULL
    );`;
}

function SCHEDULES_TABLE(name: string): string {
  return `CREATE TABLE IF NOT EXISTS ${name} (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id    INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      interval     TEXT NOT NULL CHECK (interval IN ('hourly', 'daily')),
      format       TEXT NOT NULL CHECK (format IN ('csv', 'xlsx')),
      enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      param_values TEXT NOT NULL DEFAULT '{}',
      last_run_at  TEXT,
      created_at   TEXT NOT NULL,
      UNIQUE (report_id)
    );`;
}

/**
 * Rebuild a table created by an older build — recognised by its old CHECK —
 * under the current definition, keeping every row and id. Foreign keys are
 * off for the swap so `runs.schedule_id` and the charts keep pointing at the
 * same ids; the check afterwards proves nothing was left dangling.
 */
function rebuildIfOld(db: Database.Database, table: string, oldMarker: string, create: (name: string) => string, columns: string, ...after: string[]): void {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string } | undefined;
  if (!row || !row.sql.includes(oldMarker)) return;
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(create(`${table}_new`));
      db.exec(`INSERT INTO ${table}_new (${columns}) SELECT ${columns} FROM ${table}`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(`ALTER TABLE ${table}_new RENAME TO ${table}`);
      for (const sql of after) db.exec(sql);
      const dangling = db.pragma('foreign_key_check') as unknown[];
      if (dangling.length > 0) throw new Error(`rebuilding ${table} left ${dangling.length} broken references`);
    })();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}
