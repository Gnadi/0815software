/**
 * Domain types shared between the Express API and the React client.
 * The single source of truth for statuses and categories lives here so
 * server and client can never disagree.
 *
 * PERSPECTIVE: this is the APPLICANT / RECIPIENT view. "We" are a company
 * that discovers funding programs, applies to them, gets some approved,
 * receives the money in tranches, and then owes post-award reports. Money
 * flows TOWARD us; we never distribute it to third parties.
 */

// ── Application lifecycle ──────────────────────────────────────────────
/**
 * The status of one of OUR applications. Stored on the application row as
 * the folded head of an append-only event timeline (server/applications.ts).
 *   draft         being prepared, editable
 *   submitted     handed to the funding body, frozen
 *   under_review  the body is assessing it
 *   approved      granted; an approved_amount is recorded, tranches + reports open
 *   rejected      declined (terminal)
 *   withdrawn     we pulled it (terminal)
 * The legal transitions live in exactly one file: server/status-config.ts.
 */
export const APPLICATION_STATUSES = [
  'draft',
  'submitted',
  'under_review',
  'approved',
  'rejected',
  'withdrawn',
] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export function isApplicationStatus(x: unknown): x is ApplicationStatus {
  return typeof x === 'string' && (APPLICATION_STATUSES as readonly string[]).includes(x);
}

// ── Program status ─────────────────────────────────────────────────────
export const PROGRAM_STATUSES = ['open', 'closed'] as const;
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];

export function isProgramStatus(x: unknown): x is ProgramStatus {
  return typeof x === 'string' && (PROGRAM_STATUSES as readonly string[]).includes(x);
}

// ── Funding categories ─────────────────────────────────────────────────
export const CATEGORIES = [
  { value: 'rd', label: 'Research & Development' },
  { value: 'digitalisation', label: 'Digitalisation' },
  { value: 'environment', label: 'Environment & Energy' },
  { value: 'hiring', label: 'Hiring & Training' },
  { value: 'export', label: 'Export & Internationalisation' },
  { value: 'startup', label: 'Startup & Innovation' },
] as const;
export type Category = (typeof CATEGORIES)[number]['value'];

export function isCategory(x: unknown): x is Category {
  return typeof x === 'string' && CATEGORIES.some((c) => c.value === x);
}

export function categoryLabel(value: string): string {
  return CATEGORIES.find((c) => c.value === value)?.label ?? value;
}

// ── Reporting-obligation derived state ─────────────────────────────────
/**
 * DERIVED at read time from an injected clock — never stored:
 *   done      the obligation has been fulfilled (done flag set)
 *   overdue   not done and the due day has passed
 *   at_risk   not done, due within AT_RISK_DAYS
 *   upcoming  not done, comfortably in the future
 */
export const OBLIGATION_STATES = ['done', 'overdue', 'at_risk', 'upcoming'] as const;
export type ObligationState = (typeof OBLIGATION_STATES)[number];

/** A program/obligation deadline verdict for the dashboard (no "done"). */
export const DEADLINE_STATES = ['overdue', 'at_risk', 'upcoming'] as const;
export type DeadlineState = (typeof DEADLINE_STATES)[number];

// ── Programs ───────────────────────────────────────────────────────────
export interface ProgramRow {
  id: number;
  name: string;
  funding_body: string;
  category: string;
  category_label: string;
  description: string | null;
  /** Share of eligible costs covered, in whole percent (0–100). */
  funding_rate: number;
  max_grant_cents: number;
  currency: string;
  /** ISO date (YYYY-MM-DD) or null = rolling (no deadline). */
  application_deadline: string | null;
  status: ProgramStatus;
  application_count: number;
  created_at: string;
}

export interface ProgramDetail extends ProgramRow {
  applications: ApplicationRow[];
}

// ── Applications ───────────────────────────────────────────────────────
export interface ApplicationRow {
  id: number;
  ref: string;
  program_id: number;
  program_name: string;
  funding_body: string;
  title: string;
  status: ApplicationStatus;
  eligible_costs_cents: number;
  requested_amount_cents: number;
  /** Derived: floor(eligible_costs × program.funding_rate / 100). Never stored. */
  funding_cap_cents: number;
  /** Set only once the application is approved. */
  approved_amount_cents: number | null;
  /** Derived: SUM of tranche amounts. Never stored. */
  disbursed_cents: number;
  /** Derived: approved_amount − disbursed. null while not approved. */
  remaining_cents: number | null;
  /** True once disbursed_cents === approved_amount_cents (approved apps). */
  fully_disbursed: boolean;
  submission_date: string | null;
  reference: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApplicationEvent {
  id: number;
  type: 'created' | 'status_change';
  from_status: ApplicationStatus | null;
  to_status: ApplicationStatus;
  actor: string;
  note: string | null;
  /** Set on the approval event: the amount that was granted. */
  approved_amount_cents: number | null;
  created_at: string;
}

export interface Tranche {
  id: number;
  application_id: number;
  disbursed_on: string;
  amount_cents: number;
  reference: string | null;
  note: string | null;
  created_at: string;
}

export interface Obligation {
  id: number;
  application_id: number;
  title: string;
  due_date: string;
  done: boolean;
  done_at: string | null;
  /** Derived from the injected clock. */
  state: ObligationState;
  created_at: string;
}

export interface ApplicationDetail extends ApplicationRow {
  notes: string | null;
  /** The program's rate and grant ceiling, for the approve/tranche forms. */
  program_funding_rate: number;
  program_max_grant_cents: number;
  program_status: ProgramStatus;
  events: ApplicationEvent[];
  tranches: Tranche[];
  obligations: Obligation[];
  allowed_transitions: ApplicationStatus[];
}

// ── Deadlines dashboard (all derived) ──────────────────────────────────
export interface ProgramDeadlineItem {
  kind: 'program';
  program_id: number;
  program_name: string;
  funding_body: string;
  due_date: string;
  state: DeadlineState;
}

export interface ObligationDeadlineItem {
  kind: 'obligation';
  obligation_id: number;
  application_id: number;
  application_ref: string;
  application_title: string;
  program_name: string;
  title: string;
  due_date: string;
  state: DeadlineState;
}

export interface PortfolioTotals {
  requested_cents: number;
  approved_cents: number;
  disbursed_cents: number;
  remaining_cents: number;
  program_count: number;
  application_count: number;
  counts_by_status: Record<ApplicationStatus, number>;
}

export interface Dashboard {
  program_deadlines: ProgramDeadlineItem[];
  obligation_deadlines: ObligationDeadlineItem[];
  totals: { overdue: number; at_risk: number; upcoming: number };
  portfolio: PortfolioTotals;
}

// ── Config as served to the client (single source: server config files) ──
export interface AppConfig {
  admin: string;
  statuses: ApplicationStatus[];
  transitions: Record<ApplicationStatus, ApplicationStatus[]>;
  program_statuses: ProgramStatus[];
  categories: { value: string; label: string }[];
  at_risk_days: number;
}

export interface FieldError {
  field: string;
  message: string;
}
