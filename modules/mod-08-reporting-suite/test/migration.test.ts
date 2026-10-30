import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../server/db.js';

/**
 * An installation from before parameters, area and pie charts and Excel
 * exports: its charts and schedules tables carry CHECK constraints that
 * refuse the new values, and SQLite cannot alter a CHECK in place. Opening
 * it with this build rebuilds those two tables — every row and id kept, the
 * run history still pointing at its schedule — and then accepts the new
 * kinds. The schema below is the previous release's, verbatim.
 */

const PREVIOUS_SCHEMA = `
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
`;

function previousInstallation(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'mod08-migrate-')), 'data.db');
  const old = new Database(path);
  old.pragma('foreign_keys = ON');
  old.exec(PREVIOUS_SCHEMA);
  const at = '2026-01-05T09:00:00.000Z';
  old.prepare("INSERT INTO reports (id, name, sql, created_at, updated_at) VALUES (4, 'Kept', 'SELECT 1 AS a, 2 AS b', ?, ?)").run(at, at);
  old.prepare("INSERT INTO charts (id, report_id, name, kind, x_column, y_column, created_at) VALUES (9, 4, 'Old line', 'line', 'a', 'b', ?)").run(at);
  old.prepare("INSERT INTO schedules (id, report_id, interval, format, enabled, last_run_at, created_at) VALUES (3, 4, 'daily', 'csv', 0, ?, ?)").run(at, at);
  old.prepare("INSERT INTO runs (report_id, schedule_id, trigger, status, started_at, finished_at, row_count, file_path) VALUES (4, 3, 'scheduled', 'ok', ?, ?, 1, '/x.csv')").run(at, at);
  old.close();
  return path;
}

describe('opening a database from the previous release', () => {
  it('keeps every row and id, and the run history still points at its schedule', () => {
    const db = openDb(previousInstallation());
    expect(db.prepare('SELECT id, report_id, name, kind, x_column, y_column, series_column, stacked, param_values FROM charts').all()).toEqual([
      { id: 9, report_id: 4, name: 'Old line', kind: 'line', x_column: 'a', y_column: 'b', series_column: null, stacked: 0, param_values: '{}' },
    ]);
    expect(db.prepare('SELECT id, report_id, interval, format, enabled, param_values FROM schedules').all()).toEqual([
      { id: 3, report_id: 4, interval: 'daily', format: 'csv', enabled: 0, param_values: '{}' },
    ]);
    expect(db.prepare('SELECT schedule_id, params FROM runs').all()).toEqual([{ schedule_id: 3, params: null }]);
    expect(db.prepare('SELECT params FROM reports').all()).toEqual([{ params: '[]' }]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'charts'").all()).toEqual([{ name: 'idx_charts_report' }]);
    db.close();
  });

  it('then accepts the new chart kinds and Excel schedules, and still refuses nonsense', () => {
    const db = openDb(previousInstallation());
    const at = '2026-10-30T00:00:00.000Z';
    db.prepare("INSERT INTO charts (report_id, name, kind, x_column, y_column, created_at) VALUES (4, 'Pie', 'pie', 'a', 'b', ?)").run(at);
    db.prepare("INSERT INTO charts (report_id, name, kind, x_column, y_column, created_at) VALUES (4, 'Area', 'area', 'a', 'b', ?)").run(at);
    db.prepare("UPDATE schedules SET format = 'xlsx' WHERE id = 3").run();
    expect(() => db.prepare("INSERT INTO charts (report_id, name, kind, x_column, y_column, created_at) VALUES (4, 'x', 'radar', 'a', 'b', ?)").run(at)).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE schedules SET format = 'pdf' WHERE id = 3").run()).toThrow(/CHECK/);
    // Deleting the report still cascades to the rebuilt tables.
    db.prepare('DELETE FROM reports WHERE id = 4').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM charts').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM schedules').get()).toEqual({ n: 0 });
    db.close();
  });

  it('a second opening changes nothing', () => {
    const path = previousInstallation();
    const first = openDb(path);
    const schema = first.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    first.close();
    const second = openDb(path);
    expect(second.prepare("SELECT sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()).toEqual(schema);
    second.close();
  });
});
