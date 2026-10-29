import type Database from 'better-sqlite3';
import type { FieldError, RunningTimer, TimerSettings, TimerStopResult } from '../shared/types.js';
import { readLeaveSettings } from './leave.js';
import { createEntry, DomainError, getEntry, getEmployee, nowIso } from './tracking.js';

/**
 * The timer: start it on a project, work, stop it — and the stop writes an
 * ordinary time entry, held to every rule a typed one is (own time only, the
 * daily cap, an approved week stays locked).
 *
 * - **On the server.** A running timer is a row, not a browser stopwatch:
 *   it survives a reload, a closed tab and a switch from laptop to phone.
 *   How long it has run is derived from when it started, never stored.
 * - **One per person.** Starting another stops the running one first, in the
 *   same transaction — two clocks for one person is double-booked time.
 * - **Days are local.** Entries are dates, so a timer belongs to the day it
 *   started *where the people work* (`timezone`, default Europe/Vienna): a
 *   start at 00:30 Vienna is that day, not the UTC day before.
 * - **A forgotten timer is capped, and says so.** It ends at local midnight
 *   of the day it started and at the daily maximum (the working-time law's
 *   ten hours, from the calendar settings). The entry is marked as capped,
 *   so nobody books fourteen hours by forgetting a click — and nobody loses
 *   the fact that the clock ran on.
 * - **Under a minute is nothing.** A start-and-stop by mistake leaves no
 *   entry, only the log line.
 * - Every start, stop and discard is logged (`timer_events`), with the person.
 */

export const DEFAULT_TIMER_SETTINGS: TimerSettings = {
  timezone: 'Europe/Vienna',
  channel: 'transactional-email',
  week_reminder: { enabled: false, weekday: 1, hour: 9 },
  timer_reminder: { enabled: false, after_minutes: 540 },
};

export function readTimerSettings(db: Database.Database): TimerSettings {
  const row = db.prepare('SELECT settings FROM timer_settings WHERE id = 1').get() as { settings: string } | undefined;
  const stored = row ? (JSON.parse(row.settings) as Partial<TimerSettings>) : {};
  return {
    ...DEFAULT_TIMER_SETTINGS,
    ...stored,
    week_reminder: { ...DEFAULT_TIMER_SETTINGS.week_reminder, ...stored.week_reminder },
    timer_reminder: { ...DEFAULT_TIMER_SETTINGS.timer_reminder, ...stored.timer_reminder },
  };
}

export function timerSettingsStamp(db: Database.Database): { updated_at: string | null; updated_by: string | null } {
  const row = db.prepare('SELECT updated_at, updated_by FROM timer_settings WHERE id = 1').get() as
    | { updated_at: string; updated_by: string }
    | undefined;
  return { updated_at: row?.updated_at ?? null, updated_by: row?.updated_by ?? null };
}

export function validTimezone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.trim() === '' || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateTimerSettings(input: Record<string, unknown>): TimerSettings {
  const errors: FieldError[] = [];
  const tz = input.timezone ?? DEFAULT_TIMER_SETTINGS.timezone;
  if (!validTimezone(tz)) errors.push({ field: 'timezone', message: 'timezone is an IANA time zone, e.g. Europe/Vienna' });
  const channel = typeof input.channel === 'string' ? input.channel.trim() : DEFAULT_TIMER_SETTINGS.channel;
  if (channel === '' || channel.length > 80) errors.push({ field: 'channel', message: 'channel is the PS-03 channel name (max 80 characters)' });

  const week = (input.week_reminder ?? DEFAULT_TIMER_SETTINGS.week_reminder) as Record<string, unknown>;
  const weekday = Number(week.weekday ?? 1);
  const hour = Number(week.hour ?? 9);
  if (typeof (week.enabled ?? false) !== 'boolean') errors.push({ field: 'week_reminder.enabled', message: 'enabled is true or false' });
  if (!Number.isInteger(weekday) || weekday < 1 || weekday > 7) errors.push({ field: 'week_reminder.weekday', message: 'weekday is 1 (Monday) to 7 (Sunday)' });
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) errors.push({ field: 'week_reminder.hour', message: 'hour is 0 to 23' });

  const timer = (input.timer_reminder ?? DEFAULT_TIMER_SETTINGS.timer_reminder) as Record<string, unknown>;
  const after = Number(timer.after_minutes ?? 540);
  if (typeof (timer.enabled ?? false) !== 'boolean') errors.push({ field: 'timer_reminder.enabled', message: 'enabled is true or false' });
  if (!Number.isInteger(after) || after < 30 || after > 1440) errors.push({ field: 'timer_reminder.after_minutes', message: 'after_minutes is 30 to 1440' });

  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return {
    timezone: tz as string,
    channel,
    week_reminder: { enabled: (week.enabled ?? false) as boolean, weekday, hour },
    timer_reminder: { enabled: (timer.enabled ?? false) as boolean, after_minutes: after },
  };
}

