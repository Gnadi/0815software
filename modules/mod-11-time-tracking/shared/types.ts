/**
 * Domain types shared between the Express API and the React client.
 * The single source of truth for the timesheet statuses lives here so
 * server and client can never disagree.
 */

/**
 * STORED weekly-timesheet status. Only three values ever hit the
 * database:
 *   draft      the default; entries fully editable
 *   submitted  handed in for review; awaiting a decision
 *   approved   signed off — its entries are LOCKED (edits/deletes → 409)
 * "rejected" is NOT a stored status: rejecting a submitted week returns
 * it to `draft` and records an append-only event, so a rejected week is
 * simply an editable draft again with a rejection in its history.
 */
export const TIMESHEET_STATUSES = ['draft', 'submitted', 'approved'] as const;
export type TimesheetStatus = (typeof TIMESHEET_STATUSES)[number];

/** Append-only status-event actions written on every transition. */
export const TIMESHEET_ACTIONS = ['submit', 'approve', 'reject'] as const;
export type TimesheetAction = (typeof TIMESHEET_ACTIONS)[number];

export interface Project {
  id: number;
  name: string;
  client: string | null;
  billable_default: boolean;
  rate_cents: number;
  active: boolean;
  created_at: string;
  /** Derived: number of time entries booked against this project. */
  entry_count: number;
  tasks: Task[];
}

export interface Task {
  id: number;
  project_id: number;
  name: string;
  active: boolean;
  /** Derived: number of time entries booked against this task. */
  entry_count: number;
}

export interface Employee {
  id: number;
  name: string;
  email: string | null;
  created_at: string;
  /** Derived: number of time entries booked by this employee. */
  entry_count: number;
}

export interface TimeEntry {
  id: number;
  employee_id: number;
  employee_name: string;
  project_id: number;
  project_name: string;
  client: string | null;
  task_id: number | null;
  task_name: string | null;
  entry_date: string;
  minutes: number;
  billable: boolean;
  note: string | null;
  /** Derived: round(minutes × rate_cents ÷ 60) when billable, else 0. */
  billable_cents: number;
  rate_cents: number;
  /** Derived: Monday of the entry's week. */
  week_start: string;
  /** Derived: status of the (employee, week) timesheet — approved ⇒ locked. */
  timesheet_status: TimesheetStatus;
  locked: boolean;
  created_at: string;
}

/** A day's worth of entries for the daily-entry grid. */
export interface DaySheet {
  employee_id: number;
  date: string;
  week_start: string;
  timesheet_status: TimesheetStatus;
  locked: boolean;
  entries: TimeEntry[];
  total_minutes: number;
  billable_minutes: number;
  billable_cents: number;
  /** Minutes still bookable before hitting the 24h/day cap. */
  remaining_minutes: number;
}

export interface TimesheetEvent {
  id: number;
  action: TimesheetAction;
  from_status: TimesheetStatus;
  to_status: TimesheetStatus;
  actor: string;
  note: string | null;
  created_at: string;
}

/** One row of the per-employee timesheet list. */
export interface TimesheetRow {
  employee_id: number;
  week_start: string;
  week_end: string;
  status: TimesheetStatus;
  total_minutes: number;
  billable_minutes: number;
  billable_cents: number;
  entry_count: number;
}

export interface TimesheetDetail extends TimesheetRow {
  employee_name: string;
  entries: TimeEntry[];
  /** Per-project rollup within the week. */
  by_project: ProjectRollup[];
  events: TimesheetEvent[];
}

/** A derived rollup line (per project or per employee). */
export interface ProjectRollup {
  project_id: number;
  project_name: string;
  client: string | null;
  total_minutes: number;
  billable_minutes: number;
  billable_cents: number;
  entry_count: number;
}

export interface EmployeeRollup {
  employee_id: number;
  employee_name: string;
  total_minutes: number;
  billable_minutes: number;
  billable_cents: number;
  entry_count: number;
}

export interface FieldError {
  field: string;
  message: string;
}

/** A CSV export profile as advertised to the client (export page). */
export interface ExportProfileInfo {
  name: string;
  description: string;
  scope: 'employee' | 'project' | 'entry';
  delimiter: string;
  columns: { header: string }[];
}
