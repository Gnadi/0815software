/**
 * Domain types shared between the Express API and the React client.
 * The single source of truth for statuses lives here so server and
 * client can never disagree.
 */

/**
 * Employee lifecycle. There is no hard delete — an employee who leaves
 * is OFFBOARDED: the record (and everything that references it) stays
 * for history, but the employee disappears from the org chart and from
 * the default directory view.
 */
export const EMPLOYEE_STATUSES = ['active', 'offboarded'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export interface Department {
  id: number;
  name: string;
  code: string;
  parent_id: number | null;
  created_at: string;
}

/** One row of the department list — counts are derived, never stored. */
export interface DepartmentRow extends Department {
  parent_name: string | null;
  /** Employees in this department, any status (offboarded keep history). */
  employee_count: number;
  child_count: number;
}

export interface Employee {
  id: number;
  name: string;
  email: string;
  job_title: string;
  department_id: number;
  manager_id: number | null;
  phone: string | null;
  location: string | null;
  /** "YYYY-MM-DD" — drives the onboarding view. */
  start_date: string;
  status: EmployeeStatus;
  offboarded_at: string | null;
  created_at: string;
}

/** One row of the directory list. */
export interface EmployeeRow extends Employee {
  department_name: string;
  department_code: string;
  manager_name: string | null;
  /** ACTIVE direct reports — what the org chart shows. */
  direct_reports: number;
}

/** A link in the manager chain / a direct report. */
export interface PersonRef {
  id: number;
  name: string;
  job_title: string;
  status: EmployeeStatus;
}

/** The three stored HR-onboarding checklist flags. */
export interface OnboardingFlags {
  account_created: boolean;
  hardware_issued: boolean;
  intro_meeting_booked: boolean;
}

export interface EmployeeDetail extends EmployeeRow {
  /** Immediate manager first, root last. Empty for roots. */
  manager_chain: PersonRef[];
  /** Direct reports (any status, so history stays visible). */
  reports: PersonRef[];
  onboarding: OnboardingFlags;
}

/** One node of the org chart tree (active employees only). */
export interface OrgNode {
  id: number;
  name: string;
  job_title: string;
  department_id: number;
  department_code: string;
  department_name: string;
  /** Direct active reports = reports.length, precomputed for the UI. */
  report_count: number;
  reports: OrgNode[];
}

/** One row of the onboarding view. */
export interface OnboardingEntry {
  id: number;
  name: string;
  job_title: string;
  department_code: string;
  start_date: string;
  /** Negative = already started that many days ago. */
  days_until_start: number;
  onboarding: OnboardingFlags;
}

export interface OnboardingLists {
  today: string;
  /** start_date in (today, today + 30 days]. */
  upcoming: OnboardingEntry[];
  /** start_date in [today − 14 days, today]. */
  recent: OnboardingEntry[];
}

export interface FieldError {
  field: string;
  message: string;
}