export function writeTimerSettings(db: Database.Database, settings: TimerSettings, actor: string): void {
  db.prepare(
    `INSERT INTO timer_settings (id, settings, updated_at, updated_by) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(JSON.stringify(settings), nowIso(), actor);
}

// ── Local time, without a library ───────────────────────────────────────

interface Local {
  date: string;
  /** 1 = Monday … 7 = Sunday (ISO). */
  weekday: number;
  hour: number;
}

function partsOf(ms: number, tz: string): { y: number; m: number; d: number; h: number; min: number; s: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute'), s: get('second') };
}

/** How far `tz` is ahead of UTC at instant `ms`, in milliseconds. */
function offsetAt(ms: number, tz: string): number {
  const p = partsOf(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - Math.floor(ms / 1000) * 1000;
}

export function localOf(ms: number, tz: string): Local {
  const p = partsOf(ms, tz);
  const date = `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  const weekday = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  return { date, weekday, hour: p.h };
}

/** The instant the local day after `ms` begins — DST-safe (the offset is read at midnight itself). */
export function nextLocalMidnight(ms: number, tz: string): number {
  const p = partsOf(ms, tz);
  const guess = Date.UTC(p.y, p.m - 1, p.d + 1);
  let midnight = guess - offsetAt(guess, tz);
  midnight = guess - offsetAt(midnight, tz);
  return midnight;
}

// ── The timer ───────────────────────────────────────────────────────────

interface TimerRow {
  id: number;
  employee_id: number;
  project_id: number;
  task_id: number | null;
  note: string | null;
  billable: number | null;
  started_at: string;
  started_by: string;
}

function toRunning(db: Database.Database, row: TimerRow, now: number): RunningTimer {
  const project = db.prepare('SELECT name FROM projects WHERE id = ?').get(row.project_id) as { name: string };
  const task = row.task_id ? (db.prepare('SELECT name FROM tasks WHERE id = ?').get(row.task_id) as { name: string } | undefined) : undefined;
  return {
    employee_id: row.employee_id,
    project_id: row.project_id,
    project_name: project.name,
    task_id: row.task_id,
    task_name: task?.name ?? null,
    note: row.note,
    billable: row.billable === null ? null : row.billable === 1,
    started_at: row.started_at,
    started_by: row.started_by,
    elapsed_minutes: Math.max(0, Math.floor((now - Date.parse(row.started_at)) / 60_000)),
  };
}

export function runningTimer(db: Database.Database, employeeId: number, now = Date.now()): RunningTimer | null {
  const row = db.prepare('SELECT * FROM timers WHERE employee_id = ?').get(employeeId) as TimerRow | undefined;
  return row ? toRunning(db, row, now) : null;
}

export function runningTimers(db: Database.Database, now = Date.now()): RunningTimer[] {
  const rows = db.prepare('SELECT * FROM timers ORDER BY started_at').all() as TimerRow[];
  return rows.map((r) => toRunning(db, r, now));
}

export interface TimerInput {
  employeeId: number;
  projectId: number;
  taskId: number | null;
  note: string | null;
  billable: boolean | null;
}

function assertRefs(db: Database.Database, input: TimerInput): void {
  getEmployee(db, input.employeeId);
  const project = db.prepare('SELECT active FROM projects WHERE id = ?').get(input.projectId) as { active: number } | undefined;
  if (!project) throw new DomainError(404, 'Project not found');
  if (project.active !== 1) throw new DomainError(422, 'Validation failed', [{ field: 'project_id', message: 'The project is archived' }]);
  if (input.taskId !== null) {
    const task = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(input.taskId) as { project_id: number } | undefined;
    if (!task) throw new DomainError(404, 'Task not found');
    if (task.project_id !== input.projectId) throw new DomainError(422, 'Validation failed', [{ field: 'task_id', message: 'Task does not belong to the selected project' }]);
  }
}

function logEvent(db: Database.Database, row: TimerRow, kind: 'start' | 'stop' | 'discard', actor: string, at: string, extra: { minutes?: number; entryId?: number; capped?: boolean } = {}): void {
  db.prepare(
    `INSERT INTO timer_events (employee_id, kind, project_id, task_id, started_at, minutes, entry_id, capped, actor, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(row.employee_id, kind, row.project_id, row.task_id, row.started_at, extra.minutes ?? null, extra.entryId ?? null, extra.capped ? 1 : 0, actor, at);
}

/**
 * Stop the running timer and write its entry. `stoppedAt` lets a person who
 * forgot to stop say when they did (not before the start, not in the future).
 */
export function stopTimer(db: Database.Database, employeeId: number, actor: string, now = Date.now(), stoppedAt?: number): TimerStopResult {
  return db.transaction((): TimerStopResult => {
    const row = db.prepare('SELECT * FROM timers WHERE employee_id = ?').get(employeeId) as TimerRow | undefined;
    if (!row) throw new DomainError(409, 'No timer is running');
    const start = Date.parse(row.started_at);
    const asked = stoppedAt ?? now;
    if (asked < start) throw new DomainError(422, 'Validation failed', [{ field: 'stopped_at', message: 'A timer cannot stop before it started' }]);
    if (asked > now + 60_000) throw new DomainError(422, 'Validation failed', [{ field: 'stopped_at', message: 'A timer cannot stop in the future' }]);

    const { timezone } = readTimerSettings(db);
    const dailyMax = readLeaveSettings(db).daily_max_minutes;
    const end = Math.min(asked, nextLocalMidnight(start, timezone), start + dailyMax * 60_000);
    const capped = end < asked;
    const minutes = Math.round((end - start) / 60_000);
    const at = nowIso();

    if (minutes < 1) {
      db.prepare('DELETE FROM timers WHERE id = ?').run(row.id);
      logEvent(db, row, 'discard', actor, at, { minutes: 0 });
      return { entry: null, minutes: 0, capped: false, discarded: true };
    }
    const entryDate = localOf(start, timezone).date;
    const entryId = createEntry(db, {
      employeeId: row.employee_id,
      projectId: row.project_id,
      taskId: row.task_id,
      entryDate,
      minutes,
      billable: row.billable === null ? null : row.billable === 1,
      note: row.note,
    });
    db.prepare('UPDATE time_entries SET timer_started_at = ?, timer_stopped_at = ?, timer_capped = ? WHERE id = ?').run(
      row.started_at,
      new Date(end).toISOString().replace(/\.\d{3}Z$/, 'Z'),
      capped ? 1 : 0,
      entryId,
    );
    db.prepare('DELETE FROM timers WHERE id = ?').run(row.id);
    logEvent(db, row, 'stop', actor, at, { minutes, entryId, capped });
    return { entry: getEntry(db, entryId), minutes, capped, discarded: false };
  })();
}

/** Start a timer; a running one is stopped first, its entry written. */
export function startTimer(db: Database.Database, input: TimerInput, actor: string, now = Date.now()): { timer: RunningTimer; stopped: TimerStopResult | null } {
  assertRefs(db, input);
  return db.transaction(() => {
    const running = db.prepare('SELECT id FROM timers WHERE employee_id = ?').get(input.employeeId);
    const stopped = running ? stopTimer(db, input.employeeId, actor, now) : null;
    const startedAt = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
    db.prepare('INSERT INTO timers (employee_id, project_id, task_id, note, billable, started_at, started_by) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      input.employeeId,
      input.projectId,
      input.taskId,
      input.note,
      input.billable === null ? null : input.billable ? 1 : 0,
      startedAt,
      actor,
    );
    const row = db.prepare('SELECT * FROM timers WHERE employee_id = ?').get(input.employeeId) as TimerRow;
    logEvent(db, row, 'start', actor, nowIso());
    return { timer: toRunning(db, row, now), stopped };
  })();
}

/** Change what the running timer is for — project, task, note — without restarting the clock. */
export function updateTimer(db: Database.Database, input: TimerInput, now = Date.now()): RunningTimer {
  assertRefs(db, input);
  const info = db
    .prepare('UPDATE timers SET project_id = ?, task_id = ?, note = ?, billable = ? WHERE employee_id = ?')
    .run(input.projectId, input.taskId, input.note, input.billable === null ? null : input.billable ? 1 : 0, input.employeeId);
  if (info.changes === 0) throw new DomainError(409, 'No timer is running');
  return runningTimer(db, input.employeeId, now)!;
}

/** Throw the running timer away: no entry, only the log line. */
export function discardTimer(db: Database.Database, employeeId: number, actor: string): void {
  db.transaction(() => {
    const row = db.prepare('SELECT * FROM timers WHERE employee_id = ?').get(employeeId) as TimerRow | undefined;
    if (!row) throw new DomainError(409, 'No timer is running');
    db.prepare('DELETE FROM timers WHERE id = ?').run(row.id);
    logEvent(db, row, 'discard', actor, nowIso());
  })();
}
