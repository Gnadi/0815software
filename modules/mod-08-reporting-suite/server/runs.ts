import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { ExportFormat, ParamValues, Report, RunTrigger } from '../shared/types.js';
import { resultToCsv } from './csv.js';
import { nowIso } from './errors.js';
import { resolveParams } from './params.js';
import { readSettings } from './settings.js';
import { runReportQuery } from './source-db.js';
import { buildXlsx, resultSheet } from './xlsx.js';

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
  /** The clock relative dates are resolved against (tests inject one). */
  now?: () => number;
}

export interface RunOptions {
  format?: ExportFormat;
  /** Values for the report's parameters; a missing one takes its default. */
  params?: ParamValues;
}

/**
 * Stored values for a report's CURRENT parameters only: a value saved on a
 * schedule for a parameter the report has since dropped is ignored rather
 * than failing every run.
 */
export function currentValues(report: Report, values: ParamValues | undefined): ParamValues {
  const out: ParamValues = {};
  for (const p of report.params) if (values && values[p.name] !== undefined) out[p.name] = values[p.name]!;
  return out;
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
 * Execute one export run for a report: resolve its parameters, run its query
 * against the read-only source db, write a CSV or XLSX file into the exports
 * directory, and append ONE immutable row to the append-only `runs` table
 * (whether it succeeded or failed) — with the values it bound, relative dates
 * resolved, so the history says which month a file covers. Returns the run id.
 *
 * The row count written to history is exactly the number of data rows in
 * the file, so a run's history row and its file can never disagree.
 */
export function executeRun(
  ctx: RunContext,
  report: Report,
  trigger: RunTrigger,
  scheduleId: number | null,
  options: RunOptions = {},
): number {
  const startedAt = nowIso();
  const format = options.format ?? 'csv';
  const insert = ctx.db.prepare(
    `INSERT INTO runs (report_id, schedule_id, trigger, status, started_at, finished_at, row_count, file_path, error, params)
     VALUES (@report_id, @schedule_id, @trigger, @status, @started_at, @finished_at, @row_count, @file_path, @error, @params)`,
  );

  let bound: Record<string, string | number | null> | null = null;
  try {
    bound = resolveParams(report.params, currentValues(report, options.params), (ctx.now ?? Date.now)(), readSettings(ctx.db).timezone);
    // No published set passed: runReportQuery reads it from this very
    // connection's catalog, so a scheduled run always sees the source's
    // current contract rather than one snapshotted when the app booted.
    const result = runReportQuery(ctx.sourceDb, report.sql, { viewsOnly: ctx.sourceViewsOnly }, bound);

    mkdirSync(ctx.exportsDir, { recursive: true });
    const stamp = startedAt.replace(/[:.]/g, '-');
    const fileName = `report-${report.id}-${slug(report.name)}-${stamp}.${format}`;
    const filePath = join(ctx.exportsDir, fileName);
    if (format === 'xlsx') writeFileSync(resolve(filePath), buildXlsx([resultSheet(report.name, result)]));
    else writeFileSync(resolve(filePath), resultToCsv(result), 'utf8');

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
      params: Object.keys(bound).length > 0 ? JSON.stringify(bound) : null,
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
      // A refused parameter names the field; the message alone would not.
      error: [(err as Error).message, ...(((err as { details?: { message: string }[] }).details ?? []).map((d) => d.message))].join(': ').slice(0, 500),
      params: bound && Object.keys(bound).length > 0 ? JSON.stringify(bound) : null,
    });
    return Number(info.lastInsertRowid);
  }
}
