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
  /** Derived from today's work schedule: ISO weekdays worked, e.g. "12345" (Mon–Fri). */
  work_days: string;
  /** Derived from today's work schedule: the weekly target, null without a flexitime account. */
  weekly_minutes: number | null;
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

// ── Absences (server/leave.ts) ──────────────────────────────────────────

export const LEAVE_TYPES = ['vacation', 'sick', 'special', 'unpaid', 'comp_time'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];
/** What a viewer without the right to see the reason gets instead of the type. */
export type ShownLeaveType = LeaveType | 'absent';

export const LEAVE_STATUSES = ['requested', 'approved', 'rejected', 'withdrawn'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];

export interface LeaveRequest {
  id: number;
  employee_id: number;
  employee_name: string;
  /** `absent` when the viewer may not see that it is sick leave. */
  type: ShownLeaveType;
  start_date: string;
  end_date: string;
  half_day: boolean;
  /** Working days it costs — derived from the dates, work days and holidays. */
  days: number;
  note: string | null;
  status: LeaveStatus;
  created_by: string;
  created_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  /** May the viewer approve or reject it (`manage`, never their own)? */
  can_decide: boolean;
  /** May the viewer withdraw it (their own or `manage`, and not yet begun)? */
  can_withdraw: boolean;
}

export interface LeaveEntitlement {
  id: number;
  employee_id: number;
  year: number;
  kind: 'allowance' | 'carryover' | 'adjustment';
  days: number;
  note: string | null;
  actor: string;
  created_at: string;
}

/** A year's vacation account — all derived. */
export interface LeaveBalance {
  employee_id: number;
  year: number;
  entitled: number;
  /** Approved vacation days in the year. */
  taken: number;
  /** Requested, not yet decided. */
  pending: number;
  /** entitled − taken. */
  remaining: number;
  /** remaining − pending: what a new request may still use. */
  free: number;
}

export interface LeaveSettings {
  country: 'AT' | 'DE';
  /** Regional and company days off (e.g. 24 and 31 December), on top of the statutory ones. */
  extra_holidays: { date: string; name: string }[];
  /** Flexitime above this is overtime — to pay out or take off. Null: no cap. */
  flex_cap_minutes: number | null;
  /** A balance below this is flagged. Null: no floor. */
  flex_floor_minutes: number | null;
  /** Days with more work than this are flagged in the flexitime account. */
  daily_max_minutes: number;
}

export interface CalendarDay {
  date: string;
  weekday: number;
  holiday: string | null;
}

export interface CalendarRow {
  employee_id: number;
  employee_name: string;
  absences: { date: string; type: ShownLeaveType; status: 'requested' | 'approved'; half: boolean }[];
}

// ── Working time and flexitime (server/schedules.ts, server/flextime.ts) ──

/** A working-time model from `valid_from` on — append-only, a change is a new row. */
export interface WorkSchedule {
  id: number;
  employee_id: number;
  valid_from: string;
  /** Null: no flexitime account under this schedule. */
  weekly_minutes: number | null;
  work_days: string;
  note: string | null;
  actor: string;
  created_at: string;
}

export const FLEX_KINDS = ['opening', 'adjustment', 'payout'] as const;
export type FlexKind = (typeof FLEX_KINDS)[number];

export interface FlexEntry {
  id: number;
  employee_id: number;
  kind: FlexKind;
  /** Signed: a payout is negative — it leaves the account. */
  minutes: number;
  effective_date: string;
  note: string | null;
  actor: string;
  created_at: string;
}

/** One day of a flexitime account — all derived. */
export interface FlexDay {
  date: string;
  weekday: number;
  holiday: string | null;
  /** False before the account starts or under a schedule without a target. */
  tracked: boolean;
  /** The schedule's minutes for this weekday (0 on days off and holidays). */
  target: number;
  /** Target covered by an absence (vacation, sick, special, unpaid — not comp time). */
  credited: number;
  /** target − credited: what the day asks for. */
  due: number;
  worked: number;
  /** worked − due (0 on untracked days). */
  diff: number;
  absence: ShownLeaveType | null;
  absence_half: boolean;
  /** More worked than the daily maximum in the settings. */
  over_max: boolean;
}

export interface FlexMonth {
  month: string;
  due: number;
  worked: number;
  diff: number;
  /** Ledger rows dated in the month other than payouts (opening, corrections). */
  booked: number;
  /** Overtime paid out in the month, as a positive number of minutes. */
  paid_out: number;
  balance_end: number;
}

export interface FlexAccount {
  employee_id: number;
  employee_name: string;
  /** First day with a target; null: this person has no flexitime account. */
  start: string | null;
  as_of: string;
  balance: number;
  cap: number | null;
  floor: number | null;
  /** Overtime: the balance above the cap (0 under it, or without a cap). */
  over_cap: number;
  /** How far below the floor (0 above it). */
  under_floor: number;
  months: FlexMonth[];
}
