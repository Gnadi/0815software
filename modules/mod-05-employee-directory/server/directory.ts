import type Database from 'better-sqlite3';
import type {
  DepartmentRow,
  EmployeeDetail,
  EmployeeRow,
  EmployeeStatus,
  OnboardingEntry,
  OnboardingFlags,
  OnboardingLists,
  OrgNode,
  PersonRef,
} from '../shared/types.js';

/** A LIKE pattern that matches the term literally — see the ESCAPE clauses below. */
function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** Error with an HTTP status and optional per-field details. */
export class DomainError extends Error {
  status: number;
  details: { field: string; message: string }[];

  constructor(status: number, message: string, details: { field: string; message: string }[] = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** "YYYY-MM-DD" for today (UTC) — the reference date for onboarding windows. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** date + n days, both as "YYYY-MM-DD". */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Whole days from `from` to `to` (negative if `to` is in the past). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function requireRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new DomainError(404, `${what} not found`);
  return row;
}

// ── Departments ────────────────────────────────────────────────────────

const DEPARTMENT_ROW_SQL = `
  SELECT d.*, p.name AS parent_name,
         (SELECT COUNT(*) FROM employees e WHERE e.department_id = d.id) AS employee_count,
         (SELECT COUNT(*) FROM departments c WHERE c.parent_id = d.id) AS child_count
  FROM departments d LEFT JOIN departments p ON p.id = d.parent_id`;

export function listDepartments(db: Database.Database): DepartmentRow[] {
  return db.prepare(`${DEPARTMENT_ROW_SQL} ORDER BY d.code`).all() as DepartmentRow[];
}

export function getDepartment(db: Database.Database, id: number): DepartmentRow {
  return requireRow(
    db.prepare(`${DEPARTMENT_ROW_SQL} WHERE d.id = ?`).get(id) as DepartmentRow | undefined,
    'Department',
  );
}

export interface DepartmentInput {
  name: string;
  code: string;
  parentId: number | null;
}

function assertCodeFree(db: Database.Database, code: string, excludeId: number | null): void {
  const clash = db
    .prepare('SELECT id FROM departments WHERE code = ? AND id IS NOT ?')
    .get(code, excludeId) as { id: number } | undefined;
  if (clash) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'code', message: `Department code ${code} is already in use` },
    ]);
  }
}

/**
 * Walk the parent chain starting at `parentId`; if it reaches
 * `departmentId` the proposed parent would create a cycle → 422.
 * Called inside the write transaction, so the chain cannot change
 * between check and write.
 */
function assertNoDepartmentCycle(
  db: Database.Database,
  departmentId: number,
  parentId: number | null,
): void {
  const step = db.prepare('SELECT parent_id FROM departments WHERE id = ?');
  let cursor = parentId;
  const seen = new Set<number>();
  while (cursor !== null) {
    if (cursor === departmentId || seen.has(cursor)) {
      throw new DomainError(422, 'Validation failed', [
        { field: 'parent_id', message: 'That parent would make the department its own ancestor' },
      ]);
    }
    seen.add(cursor);
    const row = step.get(cursor) as { parent_id: number | null } | undefined;
    cursor = row ? row.parent_id : null;
  }
}

export function createDepartment(db: Database.Database, input: DepartmentInput): number {
  return db.transaction(() => {
    if (input.parentId !== null) getDepartment(db, input.parentId);
    assertCodeFree(db, input.code, null);
    const info = db
      .prepare('INSERT INTO departments (name, code, parent_id, created_at) VALUES (?, ?, ?, ?)')
      .run(input.name, input.code, input.parentId, nowIso());
    return Number(info.lastInsertRowid);
  })();
}

export function updateDepartment(db: Database.Database, id: number, input: DepartmentInput): void {
  db.transaction(() => {
    getDepartment(db, id);
    if (input.parentId !== null) {
      getDepartment(db, input.parentId);
      if (input.parentId === id) {
        throw new DomainError(422, 'Validation failed', [
          { field: 'parent_id', message: 'A department cannot be its own parent' },
        ]);
      }
      assertNoDepartmentCycle(db, id, input.parentId);
    }
    assertCodeFree(db, input.code, id);
    db.prepare('UPDATE departments SET name = ?, code = ?, parent_id = ? WHERE id = ?').run(
      input.name,
      input.code,
      input.parentId,
      id,
    );
  })();
}

