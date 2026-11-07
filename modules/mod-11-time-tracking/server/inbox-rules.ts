import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import type { InboxItem } from '../shared/summary.js';
import type { People } from './people.js';
import { consume } from './watch.js';
import { mayAct } from './inbox.js';

/**
 * What waits for someone in time tracking, and whom which decision concerns
 * (docs/NOTIFICATIONS-PLAN.md, MOD-11).
 *
 *  - Waits for someone who may decide (`manage`): leave requests, expense
 *    claims and timesheets submitted by OTHERS — nobody decides their own,
 *    which `server/ownership.ts` and `mayDecide` already enforce, so the
 *    inbox does not offer it either.
 *  - Waits for the person themselves: last week's timesheet, still a draft.
 *  - Notified: a request, claim or week handed in goes to the deciders in the
 *    digest; the decision — approved, rejected, paid — goes to the person it
 *    is about, now. The two mail reminders (week not submitted, timer still
 *    running) also reach the phone: each row `reminders.ts` records is one
 *    occasion, and becomes one push.
 */

const emailOf = (db: Database.Database, employeeId: number): string | null =>
  ((db.prepare('SELECT email FROM employees WHERE id = ?').get(employeeId) as { email: string | null } | undefined)?.email ?? null)?.toLowerCase() ?? null;

const LEAVE: Record<string, string> = { vacation: 'Vacation', sick: 'Sick leave', special: 'Special leave', unpaid: 'Unpaid leave', comp_time: 'Time off in lieu' };

function lastWeekStart(nowMs: number): string {
  const d = new Date(nowMs);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day - 7);
  return d.toISOString().slice(0, 10);
}

export function collectInbox(db: Database.Database, person: string, level: AccessLevel, nowMs = Date.now()): { count: number; items: InboxItem[] } {
  const items: InboxItem[] = [];
  if (mayAct(level, 'manage')) {
    const leave = db
      .prepare(
        `SELECT r.id, r.type, r.start_date, r.end_date, r.created_at, e.name FROM leave_requests r JOIN employees e ON e.id = r.employee_id
         WHERE r.status = 'requested' AND lower(COALESCE(e.email, '')) != ? ORDER BY r.created_at`,
      )
      .all(person) as { id: number; type: string; start_date: string; end_date: string; created_at: string; name: string }[];
    for (const r of leave) {
      items.push({
        id: `leave-${r.id}`,
        kind: 'approval',
        title: 'A leave request waits for your decision',
        detail: `${r.name} · ${LEAVE[r.type] ?? r.type} · ${r.start_date} – ${r.end_date}`,
        tone: 'neutral',
        at: r.created_at,
        href: '/leave',
      });
    }
    const claims = db
      .prepare(
        `SELECT c.id, c.number, c.title, c.submitted_at, e.name FROM expense_claims c JOIN employees e ON e.id = c.employee_id
         WHERE c.status = 'submitted' AND lower(COALESCE(e.email, '')) != ? ORDER BY c.submitted_at`,
      )
      .all(person) as { id: number; number: string; title: string; submitted_at: string; name: string }[];
    for (const c of claims) {
      items.push({ id: `claim-${c.id}`, kind: 'approval', title: 'An expense claim waits for your decision', detail: `${c.number} · ${c.name} · ${c.title}`, tone: 'neutral', at: c.submitted_at, href: '/expenses' });
    }
    const weeks = db
      .prepare(
        `SELECT t.employee_id, t.week_start, t.updated_at, e.name FROM timesheets t JOIN employees e ON e.id = t.employee_id
         WHERE t.status = 'submitted' AND lower(COALESCE(e.email, '')) != ? ORDER BY t.week_start`,
      )
      .all(person) as { employee_id: number; week_start: string; updated_at: string; name: string }[];
    for (const w of weeks) {
      items.push({ id: `week-${w.employee_id}-${w.week_start}`, kind: 'approval', title: 'A timesheet waits for your approval', detail: `${w.name} · week of ${w.week_start}`, tone: 'neutral', at: w.updated_at, href: '/approvals' });
    }
  }
  // My own week, still a draft although it has time on it.
  const me = db.prepare('SELECT id FROM employees WHERE lower(email) = ?').get(person) as { id: number } | undefined;
  if (me) {
    const week = lastWeekStart(nowMs);
    const draft = db
      .prepare(
        `SELECT COUNT(*) AS n FROM time_entries WHERE employee_id = ? AND entry_date >= ? AND entry_date < date(?, '+7 days')
           AND NOT EXISTS (SELECT 1 FROM timesheets WHERE employee_id = ? AND week_start = ? AND status != 'draft')`,
      )
      .get(me.id, week, week, me.id, week) as { n: number };
    if (draft.n > 0) {
      items.push({ id: `my-week-${week}`, kind: 'reminder', title: 'Your last week is not submitted yet', detail: `Week of ${week}`, tone: 'warn', at: week, href: '/' });
    }
  }
  return { count: items.length, items };
}

