import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { Report, RunTrigger } from '../shared/types.js';
import { resultToCsv } from './csv.js';
import { nowIso } from './errors.js';
import { runReportQuery } from './source-db.js';

export interface RunContext {
  /** Module metadata db (where the runs row is written). */
  db: Database.Database;
  /** Read-only source db (where the report query runs). */
  sourceDb: Database.Database;
  exportsDir: string;
  /**
   * Restrict queries to the source's published `report_*` views. A scheduled
   * run is held to the same surface as an interactive one — a report saved
   * before the flag was turned on starts failing, visibly, in its run history.
   */
  sourceViewsOnly?: boolean;
}

/** Safe filename fragment from a report name. */
function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'report'
  );
}

/**
 * Execute one export run for a report: run its query against the
 * read-only source db, write a CSV into the exports directory, and
 * append ONE immutable row to the append-only `runs` table (whether it
 * succeeded or failed). Returns the created run id.
 *
 * The row count written to history is exactly the number of data rows in
 * the CSV, so a run's history row and its file can never disagree.
 */
export function executeRun(
  ctx: RunContext,
  report: Report,
  trigger: RunTrigger,
  scheduleId: number | null,
): number {
  const startedAt = nowIso();
  const insert = ctx.db.prepare(
    `INSERT INTO runs (report_id, schedule_id, trigger, status, started_at, finished_at, row_count, file_path, error)
     VALUES (@report_id, @schedule_id, @trigger, @status, @started_at, @finished_at, @row_count, @file_path, @error)`,
  );

  try {
    const result = runReportQuery(ctx.sourceDb, report.sql, { viewsOnly: ctx.sourceViewsOnly });
    const csv = resultToCsv(result);

    mkdirSync(ctx.exportsDir, { recursive: true });
    const stamp = startedAt.replace(/[:.]/g, '-');
    const fileName = `report-${report.id}-${slug(report.name)}-${stamp}.csv`;
    const filePath = join(ctx.exportsDir, fileName);
    writeFileSync(resolve(filePath), csv, 'utf8');

    const info = insert.run({
      report_id: report.id,
      schedule_id: scheduleId,
      trigger,
      status: 'ok',
      started_at: startedAt,
      finished_at: nowIso(),
      row_count: result.rows.length,
      file_path: filePath,
      error: null,
    });
    return Number(info.lastInsertRowid);
  } catch (err) {
    const info = insert.run({
      report_id: report.id,
      schedule_id: scheduleId,
      trigger,
      status: 'error',
      started_at: startedAt,
      finished_at: nowIso(),
      row_count: null,
      file_path: null,
      error: (err as Error).message.slice(0, 500),
    });
    return Number(info.lastInsertRowid);
  }
}
