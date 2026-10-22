import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { addDays as addDaysIso, isoWeekday, publicHolidays } from '../shared/holidays.js';
import type {
  CalendarDay,
  CalendarRow,
  FieldError,
  LeaveBalance,
  LeaveEntitlement,
  LeaveRequest,
  LeaveSettings,
  LeaveStatus,
  LeaveType,
  ShownLeaveType,
} from '../shared/types.js';
import { DomainError, nowIso, todayIso } from './tracking.js';
import { employeeOf } from './ownership.js';

/**
 * Absences — leave requests, their approval, and what is left of the year.
 *
 * Next to the time recorded here, because they are the other half of the
 * same question: where was a person's working time. The same people, the
 * same rule for whose rows an editor may write (server/ownership.ts), and the
 * same office that approves a week also decides leave.
 *
 * - **Derived, never stored.** What a request costs is the working days in
 *   its range: the person's own work days (part-time), minus statutory
 *   holidays (shared/holidays.ts) and the company's extra days. Remaining
 *   leave = the entitlement ledger − approved vacation days. Changing a
 *   holiday or a work pattern re-prices open requests on the next read.
 * - **Append-only.** Entitlements are a ledger (allowance, carryover,
 *   corrections); every step of a request is an event with the person.
 * - **Who may do what** is one named function each, below the policy
 *   (`server/access.ts`): `mayActFor` (own, or `manage`) and `mayDecide`
 *   (`manage`, and never one's own request).
 * - **Sick leave is health data.** It is recorded, not requested (approved
 *   as it is entered), and shown as plain "absent" — no type, no note — to
 *   anyone but the person and `manage`.
 */

// ── Settings: the holiday calendar ──────────────────────────────────────

export const DEFAULT_LEAVE_SETTINGS: LeaveSettings = { country: 'AT', extra_holidays: [] };

export function readLeaveSettings(db: Database.Database): LeaveSettings {
  const row = db.prepare('SELECT settings FROM leave_settings WHERE id = 1').get() as { settings: string } | undefined;
  return row ? { ...DEFAULT_LEAVE_SETTINGS, ...(JSON.parse(row.settings) as Partial<LeaveSettings>) } : { ...DEFAULT_LEAVE_SETTINGS };
}

export function leaveSettingsStamp(db: Database.Database): { updated_at: string | null; updated_by: string | null } {
  const row = db.prepare('SELECT updated_at, updated_by FROM leave_settings WHERE id = 1').get() as
    | { updated_at: string; updated_by: string }
    | undefined;
  return { updated_at: row?.updated_at ?? null, updated_by: row?.updated_by ?? null };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (v: unknown): v is string => typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));

export function validateLeaveSettings(input: Record<string, unknown>): LeaveSettings {
  const errors: FieldError[] = [];
  const country = input.country ?? 'AT';
  if (country !== 'AT' && country !== 'DE') errors.push({ field: 'country', message: 'country is AT or DE' });
  const raw = input.extra_holidays ?? [];
  const extra: { date: string; name: string }[] = [];
  if (!Array.isArray(raw) || raw.length > 60) errors.push({ field: 'extra_holidays', message: 'extra_holidays is a list of up to 60 days' });
  else {
    raw.forEach((h: { date?: unknown; name?: unknown }, i) => {
      const name = typeof h?.name === 'string' ? h.name.trim() : '';
      if (!validDate(h?.date)) errors.push({ field: `extra_holidays[${i}].date`, message: 'date must be YYYY-MM-DD' });
      if (name === '' || name.length > 80) errors.push({ field: `extra_holidays[${i}].name`, message: 'name is required (max 80 characters)' });
      if (validDate(h?.date) && name) extra.push({ date: h.date as string, name });
    });
  }
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return { country: country as 'AT' | 'DE', extra_holidays: extra.sort((a, b) => a.date.localeCompare(b.date)) };
}

