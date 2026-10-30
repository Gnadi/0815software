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

// ── Self-service (server/profile.ts) ───────────────────────────────────

/** What only the person and HR see — never the directory. */
export interface PrivateData {
  employee_id: number;
  private_phone: string | null;
  /** Changed through a request HR approves. */
  address: string | null;
  emergency_name: string | null;
  emergency_relation: string | null;
  emergency_phone: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

/** Fields that change only with HR's approval. */
export type RequestField = 'name' | 'address';

export type ProfileField = 'phone' | 'private_phone' | 'emergency_name' | 'emergency_relation' | 'emergency_phone' | RequestField | 'private_data';

export interface ProfileRequest {
  id: number;
  employee_id: number;
  employee_name: string;
  field: RequestField;
  /** What it is now — derived from the record, so it is always today's. */
  current: string | null;
  proposed: string;
  reason: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  requested_by: string;
  requested_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
}

/** One change to a record: which field, how and by whom — never the values. */
export interface ProfileChange {
  id: number;
  field: ProfileField;
  via: 'self' | 'request' | 'hr' | 'erased';
  request_id: number | null;
  actor: string;
  at: string;
}

export interface OwnProfile {
  employee: EmployeeRow;
  private: PrivateData;
  requests: ProfileRequest[];
  changes: ProfileChange[];
}
