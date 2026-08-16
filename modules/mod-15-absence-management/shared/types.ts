import type { Region } from './calendar.js';

/**
 * Domain types shared between the Express API and the React client, so the two
 * can never disagree about a status or a leave type.
 */

export interface FieldError {
  field: string;
  message: string;
}

/**
 * Request lifecycle. Only these four values are ever stored.
 *
 * `withdrawn` and `rejected` are kept apart deliberately: one is the employee
 * changing their mind, the other is the approver saying no, and a year later
 * only the distinction explains the pattern. Neither is a deletion — the row
 * and its whole event trail stay.
 */
export const REQUEST_STATUSES = ['pending', 'approved', 'rejected', 'withdrawn'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** Statuses that hold a slot in the calendar and block an overlapping request. */
export const BLOCKING_STATUSES: readonly RequestStatus[] = ['pending', 'approved'];

export interface Employee {
  id: number;
  name: string;
  email: string;
  /** Which public-holiday calendar applies — see shared/calendar.ts. */
  region: Region;
  /** "YYYY-MM-DD". Leave before this date is refused. */
  started_on: string;
  /** Set when they left; the record and its history stay forever. */
  left_on: string | null;
  created_at: string;
}

export interface AbsenceTypeDef {
  key: string;
  label: string;
  /**
   * Whether days of this type come off the annual leave entitlement.
   *
   * Sick leave does not, and that is not a detail: counting it would make a
   * long illness eat someone's holiday, which is both wrong and unlawful in
   * Germany and Austria. Unpaid leave does not either — there is no
   * entitlement to draw down.
   */
  deducts: boolean;
  /** Whether an approver has to act, or the request is recorded as a fact. */
  needsApproval: boolean;
}

export interface Entitlement {
  id: number;
  employee_id: number;
  year: number;
  /** The statutory + contractual days for the year. */
  base_days: number;
  /** Days carried in from the previous year. */
  carry_over_days: number;
  /**
   * When unused carry-over lapses, "YYYY-MM-DD". German and Austrian practice
   * is 31 March of the following year; null means it never expires.
   */
  carry_over_expires_on: string | null;
  created_at: string;
}

export interface AbsenceRequest {
  id: number;
  employee_id: number;
  employee_name: string;
  type: string;
  from_date: string;
  to_date: string;
  half_start: boolean;
  half_end: boolean;
  status: RequestStatus;
  note: string | null;
  /** Derived from the calendar for the employee's region. Never stored. */
  days: number;
  created_at: string;
}

/** One append-only entry in a request's history. */
export interface RequestEvent {
  id: number;
  request_id: number;
  from_status: RequestStatus | null;
  to_status: RequestStatus;
  actor: string;
  note: string | null;
  at: string;
}

export interface RequestDetail extends AbsenceRequest {
  events: RequestEvent[];
  /** The working days this request actually covers, for the calendar view. */
  covered_days: string[];
}

/**
 * An employee's leave position for a year. Every number here is DERIVED at
 * read time from the entitlement and the approved requests — nothing is
 * stored, so nothing can drift.
 */
export interface Balance {
  employee_id: number;
  employee_name: string;
  year: number;
  base_days: number;
  carry_over_days: number;
  /** Carry-over that has already lapsed and can no longer be taken. */
  carry_over_expired_days: number;
  /** base + carry-over still available. */
  entitled_days: number;
  /** Approved and deducting. */
  taken_days: number;
  /** Requested, deducting, not yet decided. */
  pending_days: number;
  /** entitled − taken. What they may still book without going negative. */
  remaining_days: number;
  /** entitled − taken − pending. What is left if everything pending is approved. */
  projected_remaining_days: number;
}