export function writeLeaveSettings(db: Database.Database, settings: LeaveSettings, actor: string): void {
  db.prepare(
    `INSERT INTO leave_settings (id, settings, updated_at, updated_by) VALUES (1, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run(JSON.stringify(settings), nowIso(), actor);
}

/** Every day off for everyone in a year: statutory plus the company's own. */
export function holidaysOf(db: Database.Database, year: number): Map<string, string> {
  const settings = readLeaveSettings(db);
  const days = new Map<string, string>();
  for (const h of publicHolidays(year, settings.country)) days.set(h.date, h.name);
  for (const h of settings.extra_holidays) if (h.date.startsWith(`${year}-`)) days.set(h.date, h.name);
  return days;
}

// ── What a range costs ──────────────────────────────────────────────────

/** Working days from `start` to `end` for someone working `workDays`. */
export function workingDays(db: Database.Database, workDays: string, start: string, end: string, halfDay = false): number {
  const holidays = holidaysOf(db, Number(start.slice(0, 4)));
  let count = 0;
  for (let day = start; day <= end; day = addDaysIso(day, 1)) {
    if (workDays.includes(String(isoWeekday(day))) && !holidays.has(day)) count += 1;
  }
  return halfDay ? count / 2 : count;
}

// ── Who may do what ─────────────────────────────────────────────────────

interface EmployeeStored {
  id: number;
  name: string;
  work_days: string;
}

function employee(db: Database.Database, id: number): EmployeeStored {
  const row = db.prepare('SELECT id, name, work_days FROM employees WHERE id = ?').get(id) as EmployeeStored | undefined;
  if (!row) throw new DomainError(404, 'Employee not found');
  return row;
}

/**
 * May `actor` request or withdraw leave for `employeeId`? Their own, always
 * (the policy already required `edit`); anyone's, with `manage`.
 */
export function mayActFor(db: Database.Database, actor: string, access: AccessLevel, employeeId: number): boolean {
  return access === 'manage' || employeeOf(db, actor) === employeeId;
}

/**
 * May `actor` approve or reject `employeeId`'s request? `manage` — the office
 * that also approves the weeks — and never the person themselves: nobody
 * approves their own leave, whatever their level.
 */
export function mayDecide(db: Database.Database, actor: string, access: AccessLevel, employeeId: number): boolean {
  return access === 'manage' && employeeOf(db, actor) !== employeeId;
}

/** May `actor` see that an absence is sick leave, and its note? */
function maySeeReason(db: Database.Database, actor: string, access: AccessLevel, employeeId: number): boolean {
  return access === 'manage' || employeeOf(db, actor) === employeeId;
}

// ── Requests ────────────────────────────────────────────────────────────

interface RequestStored {
  id: number;
  employee_id: number;
  type: LeaveType;
  start_date: string;
  end_date: string;
  half_day: number;
  note: string | null;
  status: LeaveStatus;
  created_by: string;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
}

export interface Viewer {
  actor: string;
  access: AccessLevel;
}

function requestRow(db: Database.Database, id: number): RequestStored {
  const row = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(id) as RequestStored | undefined;
  if (!row) throw new DomainError(404, 'Leave request not found');
  return row;
}

function costOf(db: Database.Database, row: RequestStored): number {
  return workingDays(db, employee(db, row.employee_id).work_days, row.start_date, row.end_date, row.half_day === 1);
}

function toRequest(db: Database.Database, row: RequestStored, viewer: Viewer, today: string): LeaveRequest {
  const person = employee(db, row.employee_id);
  const reason = maySeeReason(db, viewer.actor, viewer.access, row.employee_id);
  const masked = row.type === 'sick' && !reason;
  return {
    id: row.id,
    employee_id: row.employee_id,
    employee_name: person.name,
    type: masked ? 'absent' : row.type,
    start_date: row.start_date,
    end_date: row.end_date,
    half_day: row.half_day === 1,
    days: costOf(db, row),
    note: masked ? null : row.note,
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    decided_by: row.decided_by,
    decided_at: row.decided_at,
    decision_note: masked ? null : row.decision_note,
    can_decide: row.status === 'requested' && mayDecide(db, viewer.actor, viewer.access, row.employee_id),
    can_withdraw: withdrawable(row, today) && mayActFor(db, viewer.actor, viewer.access, row.employee_id),
  };
}

function withdrawable(row: RequestStored, today: string): boolean {
  if (row.status === 'requested') return true;
  // Leave already begun has been taken; it is corrected, not un-done.
  return row.status === 'approved' && row.start_date > today;
}

function event(db: Database.Database, requestId: number, type: string, actor: string, note: string | null): void {
  db.prepare('INSERT INTO leave_events (request_id, type, actor, note, at) VALUES (?, ?, ?, ?, ?)').run(requestId, type, actor, note, nowIso());
}

export interface RequestFilter {
  employeeId?: number;
  status?: LeaveStatus;
  year?: number;
  /** Only requests the viewer may decide on. */
  toDecide?: boolean;
}

export function listRequests(db: Database.Database, viewer: Viewer, filter: RequestFilter = {}, today = todayIso()): LeaveRequest[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.employeeId !== undefined) {
    clauses.push('employee_id = ?');
    params.push(filter.employeeId);
  }
  if (filter.status) {
    clauses.push('status = ?');
    params.push(filter.status);
  }
  if (filter.year !== undefined) {
    clauses.push("substr(start_date, 1, 4) = ?");
    params.push(String(filter.year));
  }
  const rows = db
    .prepare(`SELECT * FROM leave_requests ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''} ORDER BY start_date DESC, id DESC`)
    .all(...params) as RequestStored[];
  const out = rows.map((r) => toRequest(db, r, viewer, today));
  return filter.toDecide ? out.filter((r) => r.can_decide) : out;
}

export function getRequest(db: Database.Database, id: number, viewer: Viewer, today = todayIso()): LeaveRequest {
  return toRequest(db, requestRow(db, id), viewer, today);
}

// ── The year's account ──────────────────────────────────────────────────

export function balance(db: Database.Database, employeeId: number, year: number, except?: number): LeaveBalance {
  employee(db, employeeId);
  const entitled = (
    db.prepare('SELECT COALESCE(SUM(days), 0) AS d FROM leave_entitlements WHERE employee_id = ? AND year = ?').get(employeeId, year) as { d: number }
  ).d;
  const vacations = db
    .prepare(
      `SELECT * FROM leave_requests WHERE employee_id = ? AND type = 'vacation' AND status IN ('requested', 'approved')
         AND substr(start_date, 1, 4) = ? AND id IS NOT ?`,
    )
    .all(employeeId, String(year), except ?? null) as RequestStored[];
  const sum = (status: LeaveStatus) => vacations.filter((r) => r.status === status).reduce((acc, r) => acc + costOf(db, r), 0);
  const taken = sum('approved');
  const pending = sum('requested');
  return { employee_id: employeeId, year, entitled, taken, pending, remaining: entitled - taken, free: entitled - taken - pending };
}

export function listEntitlements(db: Database.Database, employeeId: number, year?: number): LeaveEntitlement[] {
  employee(db, employeeId);
  return db
    .prepare(`SELECT * FROM leave_entitlements WHERE employee_id = ? ${year !== undefined ? 'AND year = ?' : ''} ORDER BY year DESC, id`)
    .all(...(year !== undefined ? [employeeId, year] : [employeeId])) as LeaveEntitlement[];
}

export function addEntitlement(
  db: Database.Database,
  employeeId: number,
  input: { year: number; kind: LeaveEntitlement['kind']; days: number; note: string | null },
  actor: string,
): LeaveEntitlement {
  employee(db, employeeId);
  const info = db
    .prepare('INSERT INTO leave_entitlements (employee_id, year, kind, days, note, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(employeeId, input.year, input.kind, input.days, input.note, actor, nowIso());
  return db.prepare('SELECT * FROM leave_entitlements WHERE id = ?').get(info.lastInsertRowid) as LeaveEntitlement;
}

// ── Writing requests ────────────────────────────────────────────────────

export interface RequestInput {
  employeeId: number;
  type: LeaveType;
  startDate: string;
  endDate: string;
  halfDay: boolean;
  note: string | null;
}

/**
 * Request leave — or record sick leave, which is not asked for but reported,
 * and so stands approved as it is entered.
 */
export function createRequest(db: Database.Database, input: RequestInput, viewer: Viewer, today = todayIso()): LeaveRequest {
  return db.transaction((): LeaveRequest => {
    const person = employee(db, input.employeeId);
    if (!mayActFor(db, viewer.actor, viewer.access, input.employeeId)) {
      throw new DomainError(403, employeeOf(db, viewer.actor) === null
        ? `No employee record carries ${viewer.actor} — ask a manager to add your email to it`
        : 'You can only request leave for yourself');
    }
    const errors: FieldError[] = [];
    if (input.startDate > input.endDate) errors.push({ field: 'end_date', message: 'The leave ends before it starts' });
    if (input.startDate.slice(0, 4) !== input.endDate.slice(0, 4)) {
      errors.push({ field: 'end_date', message: 'Split leave at the new year — each year has its own allowance' });
    }
    if (input.halfDay && input.startDate !== input.endDate) errors.push({ field: 'half_day', message: 'A half day is a single day' });
    if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);

    const days = workingDays(db, person.work_days, input.startDate, input.endDate, input.halfDay);
    if (days === 0) throw new DomainError(422, 'Validation failed', [{ field: 'start_date', message: 'There is no working day in that range' }]);

    const overlap = db
      .prepare(
        `SELECT id, start_date, end_date FROM leave_requests WHERE employee_id = ? AND status IN ('requested', 'approved')
           AND start_date <= ? AND end_date >= ?`,
      )
      .get(input.employeeId, input.endDate, input.startDate) as { id: number; start_date: string; end_date: string } | undefined;
    if (overlap) {
      throw new DomainError(409, `${person.name} already has leave from ${overlap.start_date} to ${overlap.end_date} — withdraw it first`);
    }
    if (input.type === 'vacation') {
      const account = balance(db, input.employeeId, Number(input.startDate.slice(0, 4)));
      if (days > account.free) {
        throw new DomainError(422, 'Validation failed', [
          { field: 'end_date', message: `${days} days requested, ${account.free} left in ${account.year} (after pending requests)` },
        ]);
      }
    }

    const sick = input.type === 'sick';
    const at = nowIso();
    const info = db
      .prepare(
        `INSERT INTO leave_requests (employee_id, type, start_date, end_date, half_day, note, status, created_by, created_at, decided_by, decided_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.employeeId, input.type, input.startDate, input.endDate, input.halfDay ? 1 : 0, input.note, sick ? 'approved' : 'requested', viewer.actor, at, sick ? viewer.actor : null, sick ? at : null);
    const id = Number(info.lastInsertRowid);
    event(db, id, sick ? 'recorded' : 'requested', viewer.actor, null);
    return toRequest(db, requestRow(db, id), viewer, today);
  })();
}