export function deleteDepartment(db: Database.Database, id: number): void {
  db.transaction(() => {
    const dept = getDepartment(db, id);
    if (dept.employee_count > 0) {
      throw new DomainError(
        409,
        'Department still has employees (including offboarded ones) — move them first',
      );
    }
    if (dept.child_count > 0) {
      throw new DomainError(409, 'Department still has child departments — move or delete them first');
    }
    db.prepare('DELETE FROM departments WHERE id = ?').run(id);
  })();
}

// ── Employees ──────────────────────────────────────────────────────────

const EMPLOYEE_ROW_SQL = `
  SELECT e.*, d.name AS department_name, d.code AS department_code,
         m.name AS manager_name,
         (SELECT COUNT(*) FROM employees r
           WHERE r.manager_id = e.id AND r.status = 'active') AS direct_reports
  FROM employees e
  JOIN departments d ON d.id = e.department_id
  LEFT JOIN employees m ON m.id = e.manager_id`;

export interface EmployeeFilters {
  search?: string;
  departmentId?: number;
  location?: string;
  status?: EmployeeStatus;
}

export function listEmployees(db: Database.Database, filters: EmployeeFilters): EmployeeRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (filters.search) {
    where.push('(e.name LIKE @search ESCAPE \'\\\' OR e.email LIKE @search ESCAPE \'\\\' OR e.job_title LIKE @search ESCAPE \'\\\')');
    params.search = likeTerm(filters.search);
  }
  if (filters.departmentId !== undefined) {
    where.push('e.department_id = @department');
    params.department = filters.departmentId;
  }
  if (filters.location) {
    where.push('e.location = @location');
    params.location = filters.location;
  }
  if (filters.status) {
    where.push('e.status = @status');
    params.status = filters.status;
  }
  const sql = `${EMPLOYEE_ROW_SQL}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY e.name`;
  return db.prepare(sql).all(params) as EmployeeRow[];
}

export function getEmployeeRow(db: Database.Database, id: number): EmployeeRow {
  return requireRow(
    db.prepare(`${EMPLOYEE_ROW_SQL} WHERE e.id = ?`).get(id) as EmployeeRow | undefined,
    'Employee',
  );
}

/** Distinct non-empty locations, for the directory filter dropdown. */
export function listLocations(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT DISTINCT location FROM employees WHERE location IS NOT NULL AND location <> '' ORDER BY location",
    )
    .all() as { location: string }[];
  return rows.map((r) => r.location);
}

/** The chain from an employee's immediate manager up to the root. */
export function managerChain(db: Database.Database, employeeId: number): PersonRef[] {
  const step = db.prepare('SELECT id, name, job_title, status, manager_id FROM employees WHERE id = ?');
  const chain: PersonRef[] = [];
  const seen = new Set<number>([employeeId]);
  let cursor = (step.get(employeeId) as { manager_id: number | null } | undefined)?.manager_id ?? null;
  while (cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const row = step.get(cursor) as
      | { id: number; name: string; job_title: string; status: EmployeeStatus; manager_id: number | null }
      | undefined;
    if (!row) break;
    chain.push({ id: row.id, name: row.name, job_title: row.job_title, status: row.status });
    cursor = row.manager_id;
  }
  return chain;
}

function onboardingFlags(db: Database.Database, employeeId: number): OnboardingFlags {
  const row = db
    .prepare('SELECT account_created, hardware_issued, intro_meeting_booked FROM onboarding_checklists WHERE employee_id = ?')
    .get(employeeId) as
    | { account_created: number; hardware_issued: number; intro_meeting_booked: number }
    | undefined;
  return {
    account_created: row?.account_created === 1,
    hardware_issued: row?.hardware_issued === 1,
    intro_meeting_booked: row?.intro_meeting_booked === 1,
  };
}

export function employeeDetail(db: Database.Database, id: number): EmployeeDetail {
  const row = getEmployeeRow(db, id);
  const reports = db
    .prepare('SELECT id, name, job_title, status FROM employees WHERE manager_id = ? ORDER BY name')
    .all(id) as PersonRef[];
  return {
    ...row,
    manager_chain: managerChain(db, id),
    reports,
    onboarding: onboardingFlags(db, id),
  };
}

