import type Database from 'better-sqlite3';
import { billableCents, MAX_MINUTES_PER_DAY, weekEndOf, weekStartOf } from '../shared/time.js';
import type {
  DaySheet,
  Employee,
  EmployeeRollup,
  Project,
  ProjectRollup,
  Task,
  TimeEntry,
  TimesheetAction,
  TimesheetDetail,
  TimesheetEvent,
  TimesheetRow,
  TimesheetStatus,
} from '../shared/types.js';

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

/** "YYYY-MM-DD" for today (UTC) — the default entry date. */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function requireRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new DomainError(404, `${what} not found`);
  return row;
}

// ── Projects & tasks ─────────────────────────────────────────────────

interface ProjectStored {
  id: number;
  name: string;
  client: string | null;
  billable_default: number;
  rate_cents: number;
  active: number;
  created_at: string;
}

function tasksOf(db: Database.Database, projectId: number): Task[] {
  const rows = db
    .prepare('SELECT id, project_id, name, active FROM tasks WHERE project_id = ? ORDER BY name')
    .all(projectId) as { id: number; project_id: number; name: string; active: number }[];
  return rows.map((t) => ({
    id: t.id,
    project_id: t.project_id,
    name: t.name,
    active: t.active === 1,
    entry_count: (
      db.prepare('SELECT COUNT(*) AS n FROM time_entries WHERE task_id = ?').get(t.id) as { n: number }
    ).n,
  }));
}

function toProject(db: Database.Database, row: ProjectStored): Project {
  return {
    id: row.id,
    name: row.name,
    client: row.client,
    billable_default: row.billable_default === 1,
    rate_cents: row.rate_cents,
    active: row.active === 1,
    created_at: row.created_at,
    entry_count: (
      db.prepare('SELECT COUNT(*) AS n FROM time_entries WHERE project_id = ?').get(row.id) as {
        n: number;
      }
    ).n,
    tasks: tasksOf(db, row.id),
  };
}

export function getProject(db: Database.Database, id: number): Project {
  const row = requireRow(
    db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectStored | undefined,
    'Project',
  );
  return toProject(db, row);
}

export function listProjects(db: Database.Database, includeArchived = true): Project[] {
  const rows = db
    .prepare(`SELECT * FROM projects ${includeArchived ? '' : 'WHERE active = 1'} ORDER BY active DESC, name`)
    .all() as ProjectStored[];
  return rows.map((r) => toProject(db, r));
}

export interface ProjectInput {
  name: string;
  client: string | null;
  billableDefault: boolean;
  rateCents: number;
  active: boolean;
}

