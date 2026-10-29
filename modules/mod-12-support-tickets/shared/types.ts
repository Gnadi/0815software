/**
 * Domain types shared between the Express API and the React client.
 * The single source of truth for statuses, priorities and event types
 * lives here so server and client can never disagree.
 *
 * DESIGN NOTE — everything about a ticket's *current* state is DERIVED
 * from its append-only event stream (see server/tickets.ts). A ticket
 * row stores only the immutable facts of intake (ref, requester,
 * subject, body, created_at). Status, priority, assignee, the
 * first-response time and the resolution time are all folded from the
 * events at read time — nothing that can drift is ever stored. SLA
 * breach is derived from the wall clock at read time on top of that.
 */

// ── Status workflow ────────────────────────────────────────────────────
// new → open → pending → resolved → closed, plus reopen (→ open). The
// allowed transitions themselves live in ONE file: server/status-config.ts.
export const STATUSES = ['new', 'open', 'pending', 'resolved', 'closed'] as const;
export type Status = (typeof STATUSES)[number];

export function isStatus(value: unknown): value is Status {
  return typeof value === 'string' && (STATUSES as readonly string[]).includes(value);
}

// ── Priorities ─────────────────────────────────────────────────────────
// Each priority carries its own SLA targets — see server/sla-config.ts.
export const PRIORITIES = ['urgent', 'high', 'normal', 'low'] as const;
export type Priority = (typeof PRIORITIES)[number];

export function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
}

