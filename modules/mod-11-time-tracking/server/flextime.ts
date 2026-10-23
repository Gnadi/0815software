import type Database from 'better-sqlite3';
import { addDays, isoWeekday } from '../shared/holidays.js';
import { fmtHoursDot } from '../shared/time.js';
import type { FlexAccount, FlexDay, FlexEntry, FlexKind, FlexMonth, LeaveType } from '../shared/types.js';
import { escapeCell } from './csv.js';
import { holidaysOf, maySeeReason, readLeaveSettings, type Viewer } from './leave.js';
import { dailyTarget, listSchedules, scheduleOn, worksOn } from './schedules.js';
import { DomainError, nowIso, todayIso } from './tracking.js';

/**
 * Flexitime (Gleitzeit) and overtime — derived from the time recorded here.
 *
 * A day asks for its schedule's target (server/schedules.ts), nothing on days
 * off and holidays. An absence covers the target: vacation, sick, special and
 * unpaid leave credit it, a half day half of it. Comp time (Zeitausgleich)
 * does NOT — it is a day off paid for with the balance, so the day asks for
 * its hours and the balance goes down by them.
 *
 *   balance(d) = ledger rows dated ≤ d + Σ (worked − due) over every day from
 *                the account's start to d
 *
 * Nothing of it is stored: correct an entry, a schedule or a holiday and the
 * balance follows. The ledger (flex_entries) is append-only and holds only
 * what the days cannot say — the balance brought in, corrections, and overtime
 * paid out. Overtime is the balance above the cap in the settings; what
 * happens to it (paid out with its surcharge, or taken as comp time) is a
 * decision, recorded as a payout here, priced by payroll.
 *
 * Worked time is every entry, approved week or not: the balance is today's,
 * and the weekly approval still locks what payroll sees.
 */

/** Leave that covers a day's target. Comp time is missing on purpose — see above. */
const CREDITED: readonly LeaveType[] = ['vacation', 'sick', 'special', 'unpaid'];

interface LeaveRow {
  type: LeaveType;
  start_date: string;
  end_date: string;
  half_day: number;
}

function employeeName(db: Database.Database, id: number): string {
  const row = db.prepare('SELECT name FROM employees WHERE id = ?').get(id) as { name: string } | undefined;
  if (!row) throw new DomainError(404, 'Employee not found');
  return row.name;
}

/** The first day with a target: where the account starts. Null: no account. */
export function accountStart(db: Database.Database, employeeId: number): string | null {
  const row = db
    .prepare('SELECT MIN(valid_from) AS start FROM work_schedules WHERE employee_id = ? AND weekly_minutes IS NOT NULL')
    .get(employeeId) as { start: string | null };
  return row.start;
}

export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