export function watchTime(db: Database.Database, people: People): void {
  consume<{ id: number; request_id: number; type: string; actor: string; note: string | null }>(db, 'leave_events', 'leave_events', (ev) => {
    const r = db
      .prepare('SELECT r.employee_id, r.type, r.start_date, r.end_date, e.name FROM leave_requests r JOIN employees e ON e.id = r.employee_id WHERE r.id = ?')
      .get(ev.request_id) as { employee_id: number; type: string; start_date: string; end_date: string; name: string };
    const what = `${LEAVE[r.type] ?? r.type} · ${r.start_date} – ${r.end_date}`;
    if (ev.type === 'requested') {
      people.notify({
        kind: 'leave-requested',
        category: 'approvals',
        urgency: 'digest',
        holders: 'manage',
        recipients: [],
        actor: ev.actor,
        title: 'A leave request waits for your decision',
        detail: `${r.name} · ${what}`,
        href: '/leave',
        key: `leave:${ev.id}`,
      });
      // The person asking never decides it; drop them should they hold manage.
    } else if (ev.type === 'approved' || ev.type === 'rejected') {
      people.notify({
        kind: `leave-${ev.type}`,
        category: 'outcomes',
        urgency: 'now',
        recipients: [emailOf(db, r.employee_id)],
        actor: ev.actor,
        title: ev.type === 'approved' ? 'Your leave request was approved' : 'Your leave request was rejected',
        detail: `${what}${ev.note ? ` · ${ev.note}` : ''}`,
        href: '/leave',
        key: `leave:${ev.id}`,
      });
    }
  });

  consume<{ id: number; claim_id: number; type: string; actor: string; note: string | null }>(db, 'expense_claim_events', 'expense_claim_events', (ev) => {
    const c = db
      .prepare('SELECT c.number, c.title, c.employee_id, e.name FROM expense_claims c JOIN employees e ON e.id = c.employee_id WHERE c.id = ?')
      .get(ev.claim_id) as { number: string; title: string; employee_id: number; name: string };
    if (ev.type === 'submitted') {
      people.notify({ kind: 'claim-submitted', category: 'approvals', urgency: 'digest', holders: 'manage', actor: ev.actor, title: 'An expense claim waits for your decision', detail: `${c.number} · ${c.name} · ${c.title}`, href: '/expenses', key: `claim:${ev.id}` });
    } else if (ev.type === 'approved' || ev.type === 'rejected' || ev.type === 'paid') {
      const title = ev.type === 'approved' ? 'Your expense claim was approved' : ev.type === 'rejected' ? 'Your expense claim was rejected' : 'Your expenses were paid out';
      people.notify({ kind: `claim-${ev.type}`, category: 'outcomes', urgency: 'now', recipients: [emailOf(db, c.employee_id)], actor: ev.actor, title, detail: `${c.number} · ${c.title}${ev.note ? ` · ${ev.note}` : ''}`, href: '/expenses', key: `claim:${ev.id}` });
    }
  });

  consume<{ id: number; employee_id: number; week_start: string; action: string; actor: string; note: string | null }>(db, 'timesheet_events', 'timesheet_events', (ev) => {
    const name = (db.prepare('SELECT name FROM employees WHERE id = ?').get(ev.employee_id) as { name: string }).name;
    if (ev.action === 'submit') {
      people.notify({ kind: 'week-submitted', category: 'approvals', urgency: 'digest', holders: 'manage', actor: ev.actor, title: 'A timesheet waits for your approval', detail: `${name} · week of ${ev.week_start}`, href: '/approvals', key: `week:${ev.id}` });
    } else {
      people.notify({
        kind: `week-${ev.action}`,
        category: 'outcomes',
        urgency: 'now',
        recipients: [emailOf(db, ev.employee_id)],
        actor: ev.actor,
        title: ev.action === 'approve' ? 'Your timesheet was approved' : 'Your timesheet was sent back',
        detail: `Week of ${ev.week_start}${ev.note ? ` · ${ev.note}` : ''}`,
        href: '/',
        key: `week:${ev.id}`,
      });
    }
  });

  // Each reminder the mail scheduler recorded is one occasion; the phone hears it once too.
  consume<{ id: number; kind: string; employee_id: number; ref: string; to_address: string }>(db, 'reminders_sent', 'reminders_sent', (r) => {
    people.notify({
      kind: r.kind === 'timer_running' ? 'timer-running' : 'week-not-submitted',
      category: 'reminders',
      urgency: r.kind === 'timer_running' ? 'now' : 'digest',
      recipients: [r.to_address],
      title: r.kind === 'timer_running' ? 'Your timer is still running' : 'Your last week is not submitted yet',
      detail: r.kind === 'timer_running' ? null : `Week of ${r.ref}`,
      href: '/',
      key: `reminder:${r.id}`,
    });
  });
}
