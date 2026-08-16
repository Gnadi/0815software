import type Database from 'better-sqlite3';
import { isRegion, leaveDays, workingDaysBetween, type Region } from '../shared/calendar.js';
import { absenceType, deducts, isAbsenceType } from './absence-config.js';
import { BLOCKING_STATUSES } from '../shared/types.js';
import type {
  AbsenceRequest,
  Balance,
  Employee,
  Entitlement,
  RequestDetail,
  RequestEvent,
  RequestStatus,
} from '../shared/types.js';

/**
 * The domain: entitlements, requests, and the balances derived from both.
 *
 * Days are stored as TENTHS of a day, everywhere. Leave comes in halves, and
 * `0.1 + 0.2 !== 0.3` is not a rounding curiosity when the number is somebody's
 * holiday — a balance that reads 24.499999999999996 is a support ticket.
 * Integers go in the database and in every comparison; the division by ten
 * happens once, at the edge, on the way out.
 */

/** A day count as tenths — the only form the arithmetic ever sees. */
export function toTenths(days: number): number {
  return Math.round(days * 10);
}

export function fromTenths(tenths: number): number {
  return tenths / 10;
}

export class DomainError extends Error {
  status: number;
  details: { field: string; message: string }[];
  constructor(status: number, message: string, details: { field: string; message: string }[] = []) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.details = details;
  }
}

export function fail(status: number, message: string, details: { field: string; message: string }[] = []): never {
  throw new DomainError(status, message, details);
}