/** Every day from `from` to `to`, with what it asked for and what was worked. */
export function flexDays(db: Database.Database, employeeId: number, from: string, to: string, viewer: Viewer): FlexDay[] {
  employeeName(db, employeeId);
  const settings = readLeaveSettings(db);
  const schedules = listSchedules(db, employeeId);
  const start = accountStart(db, employeeId);
  const holidayYears = new Map<number, Map<string, string>>();
  const holidayOn = (date: string): string | null => {
    const year = Number(date.slice(0, 4));
    if (!holidayYears.has(year)) holidayYears.set(year, holidaysOf(db, year));
    return holidayYears.get(year)!.get(date) ?? null;
  };
  const worked = new Map(
    (
      db
        .prepare('SELECT entry_date, SUM(minutes) AS minutes FROM time_entries WHERE employee_id = ? AND entry_date BETWEEN ? AND ? GROUP BY entry_date')
        .all(employeeId, from, to) as { entry_date: string; minutes: number }[]
    ).map((r) => [r.entry_date, r.minutes]),
  );
  // Only approved leave moves the balance; a request is not yet an absence.
  const leave = db
    .prepare("SELECT type, start_date, end_date, half_day FROM leave_requests WHERE employee_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?")
    .all(employeeId, to, from) as LeaveRow[];
  const seeReason = maySeeReason(db, viewer.actor, viewer.access, employeeId);

  const days: FlexDay[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const weekday = isoWeekday(date);
    const holiday = holidayOn(date);
    const schedule = scheduleOn(schedules, date);
    const tracked = start !== null && date >= start && schedule !== null && schedule.weekly_minutes !== null;
    const target = tracked && !holiday ? dailyTarget(schedule, weekday) : 0;
    const absent = !holiday && worksOn(schedules, date) ? leave.find((r) => r.start_date <= date && date <= r.end_date) : undefined;
    const credited = absent && CREDITED.includes(absent.type) ? (absent.half_day ? Math.round(target / 2) : target) : 0;
    const minutes = worked.get(date) ?? 0;
    days.push({
      date,
      weekday,
      holiday,
      tracked,
      target,
      credited,
      due: target - credited,
      worked: minutes,
      diff: tracked ? minutes - (target - credited) : 0,
      absence: absent ? (absent.type === 'sick' && !seeReason ? 'absent' : absent.type) : null,
      absence_half: absent ? absent.half_day === 1 : false,
      over_max: minutes > settings.daily_max_minutes,
    });
  }
  return days;
}

export function listFlexEntries(db: Database.Database, employeeId: number): FlexEntry[] {
  employeeName(db, employeeId);
  return db.prepare('SELECT * FROM flex_entries WHERE employee_id = ? ORDER BY effective_date, id').all(employeeId) as FlexEntry[];
}

/** The account as of `asOf`: the balance, the cap and floor, and every month since the start. */
export function flexAccount(db: Database.Database, employeeId: number, asOf: string, viewer: Viewer): FlexAccount {
  const name = employeeName(db, employeeId);
  const settings = readLeaveSettings(db);
  const start = accountStart(db, employeeId);
  const ledger = listFlexEntries(db, employeeId).filter((e) => e.effective_date <= asOf);

  const months: FlexMonth[] = [];
  let balance = 0;
  const firstDay = [start, ledger[0]?.effective_date].filter((d): d is string => d !== undefined && d !== null && d <= asOf).sort()[0];
  if (firstDay !== undefined) {
    const days = start !== null && start <= asOf ? flexDays(db, employeeId, start, asOf, viewer) : [];
    for (let month = firstDay.slice(0, 7); month <= asOf.slice(0, 7); month = addDays(monthEnd(month), 1).slice(0, 7)) {
      const inMonth = days.filter((d) => d.date.startsWith(month));
      const rows = ledger.filter((e) => e.effective_date.startsWith(month));
      const sum = (pick: (d: FlexDay) => number) => inMonth.reduce((acc, d) => acc + pick(d), 0);
      const booked = rows.filter((e) => e.kind !== 'payout').reduce((acc, e) => acc + e.minutes, 0);
      const paidOut = -rows.filter((e) => e.kind === 'payout').reduce((acc, e) => acc + e.minutes, 0);
      const diff = sum((d) => d.diff);
      balance += diff + booked - paidOut;
      months.push({ month, due: sum((d) => (d.tracked ? d.due : 0)), worked: sum((d) => (d.tracked ? d.worked : 0)), diff, booked, paid_out: paidOut, balance_end: balance });
    }
  }
  const cap = settings.flex_cap_minutes;
  const floor = settings.flex_floor_minutes;
  return {
    employee_id: employeeId,
    employee_name: name,
    start,
    as_of: asOf,
    balance,
    cap,
    floor,
    over_cap: cap === null ? 0 : Math.max(0, balance - cap),
    under_floor: floor === null ? 0 : Math.max(0, floor - balance),
    months,
  };
}

export interface FlexOverviewRow {
  employee_id: number;
  employee_name: string;
  balance: number;
  over_cap: number;
  under_floor: number;
  /** Days this month with more work than the daily maximum. */
  days_over_max: number;
}