export interface EmployeeInput {
  name: string;
  email: string;
  jobTitle: string;
  departmentId: number;
  managerId: number | null;
  phone: string | null;
  location: string | null;
  startDate: string;
}

function assertEmailFree(db: Database.Database, email: string, excludeId: number | null): void {
  const clash = db
    .prepare('SELECT id FROM employees WHERE email = ? COLLATE NOCASE AND id IS NOT ?')
    .get(email, excludeId) as { id: number } | undefined;
  if (clash) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'email', message: `Email ${email} is already taken` },
    ]);
  }
}

/**
 * THE core invariant: the manager graph must stay a forest. Walks the
 * manager chain starting at the proposed manager; if it reaches the
 * employee being written, the assignment would create a cycle → 422.
 * Must run inside the same transaction as the write, so the chain
 * cannot change between check and write.
 */
function assertManagerAssignable(
  db: Database.Database,
  employeeId: number | null,
  managerId: number,
): void {
  const fail = (message: string): never => {
    throw new DomainError(422, 'Validation failed', [{ field: 'manager_id', message }]);
  };
  const manager = db
    .prepare('SELECT id, status FROM employees WHERE id = ?')
    .get(managerId) as { id: number; status: EmployeeStatus } | undefined;
  if (!manager) fail('Manager not found');
  if (manager!.status !== 'active') fail('An offboarded employee cannot be a manager');
  if (employeeId === null) return; // a brand-new employee cannot be anyone's ancestor

  if (managerId === employeeId) fail('An employee cannot manage themselves');
  const step = db.prepare('SELECT manager_id FROM employees WHERE id = ?');
  const seen = new Set<number>();
  let cursor: number | null = managerId;
  while (cursor !== null) {
    if (cursor === employeeId) {
      fail('That assignment would create a management cycle — the proposed manager is a (transitive) report of this employee');
    }
    if (seen.has(cursor)) break; // defensive: an existing cycle would loop forever
    seen.add(cursor);
    const row = step.get(cursor) as { manager_id: number | null } | undefined;
    cursor = row ? row.manager_id : null;
  }
}

export interface CreateOptions {
  createdAt?: string;
}

