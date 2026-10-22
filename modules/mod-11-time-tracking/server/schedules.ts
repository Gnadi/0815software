import type Database from 'better-sqlite3';
import { isoWeekday } from '../shared/holidays.js';
import type { WorkSchedule } from '../shared/types.js';
import { DomainError, nowIso } from './tracking.js';

/**
 * Working-time models: from a date on, a person works these weekdays for so
 * many minutes a week.
 *
 * Kept as a dated history, not a field on the employee, because two derived
 * figures look back in time: what a day of leave cost, and what a day asked
 * for in the flexitime account. A part-timer who goes full-time in June must
 * not see January re-priced, so a change is a new row from its date, and every
 * past day is read against the schedule that held on it.
 */

/** Without any schedule a person works Monday to Friday and has no flexitime account. */
export const DEFAULT_WORK_DAYS = '12345';

/** A person's schedules, oldest first. */
export function listSchedules(db: Database.Database, employeeId: number): WorkSchedule[] {
  return db.prepare('SELECT * FROM work_schedules WHERE employee_id = ? ORDER BY valid_from').all(employeeId) as WorkSchedule[];
}

/** The schedule that holds on `date`, from a list ordered oldest first. */
export function scheduleOn(schedules: readonly WorkSchedule[], date: string): WorkSchedule | null {
  let found: WorkSchedule | null = null;
  for (const s of schedules) {
    if (s.valid_from > date) break;
    found = s;
  }
  return found;
}

/** Does the person work on `date` (holidays aside)? */
export function worksOn(schedules: readonly WorkSchedule[], date: string): boolean {
  return (scheduleOn(schedules, date)?.work_days ?? DEFAULT_WORK_DAYS).includes(String(isoWeekday(date)));
}

/**
 * The minutes a schedule asks for on a weekday: the weekly target spread over
 * the work days. Minutes that do not divide evenly go one each to the first
 * work days of the week, so a week adds up to its target exactly — 37.5 h on
 * four days is 563 + 563 + 562 + 562, not 4 × 562.5 rounded.
 */
export function dailyTarget(schedule: WorkSchedule | null, weekday: number): number {
  if (!schedule || schedule.weekly_minutes === null) return 0;
  const index = schedule.work_days.indexOf(String(weekday));
  if (index < 0) return 0;
  const n = schedule.work_days.length;
  return Math.floor(schedule.weekly_minutes / n) + (index < schedule.weekly_minutes % n ? 1 : 0);
}

export interface ScheduleInput {
  validFrom: string;
  weeklyMinutes: number | null;
  workDays: string;
  note: string | null;
}

export function addSchedule(db: Database.Database, employeeId: number, input: ScheduleInput, actor: string): WorkSchedule {
  if (!db.prepare('SELECT 1 FROM employees WHERE id = ?').get(employeeId)) throw new DomainError(404, 'Employee not found');
  if (db.prepare('SELECT 1 FROM work_schedules WHERE employee_id = ? AND valid_from = ?').get(employeeId, input.validFrom)) {
    throw new DomainError(409, `A schedule already starts on ${input.validFrom} — add the change from another date`);
  }
  const info = db
    .prepare('INSERT INTO work_schedules (employee_id, valid_from, weekly_minutes, work_days, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(employeeId, input.validFrom, input.weeklyMinutes, input.workDays, input.note, actor, nowIso());
  return db.prepare('SELECT * FROM work_schedules WHERE id = ?').get(info.lastInsertRowid) as WorkSchedule;
}
