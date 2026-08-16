/**
 * Domain types shared between the Express API and the React client, so the
 * two can never disagree about a status, a category or an outcome.
 */

export interface FieldError {
  field: string;
  message: string;
}

export const CASE_STATUSES = ['received', 'acknowledged', 'investigating', 'closed'] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export type CaseCategory =
  | 'corruption'
  | 'fraud'
  | 'procurement'
  | 'competition'
  | 'data_protection'
  | 'product_safety'
  | 'environment'
  | 'workplace_safety'
  | 'discrimination'
  | 'other';

export type CaseOutcome =
  | 'substantiated'
  | 'partly_substantiated'
  | 'unsubstantiated'
  | 'out_of_scope'
  | 'referred'
  | 'insufficient_information';

/**
 * Where a message can be read.
 *
 * `reporter` messages are the two-way channel the directive requires: the
 * person who filed can read them with their access code, without ever
 * identifying themselves. `internal` notes are for the case handler and are
 * never returned by a public route — a single `visibility` column decides
 * it, in one place, rather than each handler remembering to filter.
 */
export const MESSAGE_VISIBILITIES = ['reporter', 'internal'] as const;
export type MessageVisibility = (typeof MESSAGE_VISIBILITIES)[number];

/**
 * The state of one statutory deadline, derived from the clock on every read.
 *
 * `missed` is deliberately not `breached`: the obligation still exists after
 * the date passes, and the module keeps showing it as owed rather than
 * writing the case off.
 */
export type DeadlineState = 'met' | 'missed' | 'at_risk' | 'upcoming';

export interface Deadline {
  /** ISO instant the obligation falls due. */
  due_at: string;
  /** ISO instant it was actually fulfilled, or null. */
  met_at: string | null;
  state: DeadlineState;
  /** Whole days from now to `due_at`; negative once it has passed. */
  days_remaining: number;
}

/** What the case handler sees in the queue. */
export interface CaseRow {
  id: number;
  ref: string;
  category: CaseCategory;
  subject: string | null;
  status: CaseStatus;
  outcome: CaseOutcome | null;
  /** True when the reporter left no contact details at all. */
  anonymous: boolean;
  received_at: string;
  acknowledge: Deadline;
  feedback: Deadline;
  /** Set once the documentation has been erased under § 11 Abs. 5 HinSchG. */
  erased_at: string | null;
  /** When the retention period ends. Null until the case is closed. */
  erase_due_on: string | null;
}

export interface CaseMessage {
  id: number;
  author: string;
  author_type: 'handler' | 'reporter' | 'system';
  visibility: MessageVisibility;
  body: string | null;
  created_at: string;
}

export interface CaseEvent {
  id: number;
  type: 'received' | 'status_change' | 'message' | 'erased';
  actor: string;
  from_status: CaseStatus | null;
  to_status: CaseStatus | null;
  outcome: CaseOutcome | null;
  created_at: string;
}

export interface CaseDetail extends CaseRow {
  body: string | null;
  /** Whatever contact details the reporter chose to give, verbatim. */
  contact: string | null;
  messages: CaseMessage[];
  events: CaseEvent[];
}

/**
 * What the REPORTER sees when they come back with their access code.
 *
 * A separate type on purpose. The handler's view and the reporter's view are
 * different documents, and building the second by deleting fields from the
 * first is how internal notes end up in a public response.
 */
export interface ReporterView {
  ref: string;
  category: CaseCategory;
  subject: string | null;
  status: CaseStatus;
  outcome: CaseOutcome | null;
  received_at: string;
  body: string | null;
  erased_at: string | null;
  /** Only `reporter`-visible messages, never internal notes. */
  messages: CaseMessage[];
  /** The dates the organisation owes this reporter something by. */
  acknowledge_due_at: string;
  feedback_due_at: string;
  acknowledged_at: string | null;
}

/** The one-time result of filing a report. */
export interface IntakeResult {
  ref: string;
  /**
   * The access code, in the only response that will ever contain it. The
   * server keeps a hash, so a lost code cannot be recovered by anyone.
   */
  code: string;
  acknowledge_due_at: string;
}