export function createEmployee(
  db: Database.Database,
  input: EmployeeInput,
  options: CreateOptions = {},
): number {
  return db.transaction(() => {
    getDepartment(db, input.departmentId);
    if (input.managerId !== null) assertManagerAssignable(db, null, input.managerId);
    assertEmailFree(db, input.email, null);
    const info = db
      .prepare(
        `INSERT INTO employees (name, email, job_title, department_id, manager_id,
                                phone, location, start_date, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.name,
        input.email,
        input.jobTitle,
        input.departmentId,
        input.managerId,
        input.phone,
        input.location,
        input.startDate,
        options.createdAt ?? nowIso(),
      );
    const id = Number(info.lastInsertRowid);
    db.prepare('INSERT INTO onboarding_checklists (employee_id) VALUES (?)').run(id);
    return id;
  })();
}

export function updateEmployee(db: Database.Database, id: number, input: EmployeeInput): void {
  db.transaction(() => {
    getEmployeeRow(db, id);
    getDepartment(db, input.departmentId);
    if (input.managerId !== null) assertManagerAssignable(db, id, input.managerId);
    assertEmailFree(db, input.email, id);
    db.prepare(
      `UPDATE employees SET name = ?, email = ?, job_title = ?, department_id = ?,
              manager_id = ?, phone = ?, location = ?, start_date = ? WHERE id = ?`,
    ).run(
      input.name,
      input.email,
      input.jobTitle,
      input.departmentId,
      input.managerId,
      input.phone,
      input.location,
      input.startDate,
      id,
    );
  })();
}

/**
 * Soft state change, never a delete: the record and its manager link
 * stay for history, but the employee leaves the org chart. Refused
 * while the employee still has ACTIVE reports — reassign them first,
 * so the chart never orphans a subtree.
 */
export function offboardEmployee(db: Database.Database, id: number, at?: string): void {
  db.transaction(() => {
    const row = getEmployeeRow(db, id);
    if (row.status === 'offboarded') throw new DomainError(409, 'Employee is already offboarded');
    if (row.direct_reports > 0) {
      throw new DomainError(
        409,
        `Employee still has ${row.direct_reports} active direct report(s) — reassign them first`,
      );
    }
    db.prepare("UPDATE employees SET status = 'offboarded', offboarded_at = ? WHERE id = ?").run(
      at ?? nowIso(),
      id,
    );
  })();
}

/** Undo an offboarding. A manager who left in the meantime is cleared. */
export function reactivateEmployee(db: Database.Database, id: number): void {
  db.transaction(() => {
    const row = getEmployeeRow(db, id);
    if (row.status === 'active') throw new DomainError(409, 'Employee is already active');
    const managerActive =
      row.manager_id !== null &&
      (db.prepare('SELECT status FROM employees WHERE id = ?').get(row.manager_id) as { status: string })
        .status === 'active';
    db.prepare(
      "UPDATE employees SET status = 'active', offboarded_at = NULL, manager_id = ? WHERE id = ?",
    ).run(managerActive ? row.manager_id : null, id);
  })();
}

// ── Org chart ──────────────────────────────────────────────────────────

/**
 * The forest of ACTIVE employees. Roots are active employees without a
 * manager (or, defensively, whose manager is not active). Children are
 * sorted by name.
 */
export function orgChart(db: Database.Database): OrgNode[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.name, e.job_title, e.manager_id,
              e.department_id, d.code AS department_code, d.name AS department_name
       FROM employees e JOIN departments d ON d.id = e.department_id
       WHERE e.status = 'active' ORDER BY e.name`,
    )
    .all() as {
    id: number;
    name: string;
    job_title: string;
    manager_id: number | null;
    department_id: number;
    department_code: string;
    department_name: string;
  }[];

  const nodes = new Map<number, OrgNode>();
  for (const row of rows) {
    nodes.set(row.id, {
      id: row.id,
      name: row.name,
      job_title: row.job_title,
      department_id: row.department_id,
      department_code: row.department_code,
      department_name: row.department_name,
      report_count: 0,
      reports: [],
    });
  }
  const roots: OrgNode[] = [];
  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.manager_id !== null ? nodes.get(row.manager_id) : undefined;
    if (parent) {
      parent.reports.push(node);
      parent.report_count += 1;
    } else {
      roots.push(node);
    }
  }
  return roots;
}

// ── Onboarding ─────────────────────────────────────────────────────────

/**
 * "Starting soon / just started": ACTIVE employees whose start date is
 * within the next 30 days or the last 14 days, with their stored
 * checklist flags. The window is relative to `today` (UTC).
 */
export function onboardingLists(db: Database.Database, today = todayIso()): OnboardingLists {
  const from = addDays(today, -14);
  const to = addDays(today, 30);
  const rows = db
    .prepare(
      `SELECT e.id, e.name, e.job_title, e.start_date, d.code AS department_code
       FROM employees e JOIN departments d ON d.id = e.department_id
       WHERE e.status = 'active' AND e.start_date BETWEEN ? AND ?
       ORDER BY e.start_date, e.name`,
    )
    .all(from, to) as { id: number; name: string; job_title: string; start_date: string; department_code: string }[];

  const entries: OnboardingEntry[] = rows.map((row) => ({
    ...row,
    days_until_start: daysBetween(today, row.start_date),
    onboarding: onboardingFlags(db, row.id),
  }));
  return {
    today,
    upcoming: entries.filter((e) => e.days_until_start > 0),
    recent: entries.filter((e) => e.days_until_start <= 0),
  };
}

/** Toggle any subset of the three stored checklist flags. */
export function setOnboardingFlags(
  db: Database.Database,
  employeeId: number,
  patch: Partial<OnboardingFlags>,
): OnboardingFlags {
  return db.transaction(() => {
    getEmployeeRow(db, employeeId);
    // Employees created before the checklist table existed get a row lazily.
    db.prepare('INSERT OR IGNORE INTO onboarding_checklists (employee_id) VALUES (?)').run(employeeId);
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const key of ['account_created', 'hardware_issued', 'intro_meeting_booked'] as const) {
      if (patch[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(patch[key] ? 1 : 0);
      }
    }
    if (sets.length > 0) {
      db.prepare(`UPDATE onboarding_checklists SET ${sets.join(', ')} WHERE employee_id = ?`).run(
        ...params,
        employeeId,
      );
    }
    return onboardingFlags(db, employeeId);
  })();
}