export function nowIso(ms: number = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ── Employees ──────────────────────────────────────────────────────────

interface EmployeeRow {
  id: number;
  name: string;
  email: string;
  region: string;
  started_on: string;
  left_on: string | null;
  created_at: string;
}

function toEmployee(row: EmployeeRow): Employee {
  return { ...row, region: row.region as Region };
}

export function getEmployee(db: Database.Database, id: number): Employee {
  const row = db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as EmployeeRow | undefined;
  if (!row) fail(404, 'Employee not found');
  return toEmployee(row);
}

export function listEmployees(db: Database.Database, includeLeft = false): Employee[] {
  const sql = includeLeft
    ? 'SELECT * FROM employees ORDER BY name COLLATE NOCASE'
    : 'SELECT * FROM employees WHERE left_on IS NULL ORDER BY name COLLATE NOCASE';
  return (db.prepare(sql).all() as EmployeeRow[]).map(toEmployee);
}

export interface EmployeeInput {
  name: string;
  email: string;
  region: Region;
  startedOn: string;
}

export function createEmployee(db: Database.Database, input: EmployeeInput, at = nowIso()): Employee {
  const existing = db.prepare('SELECT id FROM employees WHERE email = ?').get(input.email);
  if (existing) fail(409, `An employee with the email ${input.email} already exists`);
  const info = db
    .prepare('INSERT INTO employees (name, email, region, started_on, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.name, input.email, input.region, input.startedOn, at);
  return getEmployee(db, Number(info.lastInsertRowid));
}

/**
 * Record that someone left. Never a delete: their requests, their balances and
 * the whole trail have to stay answerable — an ex-employee's leave year is
 * exactly what a payroll query asks about months later.
 */
export function offboardEmployee(db: Database.Database, id: number, leftOn: string): Employee {
  const employee = getEmployee(db, id);
  if (employee.left_on !== null) fail(409, `${employee.name} already left on ${employee.left_on}`);
  db.prepare('UPDATE employees SET left_on = ? WHERE id = ?').run(leftOn, id);
  return getEmployee(db, id);
}

// ── Entitlements ───────────────────────────────────────────────────────

interface EntitlementRow {
  id: number;
  employee_id: number;
  year: number;
  base_tenths: number;
  carry_over_tenths: number;
  carry_over_expires_on: string | null;
  created_at: string;
}

function toEntitlement(row: EntitlementRow): Entitlement {
  return {
    id: row.id,
    employee_id: row.employee_id,
    year: row.year,
    base_days: fromTenths(row.base_tenths),
    carry_over_days: fromTenths(row.carry_over_tenths),
    carry_over_expires_on: row.carry_over_expires_on,
    created_at: row.created_at,
  };
}

export interface EntitlementInput {
  employeeId: number;
  year: number;
  baseDays: number;
  carryOverDays: number;
  carryOverExpiresOn: string | null;
}

/** Set (or replace) an employee's entitlement for a year. */
export function setEntitlement(db: Database.Database, input: EntitlementInput, at = nowIso()): Entitlement {
  getEmployee(db, input.employeeId);
  db.prepare(
    `INSERT INTO entitlements (employee_id, year, base_tenths, carry_over_tenths, carry_over_expires_on, created_at)
     VALUES (@employee_id, @year, @base, @carry, @expires, @at)
     ON CONFLICT (employee_id, year) DO UPDATE SET
       base_tenths = @base, carry_over_tenths = @carry, carry_over_expires_on = @expires`,
  ).run({
    employee_id: input.employeeId,
    year: input.year,
    base: toTenths(input.baseDays),
    carry: toTenths(input.carryOverDays),
    expires: input.carryOverExpiresOn,
    at,
  });
  return getEntitlement(db, input.employeeId, input.year)!;
}

export function getEntitlement(db: Database.Database, employeeId: number, year: number): Entitlement | null {
  const row = db
    .prepare('SELECT * FROM entitlements WHERE employee_id = ? AND year = ?')
    .get(employeeId, year) as EntitlementRow | undefined;
  return row ? toEntitlement(row) : null;
}

// ── Requests ───────────────────────────────────────────────────────────

interface RequestRow {
  id: number;
  employee_id: number;
  type: string;
  from_date: string;
  to_date: string;
  half_start: number;
  half_end: number;
  status: RequestStatus;
  note: string | null;
  created_at: string;
}

/** Attach the derived day count, using the employee's own regional calendar. */
function toRequest(row: RequestRow, employee: Employee): AbsenceRequest {
  return {
    id: row.id,
    employee_id: row.employee_id,
    employee_name: employee.name,
    type: row.type,
    from_date: row.from_date,
    to_date: row.to_date,
    half_start: row.half_start === 1,
    half_end: row.half_end === 1,
    status: row.status,
    note: row.note,
    days: leaveDays(row.from_date, row.to_date, employee.region, {
      halfStart: row.half_start === 1,
      halfEnd: row.half_end === 1,
    }),
    created_at: row.created_at,
  };
}

function requestRow(db: Database.Database, id: number): RequestRow {
  const row = db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as RequestRow | undefined;
  if (!row) fail(404, 'Request not found');
  return row;
}

export function getRequest(db: Database.Database, id: number): RequestDetail {
  const row = requestRow(db, id);
  const employee = getEmployee(db, row.employee_id);
  const events = db
    .prepare('SELECT * FROM request_events WHERE request_id = ? ORDER BY id')
    .all(id) as RequestEvent[];
  return {
    ...toRequest(row, employee),
    events,
    covered_days: workingDaysBetween(row.from_date, row.to_date, employee.region),
  };
}

export interface RequestFilter {
  employeeId?: number;
  status?: RequestStatus;
  /** Overlapping this window, not contained in it. */
  from?: string;
  to?: string;
}

export function listRequests(db: Database.Database, filter: RequestFilter = {}): AbsenceRequest[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.employeeId !== undefined) {
    where.push('employee_id = ?');
    params.push(filter.employeeId);
  }
  if (filter.status !== undefined) {
    where.push('status = ?');
    params.push(filter.status);
  }
  // Overlap, not containment: a request that starts in December and ends in
  // January belongs to both years, and a calendar that hid it from one of them
  // would show a week nobody is away when somebody is.
  if (filter.from !== undefined) {
    where.push('to_date >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    where.push('from_date <= ?');
    params.push(filter.to);
  }
  const rows = db
    .prepare(`SELECT * FROM requests ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY from_date DESC, id DESC`)
    .all(...params) as RequestRow[];
  const employees = new Map(listEmployees(db, true).map((e) => [e.id, e]));
  return rows.map((row) => toRequest(row, employees.get(row.employee_id)!));
}

export interface CreateRequestInput {
  employeeId: number;
  type: string;
  fromDate: string;
  toDate: string;
  halfStart: boolean;
  halfEnd: boolean;
  note: string | null;
  actor: string;
}

/**
 * Book an absence.
 *
 * Everything that can make a request nonsense is checked INSIDE one
 * transaction, because the overlap check is a read followed by a write and two
 * requests submitted at the same moment would otherwise both find nothing in
 * their way. Two people cannot both be the only one on the helpdesk on Monday.
 */
export function createRequest(db: Database.Database, input: CreateRequestInput, at = nowIso()): RequestDetail {
  if (!isAbsenceType(input.type)) fail(422, `Unknown absence type "${input.type}"`);

  return db.transaction((): RequestDetail => {
    const employee = getEmployee(db, input.employeeId);
    if (employee.left_on !== null && input.fromDate > employee.left_on) {
      fail(409, `${employee.name} left on ${employee.left_on} and cannot book leave after that`);
    }
    if (input.fromDate < employee.started_on) {
      fail(422, `${employee.name} starts on ${employee.started_on}; leave cannot begin before that`, [
        { field: 'from_date', message: `must be on or after ${employee.started_on}` },
      ]);
    }

    const days = leaveDays(input.fromDate, input.toDate, employee.region, {
      halfStart: input.halfStart,
      halfEnd: input.halfEnd,
    });
    // A span made only of weekends and public holidays costs nothing, which
    // means it books nothing. Recording it would put a phantom entry on the
    // team calendar for days the office is shut anyway.
    if (days === 0) {
      fail(422, 'That span contains no working days — nothing to book', [
        { field: 'from_date', message: 'the whole span is weekend or public holiday' },
      ]);
    }

    const clash = db
      .prepare(
        `SELECT id, from_date, to_date FROM requests
          WHERE employee_id = ? AND status IN (${BLOCKING_STATUSES.map(() => '?').join(',')})
            AND to_date >= ? AND from_date <= ?
          LIMIT 1`,
      )
      .get(input.employeeId, ...BLOCKING_STATUSES, input.fromDate, input.toDate) as
      | { id: number; from_date: string; to_date: string }
      | undefined;
    if (clash) {
      fail(409, `Overlaps request #${clash.id} (${clash.from_date} … ${clash.to_date})`);
    }

    // Sick leave has no approver to wait for — an illness is recorded as a
    // fact that already happened, not requested. See server/absence-config.ts.
    const status: RequestStatus = absenceType(input.type)!.needsApproval ? 'pending' : 'approved';

    const info = db
      .prepare(
        `INSERT INTO requests (employee_id, type, from_date, to_date, half_start, half_end, status, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.employeeId,
        input.type,
        input.fromDate,
        input.toDate,
        input.halfStart ? 1 : 0,
        input.halfEnd ? 1 : 0,
        status,
        input.note,
        at,
      );
    const id = Number(info.lastInsertRowid);
    appendEvent(db, id, null, status, input.actor, input.note, at);
    return getRequest(db, id);
  })();
}

function appendEvent(
  db: Database.Database,
  requestId: number,
  from: RequestStatus | null,
  to: RequestStatus,
  actor: string,
  note: string | null,
  at: string,
): void {
  db.prepare(
    'INSERT INTO request_events (request_id, from_status, to_status, actor, note, at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(requestId, from, to, actor, note, at);
}

/**
 * Move a request to a new status.
 *
 * The transitions are deliberately few. A decided request does not go back to
 * pending — an approver who changes their mind cancels and the employee books
 * again, which leaves both facts in the trail rather than overwriting the
 * first with the second.
 */
const TRANSITIONS: Record<RequestStatus, RequestStatus[]> = {
  pending: ['approved', 'rejected', 'withdrawn'],
  // An approved absence can still be cancelled — plans change — but that is a
  // withdrawal with its own event, never a silent edit.
  approved: ['withdrawn'],
  rejected: [],
  withdrawn: [],
};

export function transitionRequest(
  db: Database.Database,
  id: number,
  to: RequestStatus,
  actor: string,
  note: string | null,
  at = nowIso(),
): RequestDetail {
  return db.transaction((): RequestDetail => {
    const row = requestRow(db, id);
    if (!TRANSITIONS[row.status].includes(to)) {
      fail(409, `A ${row.status} request cannot become ${to}`);
    }
    db.prepare('UPDATE requests SET status = ? WHERE id = ?').run(to, id);
    appendEvent(db, id, row.status, to, actor, note, at);
    return getRequest(db, id);
  })();
}

// ── Balances, all derived ──────────────────────────────────────────────

/**
 * An employee's leave position for a year.
 *
 * Every number is recomputed here from the entitlement row and the requests.
 * Nothing is cached and nothing is stored, so there is no state that can be
 * stale — the MOD-04 / MOD-10 rule applied to days.
 *
 * `today` is injected rather than read from the clock, because whether expired
 * carry-over has lapsed is a question about a date, and a test that cannot
 * choose the date can only assert what the code already does.
 */
export function balanceFor(db: Database.Database, employeeId: number, year: number, today: string): Balance {
  const employee = getEmployee(db, employeeId);
  const entitlement = getEntitlement(db, employeeId, year);

  const baseTenths = entitlement ? toTenths(entitlement.base_days) : 0;
  const carryTenths = entitlement ? toTenths(entitlement.carry_over_days) : 0;

  // Carry-over that has lapsed is still shown, separately, rather than
  // silently vanishing: "you had five days and lost them on 31 March" is the
  // answer somebody is going to ask for.
  const expired =
    entitlement?.carry_over_expires_on !== null &&
    entitlement?.carry_over_expires_on !== undefined &&
    today > entitlement.carry_over_expires_on;
  const usableCarryTenths = expired ? 0 : carryTenths;

  const rows = db
    .prepare(
      `SELECT type, from_date, to_date, half_start, half_end, status FROM requests
        WHERE employee_id = ? AND status IN ('pending', 'approved')
          AND from_date <= ? AND to_date >= ?`,
    )
    .all(employeeId, `${year}-12-31`, `${year}-01-01`) as RequestRow[];

  let takenTenths = 0;
  let pendingTenths = 0;
  for (const row of rows) {
    if (!deducts(row.type)) continue;
    // Clip to the year: a request spanning new year is charged to each year
    // for the days that actually fall in it, which is what both the employee
    // and the payroll export expect.
    const from = row.from_date < `${year}-01-01` ? `${year}-01-01` : row.from_date;
    const to = row.to_date > `${year}-12-31` ? `${year}-12-31` : row.to_date;
    const tenths = toTenths(
      leaveDays(from, to, employee.region, {
        halfStart: row.half_start === 1 && from === row.from_date,
        halfEnd: row.half_end === 1 && to === row.to_date,
      }),
    );
    if (row.status === 'approved') takenTenths += tenths;
    else pendingTenths += tenths;
  }

  const entitledTenths = baseTenths + usableCarryTenths;
  return {
    employee_id: employeeId,
    employee_name: employee.name,
    year,
    base_days: fromTenths(baseTenths),
    carry_over_days: fromTenths(carryTenths),
    carry_over_expired_days: fromTenths(expired ? carryTenths : 0),
    entitled_days: fromTenths(entitledTenths),
    taken_days: fromTenths(takenTenths),
    pending_days: fromTenths(pendingTenths),
    remaining_days: fromTenths(entitledTenths - takenTenths),
    projected_remaining_days: fromTenths(entitledTenths - takenTenths - pendingTenths),
  };
}

export function allBalances(db: Database.Database, year: number, today: string): Balance[] {
  return listEmployees(db).map((employee) => balanceFor(db, employee.id, year, today));
}

/** Validate a region string coming off the wire. */
export function parseRegion(value: unknown): Region {
  if (!isRegion(value)) fail(422, 'Unknown region', [{ field: 'region', message: 'must be a DE-xx state or AT' }]);
  return value;
}