export function decideRequest(
  db: Database.Database,
  id: number,
  decision: 'approved' | 'rejected',
  note: string | null,
  viewer: Viewer,
  today = todayIso(),
): LeaveRequest {
  return db.transaction((): LeaveRequest => {
    const row = requestRow(db, id);
    if (employeeOf(db, viewer.actor) === row.employee_id) throw new DomainError(403, 'Nobody decides their own leave');
    if (!mayDecide(db, viewer.actor, viewer.access, row.employee_id)) {
      throw new DomainError(403, 'Leave is decided by someone with manage access');
    }
    if (row.status !== 'requested') throw new DomainError(409, `This request is already ${row.status}`);
    if (decision === 'approved' && row.type === 'vacation') {
      // Re-checked here: another request may have been approved meanwhile.
      const account = balance(db, row.employee_id, Number(row.start_date.slice(0, 4)), row.id);
      const days = costOf(db, row);
      if (days > account.remaining) {
        throw new DomainError(409, `${days} days requested, ${account.remaining} left in ${account.year}`);
      }
    }
    db.prepare('UPDATE leave_requests SET status = ?, decided_by = ?, decided_at = ?, decision_note = ? WHERE id = ?').run(
      decision,
      viewer.actor,
      nowIso(),
      note,
      id,
    );
    event(db, id, decision, viewer.actor, note);
    return toRequest(db, requestRow(db, id), viewer, today);
  })();
}