// ── Append-only timeline ───────────────────────────────────────────────
export const EVENT_TYPES = [
  'created',
  'status_change',
  'priority_change',
  'assignment',
  'comment',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Who performed an action — decides whether a comment is a first response. */
export type ActorType = 'agent' | 'requester' | 'system';

/** How a comment is exposed. Internal notes never reach the public page. */
export type CommentVisibility = 'public' | 'internal';

/** Where a ticket (or a follow-up) came in from. */
export type Channel = 'web' | 'email' | 'agent';

/**
 * Structured payload of a timeline event. Only the fields relevant to the
 * event `type` are populated; the rest are absent. Stored verbatim as
 * JSON in ticket_events.payload and never mutated.
 */
export interface EventPayload {
  channel?: Channel;
  from?: Status;
  to?: Status;
  from_priority?: Priority;
  to_priority?: Priority;
  assignee_id?: number | null;
  assignee_name?: string | null;
  body?: string;
  reopened?: boolean;
  /** The canned response a reply started from (server/canned.ts). */
  canned_id?: number;
  /** A comment that arrived by email from someone other than the requester. */
  other_sender?: string;
}

export interface TicketEvent {
  id: number;
  type: EventType;
  actor: string;
  actor_type: ActorType;
  visibility: CommentVisibility | null;
  created_at: string;
  payload: EventPayload;
  /** Files that came with this event; who may see them is the event's visibility. */
  attachments: AttachmentInfo[];
}

// ── Attachments ────────────────────────────────────────────────────────
export interface AttachmentInfo {
  id: number;
  filename: string;
  content_type: string;
  size: number;
  sha256: string;
  created_at: string;
}

/** An upload as a request carries it: JSON, the bytes base64-encoded. */
export interface AttachmentUpload {
  filename: string;
  content_type?: string;
  content_base64: string;
}

// ── SLA (all derived at read time) ─────────────────────────────────────
export type SlaState = 'met' | 'breached' | 'at_risk' | 'pending' | 'paused';

export interface SlaLeg {
  /** When this leg is due (created_at + the priority's target). */
  due_at: string;
  /** When the leg was satisfied (first agent reply / entered resolved), or null. */
  met_at: string | null;
  state: SlaState;
  /** Convenience: state === 'breached'. */
  breached: boolean;
  /** Counted in business hours (true) or around the clock. */
  business_hours: boolean;
  /** Clock minutes left until due, while neither met nor breached. */
  remaining_minutes: number | null;
}

export interface Sla {
  priority: Priority;
  first_response: SlaLeg;
  resolution: SlaLeg;
  /** The policy version the ticket is held to (null: the built-in defaults). */
  policy_version: number | null;
}

// ── SLA policy (versioned; a ticket keeps the version it came in under) ──
export interface SlaTarget {
  first_response_minutes: number;
  resolution_minutes: number;
  /** Count only business hours (true) or around the clock (false). */
  business_hours: boolean;
}

/** One opening window on a weekday, local time, `HH:MM` (end may be 24:00). */
export interface BusinessWindow {
  start: string;
  end: string;
}

export interface Holiday {
  date: string;
  name: string;
}

export interface SlaPolicy {
  targets: Record<Priority, SlaTarget>;
  at_risk_minutes: number;
  /** IANA zone the business hours and holidays are in. */
  timezone: string;
  /** Monday first: seven lists of opening windows. */
  week: BusinessWindow[][];
  holidays: Holiday[];
  /** Stop the resolution clock while the ticket waits on the requester. */
  pause_on_pending: boolean;
}

export interface SlaPolicyVersion {
  /** null: the built-in defaults, before anyone saved a policy. */
  id: number | null;
  policy: SlaPolicy;
  created_by: string | null;
  created_at: string | null;
}

// ── Settings set in the UI ─────────────────────────────────────────────
export interface HelpdeskSettings {
  csat: {
    /** The requester may rate a resolved ticket on the status page. */
    enabled: boolean;
    /** And is invited by email when it is resolved (PS-03). */
    invite_by_email: boolean;
  };
  /** Public replies go to the requester by email (PS-03, NOTIFICATION_ACK_CHANNEL). */
  reply_by_email: boolean;
  mailbox: {
    enabled: boolean;
    /** A PS-05 mailbox connection. */
    connection_id: number | null;
    poll_seconds: number;
  };
}

// ── Canned responses ───────────────────────────────────────────────────
export const CANNED_PLACEHOLDERS = ['requester_name', 'requester_first_name', 'ticket_ref', 'subject', 'agent_name'] as const;
export type CannedPlaceholder = (typeof CANNED_PLACEHOLDERS)[number];

export interface CannedResponse {
  id: number;
  title: string;
  body: string;
  active: boolean;
  /** Replies that started from it — counted from the comments. */
  uses: number;
  created_by: string;
  created_at: string;
  updated_by: string;
  updated_at: string;
}

// ── Satisfaction (CSAT) ────────────────────────────────────────────────
export interface CsatRating {
  id: number;
  ref: string;
  score: number;
  comment: string | null;
  created_at: string;
}

export interface CsatStats {
  count: number;
  average: number | null;
  /** Share of 4- and 5-star ratings, in percent — the usual CSAT figure. */
  csat_percent: number | null;
  distribution: Record<'1' | '2' | '3' | '4' | '5', number>;
  recent: CsatRating[];
}

// ── Mailbox (PS-05) ────────────────────────────────────────────────────
export type MailAction = 'created' | 'appended' | 'noted' | 'ignored' | 'failed';

export interface MailIngest {
  id: number;
  message_id: string | null;
  from_address: string | null;
  subject: string;
  action: MailAction;
  reason: string | null;
  ticket_ref: string | null;
  received_at: string;
}

export interface MailboxStatus {
  /** INTEGRATION_URL and PLATFORM_SERVICE_TOKEN are set. */
  configured: boolean;
  settings: HelpdeskSettings['mailbox'];
  connections: { id: number; name: string; account: string | null; status: string }[];
  /** Why the connection list could not be read, if it could not. */
  connections_error: string | null;
  last_poll: { at: string; ok: boolean; fetched: number; error: string | null } | null;
  recent: MailIngest[];
}

// ── Agents ─────────────────────────────────────────────────────────────
export interface Agent {
  id: number;
  name: string;
  email: string;
  created_at: string;
}

// ── Tickets ────────────────────────────────────────────────────────────
export interface TicketRow {
  id: number;
  ref: string;
  subject: string;
  requester_name: string;
  requester_email: string;
  status: Status;
  priority: Priority;
  assignee_id: number | null;
  assignee_name: string | null;
  channel: Channel;
  created_at: string;
  /** Timestamp of the most recent event. */
  updated_at: string;
  sla: Sla;
}

export interface TicketDetail extends TicketRow {
  body: string;
  first_response_at: string | null;
  resolved_at: string | null;
  events: TicketEvent[];
  /** Where the workflow can legally go next from the current status. */
  allowed_transitions: Status[];
  ratings: CsatRating[];
}

// ── Public (requester-facing) view — no internal notes, no assignee ────
export interface PublicEvent {
  type: 'created' | 'status_change' | 'comment';
  author: string;
  author_type: ActorType;
  to?: Status;
  body?: string;
  created_at: string;
  attachments: AttachmentInfo[];
}

export interface PublicTicket {
  ref: string;
  subject: string;
  status: Status;
  priority: Priority;
  created_at: string;
  updated_at: string;
  events: PublicEvent[];
  /** Present when ratings are collected: may the requester rate now, and what they gave. */
  rating: { can_rate: boolean; given: { score: number; comment: string | null; created_at: string } | null } | null;
}

// ── Config as served to the client (single source: server config files) ──
export interface SlaPolicyInfo {
  first_response_minutes: number;
  resolution_minutes: number;
  business_hours: boolean;
}

export interface AppConfig {
  agent: string;
  statuses: Status[];
  priorities: Priority[];
  transitions: Record<Status, Status[]>;
  /** The policy new tickets are held to now. */
  sla: Record<Priority, SlaPolicyInfo>;
  at_risk_minutes: number;
  /** Attachment limits, so the forms can refuse early. */
  attachments: { max_bytes: number; per_message: number };
}

// ── SLA dashboard ──────────────────────────────────────────────────────
export interface PriorityBucket {
  priority: Priority;
  open: number;
  at_risk: number;
  breached: number;
}

export interface Dashboard {
  by_priority: PriorityBucket[];
  by_status: Record<Status, number>;
  totals: { open: number; at_risk: number; breached: number; unassigned: number; paused: number };
  csat: CsatStats;
}

// ── Errors ─────────────────────────────────────────────────────────────
export interface FieldError {
  field: string;
  message: string;
}
