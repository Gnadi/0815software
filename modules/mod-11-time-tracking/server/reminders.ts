import type Database from 'better-sqlite3';
import { addDays, fmtHm, weekStartOf } from '../shared/time.js';
import type { ReminderKind, ReminderSent } from '../shared/types.js';
import type { PlatformHooks } from './platform.js';
import { localOf, readTimerSettings, runningTimers } from './timer.js';
import { nowIso, timesheetStatus } from './tracking.js';

/**
 * Reminders, through PS-03 — opt-in twice: the office switches each kind on
 * (Settings → Timer & reminders, `manage`), and nothing is sent without
 * NOTIFICATION_URL. Each reminder goes **once** per person and occasion
 * (`reminders_sent`, unique on kind + person + what it is about), so a tick
 * every few minutes never becomes a stream of mails:
 *
 * - **Last week not submitted** — from the configured weekday and hour, local
 *   time, to whoever still has last week as a draft and either booked time in
 *   it or had a weekly target (a working-time model). Someone who does not
 *   track time is not chased.
 * - **Timer still running** — once it has run the configured time; the
 *   person most likely forgot it, and the cap (server/timer.ts) only limits
 *   the damage.
 *
 * A failed send is not recorded, so the next tick tries again; a person with
 * no email gets nothing. Due-ness is derived from the clock and the rows on
 * every tick — nothing is queued, so a server that was down sends what is due
 * when it is back, once.
 */

export interface DueReminder {
  kind: ReminderKind;
  employeeId: number;
  name: string;
  email: string;
  ref: string;
  subject: string;
  body: string;
}

function alreadySent(db: Database.Database, kind: ReminderKind, employeeId: number, ref: string): boolean {
  return db.prepare('SELECT 1 FROM reminders_sent WHERE kind = ? AND employee_id = ? AND ref = ?').get(kind, employeeId, ref) !== undefined;
}

/** What is due now — derived from the clock, the settings and the rows; nothing is sent here. */
export function dueReminders(db: Database.Database, now = Date.now()): DueReminder[] {
  const settings = readTimerSettings(db);
  const due: DueReminder[] = [];
  const local = localOf(now, settings.timezone);

  const w = settings.week_reminder;
  if (w.enabled && (local.weekday > w.weekday || (local.weekday === w.weekday && local.hour >= w.hour))) {
    const lastWeek = addDays(weekStartOf(local.date), -7);
    const lastWeekEnd = addDays(lastWeek, 6);
    const people = db.prepare("SELECT id, name, email FROM employees WHERE email IS NOT NULL AND trim(email) <> ''").all() as { id: number; name: string; email: string }[];
    for (const p of people) {
      if (timesheetStatus(db, p.id, lastWeek) !== 'draft' || alreadySent(db, 'week_not_submitted', p.id, lastWeek)) continue;
      const booked = (db.prepare('SELECT COALESCE(SUM(minutes), 0) AS m FROM time_entries WHERE employee_id = ? AND entry_date BETWEEN ? AND ?').get(p.id, lastWeek, lastWeekEnd) as { m: number }).m;
      const target = db
        .prepare('SELECT weekly_minutes FROM work_schedules WHERE employee_id = ? AND valid_from <= ? ORDER BY valid_from DESC LIMIT 1')
        .get(p.id, lastWeekEnd) as { weekly_minutes: number | null } | undefined;
      if (booked === 0 && !(target?.weekly_minutes && target.weekly_minutes > 0)) continue;
      due.push({
        kind: 'week_not_submitted',
        employeeId: p.id,
        name: p.name,
        email: p.email,
        ref: lastWeek,
        subject: `Your timesheet for the week of ${lastWeek} is not submitted yet`,
        body: `Hello ${p.name},\n\nyour timesheet for ${lastWeek} – ${lastWeekEnd} is still a draft (${fmtHm(booked)} booked). Please check it and submit it for approval.`,
      });
    }
  }

  const t = settings.timer_reminder;
  if (t.enabled) {
    for (const timer of runningTimers(db, now)) {
      if (timer.elapsed_minutes < t.after_minutes) continue;
      const person = db.prepare('SELECT name, email FROM employees WHERE id = ?').get(timer.employee_id) as { name: string; email: string | null };
      if (!person.email || person.email.trim() === '' || alreadySent(db, 'timer_running', timer.employee_id, timer.started_at)) continue;
      due.push({
        kind: 'timer_running',
        employeeId: timer.employee_id,
        name: person.name,
        email: person.email,
        ref: timer.started_at,
        subject: `Your timer on ${timer.project_name} is still running`,
        body: `Hello ${person.name},\n\nyour timer on ${timer.project_name}${timer.task_name ? ` · ${timer.task_name}` : ''} has been running for ${fmtHm(timer.elapsed_minutes)}. If you forgot to stop it, stop it and say when you finished.`,
      });
    }
  }
  return due;
}

/** Send what is due, once each. Returns what was sent. Without PS-03, nothing is sent and nothing recorded. */
export async function runReminders(db: Database.Database, platform: PlatformHooks, now = Date.now()): Promise<ReminderSent[]> {
  if (!platform.notificationConfigured || !platform.notify) return [];
  const { channel } = readTimerSettings(db);
  const sent: ReminderSent[] = [];
  for (const r of dueReminders(db, now)) {
    try {
      // Keyed by occasion: should recording below fail after PS-03 sent it,
      // the retry is deduplicated there instead of mailing twice.
      await platform.notify({ channel, to: r.email, subject: r.subject, body: r.body, idempotencyKey: `mod-11:${r.kind}:${r.employeeId}:${r.ref}` });
    } catch (err) {
      console.warn(`[mod-11] reminder to ${r.email} failed, trying again next time:`, err);
      continue;
    }
    // INSERT OR IGNORE: two ticks racing on the same reminder record it once.
    const info = db
      .prepare('INSERT OR IGNORE INTO reminders_sent (kind, employee_id, ref, to_address, channel, sent_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(r.kind, r.employeeId, r.ref, r.email, channel, nowIso());
    if (info.changes > 0) sent.push(listReminders(db, 1, Number(info.lastInsertRowid))[0]!);
  }
  return sent;
}

export function listReminders(db: Database.Database, limit = 100, id?: number): ReminderSent[] {
  return db
    .prepare(
      `SELECT r.id, r.kind, r.employee_id, e.name AS employee_name, r.ref, r.to_address, r.channel, r.sent_at
         FROM reminders_sent r JOIN employees e ON e.id = r.employee_id
        ${id === undefined ? '' : 'WHERE r.id = ?'} ORDER BY r.id DESC LIMIT ?`,
    )
    .all(...(id === undefined ? [limit] : [id, limit])) as ReminderSent[];
}

/** The in-process tick — only while the server runs; there is no external cron. */
export function startReminderScheduler(db: Database.Database, platform: PlatformHooks, tickSeconds: number): () => void {
  if (!platform.notificationConfigured) return () => undefined;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runReminders(db, platform)
      .catch((err) => console.warn('[mod-11] reminder tick failed:', err))
      .finally(() => {
        running = false;
      });
  }, tickSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
