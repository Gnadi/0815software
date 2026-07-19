/**
 * Domain types shared between the Express API and the React client.
 * The single source of truth for the pipeline stages lives in
 * server/pipeline-config.ts and reaches the client via GET /api/config —
 * so server and client can never disagree about the stage set.
 */

export const ACTIVITY_TYPES = ['call', 'email', 'meeting', 'note'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

/** Kind of a stage-event row (all append-only, never mutated). */
export const STAGE_EVENT_KINDS = ['open', 'move', 'reopen'] as const;
export type StageEventKind = (typeof STAGE_EVENT_KINDS)[number];

export interface FieldError {
  field: string;
  message: string;
}

// ── Companies & contacts ──────────────────────────────────────────────

export interface Company {
  id: number;
  name: string;
  domain: string | null;
  notes: string | null;
  created_at: string;
}

export interface CompanyRow extends Company {
  contact_count: number;
  deal_count: number;
}

export interface Contact {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  title: string | null;
  company_id: number | null;
  created_at: string;
}

export interface ContactRow extends Contact {
  company_name: string | null;
  deal_count: number;
  open_followup_count: number;
}

// ── Deals & stage history ─────────────────────────────────────────────

export interface StageEvent {
  id: number;
  deal_id: number;
  from_stage: string | null;
  to_stage: string;
  kind: StageEventKind;
  note: string | null;
  created_at: string;
}

export interface DealRow {
  id: number;
  title: string;
  company_id: number;
  company_name: string;
  primary_contact_id: number | null;
  primary_contact_name: string | null;
  value_cents: number;
  stage: string;
  stage_label: string;
  probability: number;
  /** Derived: value_cents × probability / 100. Never stored. */
  expected_value_cents: number;
  terminal: boolean;
  note: string | null;
  created_at: string;
}

export interface DealDetail extends DealRow {
  stage_events: StageEvent[];
  activities: Activity[];
}

// ── Activities & follow-ups ───────────────────────────────────────────

export interface Activity {
  id: number;
  type: ActivityType;
  subject: string;
  body: string | null;
  contact_id: number | null;
  contact_name: string | null;
  deal_id: number | null;
  deal_title: string | null;
  /** When the activity happened (the log timestamp). */
  created_at: string;
  /** Optional follow-up due date (YYYY-MM-DD); null = not a follow-up. */
  due_date: string | null;
  /** 1 once the follow-up has been marked done. */
  done: number;
  done_at: string | null;
}

export interface FollowUp extends Activity {
  /** Derived: due_date < today (and not done). */
  overdue: boolean;
}

// ── Pipeline metrics (all derived, never stored) ──────────────────────

export interface StageMetric {
  key: string;
  label: string;
  probability: number;
  terminal: boolean;
  count: number;
  value_cents: number;
  expected_value_cents: number;
}

export interface WinRate {
  from: string | null;
  to: string | null;
  won: number;
  lost: number;
  /** won / (won + lost), or null when no deals closed in range. */
  rate: number | null;
}

export interface Metrics {
  stages: StageMetric[];
  totals: { count: number; value_cents: number; expected_value_cents: number };
  win_rate: WinRate;
}

// ── Config as served to the client (single source: pipeline-config.ts) ─

export interface StageInfo {
  key: string;
  label: string;
  probability: number;
  terminal: boolean;
  position: number;
}

export interface AppConfig {
  stages: StageInfo[];
  activity_types: readonly ActivityType[];
}