export function withdrawRequest(db: Database.Database, id: number, viewer: Viewer, today = todayIso()): LeaveRequest {
  return db.transaction((): LeaveRequest => {
    const row = requestRow(db, id);
    if (!mayActFor(db, viewer.actor, viewer.access, row.employee_id)) throw new DomainError(403, 'You can only withdraw your own leave');
    if (!withdrawable(row, today)) {
      throw new DomainError(409, row.status === 'approved' ? 'This leave has begun — it was taken and stays on record' : `This request is already ${row.status}`);
    }
    db.prepare("UPDATE leave_requests SET status = 'withdrawn' WHERE id = ?").run(id);
    event(db, id, 'withdrawn', viewer.actor, null);
    return toRequest(db, requestRow(db, id), viewer, today);
  })();
}

export function requestEvents(db: Database.Database, id: number): { type: string; actor: string; note: string | null; at: string }[] {
  requestRow(db, id);
  return db.prepare('SELECT type, actor, note, at FROM leave_events WHERE request_id = ? ORDER BY id').all(id) as {
    type: string;
    actor: string;
    note: string | null;
    at: string;
  }[];
}

// ── The team calendar ───────────────────────────────────────────────────

/** A month: its days (with holidays) and every active person's absences in it. */
export function calendar(db: Database.Database, month: string, viewer: Viewer): { days: CalendarDay[]; rows: CalendarRow[] } {
  const first = `${month}-01`;
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const holidays = holidaysOf(db, Number(month.slice(0, 4)));
  const days: CalendarDay[] = [];
  for (let d = first; d <= last; d = addDaysIso(d, 1)) {
    days.push({ date: d, weekday: isoWeekday(d), holiday: holidays.get(d) ?? null });
  }
  const people = db.prepare('SELECT id, name, work_days FROM employees ORDER BY name').all() as {
    id: number;
    name: string;
    work_days: string;
  }[];
  const rows = db
    .prepare(
      `SELECT * FROM leave_requests WHERE status IN ('requested', 'approved') AND start_date <= ? AND end_date >= ? ORDER BY start_date`,
    )
    .all(days.at(-1)!.date, first) as RequestStored[];
  return {
    days,
    rows: people.map((p) => {
      const absences: CalendarRow['absences'] = [];
      for (const r of rows.filter((x) => x.employee_id === p.id)) {
        const shown: ShownLeaveType = r.type === 'sick' && !maySeeReason(db, viewer.actor, viewer.access, p.id) ? 'absent' : r.type;
        for (const day of days) {
          if (day.date < r.start_date || day.date > r.end_date) continue;
          if (day.holiday || !p.work_days.includes(String(day.weekday))) continue;
          absences.push({ date: day.date, type: shown, status: r.status as 'requested' | 'approved', half: r.half_day === 1 });
        }
      }
      return { employee_id: p.id, employee_name: p.name, absences };
    }),
  };
}

/** Who is away on a day (approved only) — for the shell board. */
export function absentOn(db: Database.Database, date: string): number {
  const rows = db
    .prepare("SELECT DISTINCT r.employee_id, e.work_days FROM leave_requests r JOIN employees e ON e.id = r.employee_id WHERE r.status = 'approved' AND r.start_date <= ? AND r.end_date >= ?")
    .all(date, date) as { employee_id: number; work_days: string }[];
  if (holidaysOf(db, Number(date.slice(0, 4))).has(date)) return 0;
  return rows.filter((r) => r.work_days.includes(String(isoWeekday(date)))).length;
}