export function createProject(db: Database.Database, input: ProjectInput): number {
  const info = db
    .prepare(
      `INSERT INTO projects (name, client, billable_default, rate_cents, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.name,
      input.client,
      input.billableDefault ? 1 : 0,
      input.rateCents,
      input.active ? 1 : 0,
      nowIso(),
    );
  return Number(info.lastInsertRowid);
}

export function updateProject(db: Database.Database, id: number, input: ProjectInput): void {
  getProject(db, id);
  db.prepare(
    'UPDATE projects SET name = ?, client = ?, billable_default = ?, rate_cents = ?, active = ? WHERE id = ?',
  ).run(input.name, input.client, input.billableDefault ? 1 : 0, input.rateCents, input.active ? 1 : 0, id);
}

/** Delete a project. One with time entries cannot be deleted → 409 (archive instead). */
export function deleteProject(db: Database.Database, id: number): void {
  getProject(db, id);
  const used = db.prepare('SELECT COUNT(*) AS n FROM time_entries WHERE project_id = ?').get(id) as {
    n: number;
  };
  if (used.n > 0) {
    throw new DomainError(409, 'Project has time entries and cannot be deleted — archive it instead');
  }
  db.prepare('DELETE FROM projects WHERE id = ?').run(id); // cascades to tasks (all unused)
}

export function createTask(db: Database.Database, projectId: number, name: string): number {
  getProject(db, projectId);
  const info = db
    .prepare('INSERT INTO tasks (project_id, name, active) VALUES (?, ?, 1)')
    .run(projectId, name);
  return Number(info.lastInsertRowid);
}

export function updateTask(db: Database.Database, id: number, name: string, active: boolean): void {
  const existing = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
  requireRow(existing, 'Task');
  db.prepare('UPDATE tasks SET name = ?, active = ? WHERE id = ?').run(name, active ? 1 : 0, id);
}

export function deleteTask(db: Database.Database, id: number): void {
  const existing = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
  requireRow(existing, 'Task');
  const used = db.prepare('SELECT COUNT(*) AS n FROM time_entries WHERE task_id = ?').get(id) as {
    n: number;
  };
  if (used.n > 0) {
    throw new DomainError(409, 'Task has time entries and cannot be deleted — deactivate it instead');
  }
  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

// ── Employees ────────────────────────────────────────────────────────

interface EmployeeStored {
  id: number;
  name: string;
  email: string | null;
  created_at: string;
}

function toEmployee(db: Database.Database, row: EmployeeStored): Employee {
  return {
    ...row,
    entry_count: (
      db.prepare('SELECT COUNT(*) AS n FROM time_entries WHERE employee_id = ?').get(row.id) as {
        n: number;
      }
    ).n,
  };
}

export function getEmployee(db: Database.Database, id: number): Employee {
  const row = requireRow(
    db.prepare('SELECT * FROM employees WHERE id = ?').get(id) as EmployeeStored | undefined,
    'Employee',
  );
  return toEmployee(db, row);
}

export function listEmployees(db: Database.Database): Employee[] {
  const rows = db.prepare('SELECT * FROM employees ORDER BY name').all() as EmployeeStored[];
  return rows.map((r) => toEmployee(db, r));
}

export interface EmployeeInput {
  name: string;
  email: string | null;
}

export function createEmployee(db: Database.Database, input: EmployeeInput): number {
  const info = db
    .prepare('INSERT INTO employees (name, email, created_at) VALUES (?, ?, ?)')
    .run(input.name, input.email, nowIso());
  return Number(info.lastInsertRowid);
}

export function updateEmployee(db: Database.Database, id: number, input: EmployeeInput): void {
  getEmployee(db, id);
  db.prepare('UPDATE employees SET name = ?, email = ? WHERE id = ?').run(input.name, input.email, id);
}

export function deleteEmployee(db: Database.Database, id: number): void {
  getEmployee(db, id);
  const used = db.prepare('SELECT COUNT(*) AS n FROM time_entries WHERE employee_id = ?').get(id) as {
    n: number;
  };
  if (used.n > 0) {
    throw new DomainError(409, 'Employee has time entries and cannot be deleted');
  }
  db.prepare('DELETE FROM employees WHERE id = ?').run(id);
}

// ── Timesheet status (stored per (employee, week)) ───────────────────

/** Stored status of a week, or the implicit 'draft' when no row exists. */
export function timesheetStatus(
  db: Database.Database,
  employeeId: number,
  weekStart: string,
): TimesheetStatus {
  const row = db
    .prepare('SELECT status FROM timesheets WHERE employee_id = ? AND week_start = ?')
    .get(employeeId, weekStart) as { status: TimesheetStatus } | undefined;
  return row?.status ?? 'draft';
}

function assertWeekEditable(db: Database.Database, employeeId: number, weekStart: string): void {
  if (timesheetStatus(db, employeeId, weekStart) === 'approved') {
    throw new DomainError(
      409,
      `The week of ${weekStart} is approved and locked — reopen it before changing its entries`,
    );
  }
}

// ── Time entries ─────────────────────────────────────────────────────

interface EntryStored {
  id: number;
  employee_id: number;
  project_id: number;
  task_id: number | null;
  entry_date: string;
  minutes: number;
  billable: number;
  note: string | null;
  created_at: string;
}

/** Join an entry row with its project/employee/task labels and derived money. */
function toEntry(db: Database.Database, row: EntryStored): TimeEntry {
  const project = db
    .prepare('SELECT name, client, rate_cents FROM projects WHERE id = ?')
    .get(row.project_id) as { name: string; client: string | null; rate_cents: number };
  const employee = db.prepare('SELECT name FROM employees WHERE id = ?').get(row.employee_id) as {
    name: string;
  };
  const task = row.task_id
    ? (db.prepare('SELECT name FROM tasks WHERE id = ?').get(row.task_id) as { name: string })
    : null;
  const billable = row.billable === 1;
  const weekStart = weekStartOf(row.entry_date);
  const status = timesheetStatus(db, row.employee_id, weekStart);
  return {
    id: row.id,
    employee_id: row.employee_id,
    employee_name: employee.name,
    project_id: row.project_id,
    project_name: project.name,
    client: project.client,
    task_id: row.task_id,
    task_name: task?.name ?? null,
    entry_date: row.entry_date,
    minutes: row.minutes,
    billable,
    note: row.note,
    billable_cents: billable ? billableCents(row.minutes, project.rate_cents) : 0,
    rate_cents: project.rate_cents,
    week_start: weekStart,
    timesheet_status: status,
    locked: status === 'approved',
    created_at: row.created_at,
  };
}

export function getEntry(db: Database.Database, id: number): TimeEntry {
  const row = requireRow(
    db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id) as EntryStored | undefined,
    'Time entry',
  );
  return toEntry(db, row);
}

export interface EntryInput {
  employeeId: number;
  projectId: number;
  taskId: number | null;
  entryDate: string;
  minutes: number;
  /** Omit to inherit the project's billable_default. */
  billable: boolean | null;
  note: string | null;
  createdAt?: string;
}

/** Resolve project/task references and the effective billable flag, or throw 422/404. */
function resolveRefs(db: Database.Database, input: EntryInput): { billable: boolean } {
  getEmployee(db, input.employeeId);
  const project = db
    .prepare('SELECT billable_default FROM projects WHERE id = ?')
    .get(input.projectId) as { billable_default: number } | undefined;
  requireRow(project, 'Project');
  if (input.taskId !== null) {
    const task = db.prepare('SELECT project_id FROM tasks WHERE id = ?').get(input.taskId) as
      | { project_id: number }
      | undefined;
    requireRow(task, 'Task');
    if (task!.project_id !== input.projectId) {
      throw new DomainError(422, 'Validation failed', [
        { field: 'task_id', message: 'Task does not belong to the selected project' },
      ]);
    }
  }
  return { billable: input.billable ?? project!.billable_default === 1 };
}

/** Enforce the 24h/day cap across ALL of an (employee, date)'s entries. */
function assertDailyCap(
  db: Database.Database,
  employeeId: number,
  date: string,
  addingMinutes: number,
  excludeEntryId: number | null,
): void {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(minutes), 0) AS total FROM time_entries
       WHERE employee_id = ? AND entry_date = ? AND id IS NOT ?`,
    )
    .get(employeeId, date, excludeEntryId) as { total: number };
  if (row.total + addingMinutes > MAX_MINUTES_PER_DAY) {
    throw new DomainError(422, 'Validation failed', [
      {
        field: 'minutes',
        message: `Daily total would be ${row.total + addingMinutes} min, over the 24h (1440 min) cap for ${date}`,
      },
    ]);
  }
}