/** Everyone with an account, as of `asOf` — the manager's view and the shell tile. */
export function flexOverview(db: Database.Database, asOf: string, viewer: Viewer): FlexOverviewRow[] {
  const people = db.prepare('SELECT id FROM employees ORDER BY name').all() as { id: number }[];
  const rows: FlexOverviewRow[] = [];
  for (const { id } of people) {
    const start = accountStart(db, id);
    if (start === null || start > asOf) continue;
    const account = flexAccount(db, id, asOf, viewer);
    const monthStart = `${asOf.slice(0, 7)}-01`;
    const days = flexDays(db, id, monthStart > start ? monthStart : start, asOf, viewer);
    rows.push({
      employee_id: id,
      employee_name: account.employee_name,
      balance: account.balance,
      over_cap: account.over_cap,
      under_floor: account.under_floor,
      days_over_max: days.filter((d) => d.over_max).length,
    });
  }
  return rows;
}

export interface FlexEntryInput {
  kind: FlexKind;
  /** For a payout, the minutes paid out as a positive number; otherwise signed. */
  minutes: number;
  effectiveDate: string;
  note: string | null;
}

export function addFlexEntry(db: Database.Database, employeeId: number, input: FlexEntryInput, actor: string, viewer: Viewer): FlexEntry {
  return db.transaction((): FlexEntry => {
    employeeName(db, employeeId);
    if (accountStart(db, employeeId) === null) {
      throw new DomainError(409, 'This person has no flexitime account — give them a work schedule with weekly hours first');
    }
    let minutes = input.minutes;
    if (input.kind === 'payout') {
      // Only time that is in the account can leave it.
      const available = flexAccount(db, employeeId, input.effectiveDate, viewer).balance;
      if (input.minutes > available) {
        throw new DomainError(409, `Only ${fmtHoursDot(Math.max(0, available))} h are in the account on ${input.effectiveDate}`);
      }
      minutes = -input.minutes;
    }
    const info = db
      .prepare('INSERT INTO flex_entries (employee_id, kind, minutes, effective_date, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(employeeId, input.kind, minutes, input.effectiveDate, input.note, actor, nowIso());
    return db.prepare('SELECT * FROM flex_entries WHERE id = ?').get(info.lastInsertRowid) as FlexEntry;
  })();
}

/**
 * One month for payroll: per person with an account, what was due and worked,
 * overtime paid out, and the balance at the end. Hours are decimal with a dot,
 * the same as the PAYROLL timesheet profile. A month still running is counted
 * up to `today`, so days not yet worked do not show as missing hours.
 */
export function flexMonthCsv(db: Database.Database, month: string, viewer: Viewer, today = todayIso()): string {
  const last = monthEnd(month);
  const asOf = last < today ? last : today;
  const header = ['employee', 'email', 'month', 'due_hours', 'worked_hours', 'difference_hours', 'paid_out_hours', 'balance_hours', 'over_cap_hours'];
  const lines = [header.join(',')];
  const people = db.prepare('SELECT id, name, email FROM employees ORDER BY name').all() as { id: number; name: string; email: string | null }[];
  for (const p of people) {
    const start = accountStart(db, p.id);
    if (start === null || start > asOf || `${month}-01` > asOf) continue;
    const account = flexAccount(db, p.id, asOf, viewer);
    const m = account.months.find((x) => x.month === month);
    if (!m) continue;
    const overCap = account.cap === null ? 0 : Math.max(0, m.balance_end - account.cap);
    lines.push(
      [p.name, p.email ?? '', month, fmtHoursDot(m.due), fmtHoursDot(m.worked), fmtHoursDot(m.diff), fmtHoursDot(m.paid_out), fmtHoursDot(m.balance_end), fmtHoursDot(overCap)]
        .map((cell) => escapeCell(cell, ','))
        .join(','),
    );
  }
  return `${lines.join('\r\n')}\r\n`;
}
