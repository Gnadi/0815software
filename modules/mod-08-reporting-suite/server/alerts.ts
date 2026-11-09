import type Database from 'better-sqlite3';
import { DomainError } from './errors.js';

/**
 * Thresholds a person sets on a report's figure — "tell me when open
 * receivables go above € 50,000" (docs/NOTIFICATIONS-PLAN.md, MOD-08).
 *
 * The figure is the named column of the report's FIRST row: a report that
 * answers one number per row is a list, not a figure, and taking the first
 * row says plainly which one is meant. Checked on every run of the report,
 * scheduled or by hand; a crossing is APPENDED to `report_alert_hits`, and
 * the notification watcher reads it from there (server/inbox-rules.ts). An
 * alert is its owner's: nobody sees or removes someone else's.
 */

export interface ReportAlert {
  id: number;
  report_id: number;
  column_name: string;
  op: 'above' | 'below';
  threshold: number;
  owner: string;
  created_at: string;
}

export function listAlerts(db: Database.Database, reportId: number, owner: string): ReportAlert[] {
  return db.prepare('SELECT * FROM report_alerts WHERE report_id = ? AND owner = ? ORDER BY id').all(reportId, owner) as ReportAlert[];
}

export function createAlert(db: Database.Database, reportId: number, owner: string, input: Record<string, unknown>, at: string): ReportAlert {
  const errors: { field: string; message: string }[] = [];
  const column = typeof input.column === 'string' ? input.column.trim() : '';
  if (!column || column.length > 120) errors.push({ field: 'column', message: 'column is the name of a column in the result' });
  const op = input.op;
  if (op !== 'above' && op !== 'below') errors.push({ field: 'op', message: 'op is above or below' });
  const threshold = Number(input.threshold);
  if (input.threshold === undefined || input.threshold === null || input.threshold === '' || !Number.isFinite(threshold)) {
    errors.push({ field: 'threshold', message: 'threshold is a number' });
  }
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  const info = db
    .prepare('INSERT INTO report_alerts (report_id, column_name, op, threshold, owner, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(reportId, column, op, threshold, owner, at);
  return db.prepare('SELECT * FROM report_alerts WHERE id = ?').get(info.lastInsertRowid) as ReportAlert;
}

/** Remove one of your own alerts; anyone else's answers as one that does not exist. */
export function deleteAlert(db: Database.Database, id: number, owner: string): void {
  const removed = db.prepare('DELETE FROM report_alerts WHERE id = ? AND owner = ?').run(id, owner).changes;
  if (removed === 0) throw new DomainError(404, 'Alert not found');
}

/** After a run: record every alert of the report whose figure is across its line. */
export function checkAlerts(db: Database.Database, reportId: number, runId: number, firstRow: Record<string, unknown> | undefined, at: string): void {
  if (!firstRow) return;
  const alerts = db.prepare('SELECT * FROM report_alerts WHERE report_id = ?').all(reportId) as ReportAlert[];
  for (const alert of alerts) {
    const raw = firstRow[alert.column_name];
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isFinite(value)) continue;
    const crossed = alert.op === 'above' ? value > alert.threshold : value < alert.threshold;
    if (crossed) db.prepare('INSERT INTO report_alert_hits (alert_id, run_id, value, created_at) VALUES (?, ?, ?, ?)').run(alert.id, runId, value, at);
  }
}