export function createEntry(db: Database.Database, input: EntryInput): number {
  const { billable } = resolveRefs(db, input);
  return db.transaction(() => {
    assertWeekEditable(db, input.employeeId, weekStartOf(input.entryDate));
    assertDailyCap(db, input.employeeId, input.entryDate, input.minutes, null);
    const info = db
      .prepare(
        `INSERT INTO time_entries (employee_id, project_id, task_id, entry_date, minutes, billable, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.employeeId,
        input.projectId,
        input.taskId,
        input.entryDate,
        input.minutes,
        billable ? 1 : 0,
        input.note,
        input.createdAt ?? nowIso(),
      );
    return Number(info.lastInsertRowid);
  })();
}

/** Replace an entry. Refused (409) if either the old or new week is approved. */
export function updateEntry(db: Database.Database, id: number, input: EntryInput): void {
  const existing = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id) as
    | EntryStored
    | undefined;
  requireRow(existing, 'Time entry');
  const { billable } = resolveRefs(db, input);
  db.transaction(() => {
    // Both the entry's current week and its target week must be unlocked:
    // you can neither pull an entry out of an approved week nor push one in.
    assertWeekEditable(db, existing!.employee_id, weekStartOf(existing!.entry_date));
    assertWeekEditable(db, input.employeeId, weekStartOf(input.entryDate));
    assertDailyCap(db, input.employeeId, input.entryDate, input.minutes, id);
    db.prepare(
      `UPDATE time_entries
       SET employee_id = ?, project_id = ?, task_id = ?, entry_date = ?, minutes = ?, billable = ?, note = ?
       WHERE id = ?`,
    ).run(
      input.employeeId,
      input.projectId,
      input.taskId,
      input.entryDate,
      input.minutes,
      billable ? 1 : 0,
      input.note,
      id,
    );
  })();
}

export function deleteEntry(db: Database.Database, id: number): void {
  const existing = db.prepare('SELECT * FROM time_entries WHERE id = ?').get(id) as
    | EntryStored
    | undefined;
  requireRow(existing, 'Time entry');
  assertWeekEditable(db, existing!.employee_id, weekStartOf(existing!.entry_date));
  db.prepare('DELETE FROM time_entries WHERE id = ?').run(id);
}

function entriesWhere(db: Database.Database, sql: string, params: unknown[]): TimeEntry[] {
  const rows = db.prepare(`SELECT * FROM time_entries ${sql}`).all(...params) as EntryStored[];
  return rows.map((r) => toEntry(db, r));
}

// ── Daily grid ───────────────────────────────────────────────────────

export function daySheet(db: Database.Database, employeeId: number, date: string): DaySheet {
  getEmployee(db, employeeId);
  const entries = entriesWhere(
    db,
    'WHERE employee_id = ? AND entry_date = ? ORDER BY id',
    [employeeId, date],
  );
  const weekStart = weekStartOf(date);
  const status = timesheetStatus(db, employeeId, weekStart);
  const totalMinutes = entries.reduce((s, e) => s + e.minutes, 0);
  const billableMinutes = entries.filter((e) => e.billable).reduce((s, e) => s + e.minutes, 0);
  return {
    employee_id: employeeId,
    date,
    week_start: weekStart,
    timesheet_status: status,
    locked: status === 'approved',
    entries,
    total_minutes: totalMinutes,
    billable_minutes: billableMinutes,
    billable_cents: entries.reduce((s, e) => s + e.billable_cents, 0),
    remaining_minutes: Math.max(0, MAX_MINUTES_PER_DAY - totalMinutes),
  };
}

// ── Rollups (derived by query) ───────────────────────────────────────

function rollupByProject(entries: TimeEntry[]): ProjectRollup[] {
  const map = new Map<number, ProjectRollup>();
  for (const e of entries) {
    let r = map.get(e.project_id);
    if (!r) {
      r = {
        project_id: e.project_id,
        project_name: e.project_name,
        client: e.client,
        total_minutes: 0,
        billable_minutes: 0,
        billable_cents: 0,
        entry_count: 0,
      };
      map.set(e.project_id, r);
    }
    r.total_minutes += e.minutes;
    if (e.billable) r.billable_minutes += e.minutes;
    r.billable_cents += e.billable_cents;
    r.entry_count += 1;
  }
  return [...map.values()].sort((a, b) => b.total_minutes - a.total_minutes);
}

function rollupByEmployee(entries: TimeEntry[]): EmployeeRollup[] {
  const map = new Map<number, EmployeeRollup>();
  for (const e of entries) {
    let r = map.get(e.employee_id);
    if (!r) {
      r = {
        employee_id: e.employee_id,
        employee_name: e.employee_name,
        total_minutes: 0,
        billable_minutes: 0,
        billable_cents: 0,
        entry_count: 0,
      };
      map.set(e.employee_id, r);
    }
    r.total_minutes += e.minutes;
    if (e.billable) r.billable_minutes += e.minutes;
    r.billable_cents += e.billable_cents;
    r.entry_count += 1;
  }
  return [...map.values()].sort((a, b) => b.total_minutes - a.total_minutes);
}

export interface RangeSummary {
  from: string;
  to: string;
  by_project: ProjectRollup[];
  by_employee: EmployeeRollup[];
  total_minutes: number;
  billable_minutes: number;
  billable_cents: number;
}

/** Per-project and per-employee rollups over an inclusive date range. */
export function rangeSummary(db: Database.Database, from: string, to: string): RangeSummary {
  const entries = entriesWhere(db, 'WHERE entry_date BETWEEN ? AND ?', [from, to]);
  return {
    from,
    to,
    by_project: rollupByProject(entries),
    by_employee: rollupByEmployee(entries),
    total_minutes: entries.reduce((s, e) => s + e.minutes, 0),
    billable_minutes: entries.filter((e) => e.billable).reduce((s, e) => s + e.minutes, 0),
    billable_cents: entries.reduce((s, e) => s + e.billable_cents, 0),
  };
}

// ── Weekly timesheets & approval ─────────────────────────────────────

function weekEntries(db: Database.Database, employeeId: number, weekStart: string): TimeEntry[] {
  return entriesWhere(
    db,
    'WHERE employee_id = ? AND entry_date BETWEEN ? AND ? ORDER BY entry_date, id',
    [employeeId, weekStart, weekEndOf(weekStart)],
  );
}

function timesheetRow(db: Database.Database, employeeId: number, weekStart: string): TimesheetRow {
  const entries = weekEntries(db, employeeId, weekStart);
  return {
    employee_id: employeeId,
    week_start: weekStart,
    week_end: weekEndOf(weekStart),
    status: timesheetStatus(db, employeeId, weekStart),
    total_minutes: entries.reduce((s, e) => s + e.minutes, 0),
    billable_minutes: entries.filter((e) => e.billable).reduce((s, e) => s + e.minutes, 0),
    billable_cents: entries.reduce((s, e) => s + e.billable_cents, 0),
    entry_count: entries.length,
  };
}

/** Every week an employee has activity in (entries OR a stored status), newest first. */
export function listTimesheets(db: Database.Database, employeeId: number): TimesheetRow[] {
  getEmployee(db, employeeId);
  const weeks = new Set<string>();
  const fromEntries = db
    .prepare('SELECT DISTINCT entry_date FROM time_entries WHERE employee_id = ?')
    .all(employeeId) as { entry_date: string }[];
  for (const r of fromEntries) weeks.add(weekStartOf(r.entry_date));
  const fromSheets = db
    .prepare('SELECT week_start FROM timesheets WHERE employee_id = ?')
    .all(employeeId) as { week_start: string }[];
  for (const r of fromSheets) weeks.add(r.week_start);
  return [...weeks]
    .sort((a, b) => (a < b ? 1 : -1))
    .map((w) => timesheetRow(db, employeeId, w));
}

function timesheetEvents(db: Database.Database, employeeId: number, weekStart: string): TimesheetEvent[] {
  const rows = db
    .prepare(
      `SELECT id, action, from_status, to_status, actor, note, created_at
       FROM timesheet_events WHERE employee_id = ? AND week_start = ? ORDER BY id`,
    )
    .all(employeeId, weekStart) as TimesheetEvent[];
  return rows;
}

export function timesheetDetail(
  db: Database.Database,
  employeeId: number,
  weekStart: string,
): TimesheetDetail {
  const employee = getEmployee(db, employeeId);
  const row = timesheetRow(db, employeeId, weekStart);
  const entries = weekEntries(db, employeeId, weekStart);
  return {
    ...row,
    employee_name: employee.name,
    entries,
    by_project: rollupByProject(entries),
    events: timesheetEvents(db, employeeId, weekStart),
  };
}

/** Write the stored status and append the matching history event, atomically. */
function transition(
  db: Database.Database,
  employeeId: number,
  weekStart: string,
  action: TimesheetAction,
  from: TimesheetStatus,
  to: TimesheetStatus,
  actor: string,
  note: string | null,
): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO timesheets (employee_id, week_start, status, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (employee_id, week_start) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
    ).run(employeeId, weekStart, to, nowIso());
    db.prepare(
      `INSERT INTO timesheet_events (employee_id, week_start, action, from_status, to_status, actor, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(employeeId, weekStart, action, from, to, actor, note, nowIso());
  })();
}

export function submitTimesheet(
  db: Database.Database,
  employeeId: number,
  weekStart: string,
  actor: string,
): TimesheetDetail {
  getEmployee(db, employeeId);
  const status = timesheetStatus(db, employeeId, weekStart);
  if (status !== 'draft') {
    throw new DomainError(409, `Only a draft week can be submitted (current status: ${status})`);
  }
  const count = db
    .prepare('SELECT COUNT(*) AS n FROM time_entries WHERE employee_id = ? AND entry_date BETWEEN ? AND ?')
    .get(employeeId, weekStart, weekEndOf(weekStart)) as { n: number };
  if (count.n === 0) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'week_start', message: 'Cannot submit a week with no time entries' },
    ]);
  }
  transition(db, employeeId, weekStart, 'submit', 'draft', 'submitted', actor, null);
  return timesheetDetail(db, employeeId, weekStart);
}

export function approveTimesheet(
  db: Database.Database,
  employeeId: number,
  weekStart: string,
  actor: string,
  note: string | null,
): TimesheetDetail {
  getEmployee(db, employeeId);
  const status = timesheetStatus(db, employeeId, weekStart);
  if (status !== 'submitted') {
    throw new DomainError(409, `Only a submitted week can be approved (current status: ${status})`);
  }
  transition(db, employeeId, weekStart, 'approve', 'submitted', 'approved', actor, note);
  return timesheetDetail(db, employeeId, weekStart);
}

/** Reject a submitted week: it returns to `draft` and the rejection is recorded. */
export function rejectTimesheet(
  db: Database.Database,
  employeeId: number,
  weekStart: string,
  actor: string,
  note: string | null,
): TimesheetDetail {
  getEmployee(db, employeeId);
  const status = timesheetStatus(db, employeeId, weekStart);
  if (status !== 'submitted') {
    throw new DomainError(409, `Only a submitted week can be rejected (current status: ${status})`);
  }
  transition(db, employeeId, weekStart, 'reject', 'submitted', 'draft', actor, note);
  return timesheetDetail(db, employeeId, weekStart);
}
