import type Database from 'better-sqlite3';
import type { ReportSettings } from '../shared/types.js';
import { DomainError, nowIso } from './errors.js';

/**
 * What an administrator sets in the UI (`manage`): the time zone relative
 * dates are resolved in — "today", "month_start" and "prev_month_end" are
 * days where the office is, not in UTC, or a monthly export run just after
 * midnight would report the wrong month.
 */

export const DEFAULT_TIMEZONE = 'Europe/Vienna';

export function readSettings(db: Database.Database): ReportSettings {
  const row = db.prepare('SELECT timezone, updated_by, updated_at FROM report_settings WHERE id = 1').get() as ReportSettings | undefined;
  return row ?? { timezone: DEFAULT_TIMEZONE, updated_by: null, updated_at: null };
}

export function writeSettings(db: Database.Database, raw: Record<string, unknown>, actor: string): ReportSettings {
  const timezone = typeof raw.timezone === 'string' ? raw.timezone.trim() : '';
  let valid = timezone !== '';
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
  } catch {
    valid = false;
  }
  if (!valid) throw new DomainError(422, 'Validation failed', [{ field: 'timezone', message: 'must be an IANA time zone, e.g. Europe/Vienna' }]);
  db.prepare(
    `INSERT INTO report_settings (id, timezone, updated_by, updated_at) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET timezone = excluded.timezone, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  ).run(timezone, actor, nowIso());
  return readSettings(db);
}
