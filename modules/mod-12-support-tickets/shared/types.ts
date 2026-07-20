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
}

export interface TicketEvent {
  id: number;
  type: EventType;
  actor: string;
  actor_type: ActorType;
  visibility: CommentVisibility | null;
  created_at: string;
  payload: EventPayload;
}

// ── SLA (all derived at read time) ─────────────────────────────────────
export type SlaState = 'met' | 'breached' | 'at_risk' | 'pending';

export interface SlaLeg {
  /** When this leg is due (created_at + the priority's target). */
  due_at: string;
  /** When the leg was satisfied (first agent reply / entered resolved), or null. */
  met_at: string | null;
  state: SlaState;
  /** Convenience: state === 'breached'. */
  breached: boolean;
}

export interface Sla {
  priority: Priority;
  first_response: SlaLeg;
  resolution: SlaLeg;
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
}

// ── Public (requester-facing) view — no internal notes, no assignee ────
export interface PublicEvent {
  type: 'created' | 'status_change' | 'comment';
  author: string;
  author_type: ActorType;
  to?: Status;
  body?: string;
  created_at: string;
}

export interface PublicTicket {
  ref: string;
  subject: string;
  status: Status;
  priority: Priority;
  created_at: string;
  updated_at: string;
  events: PublicEvent[];
}

// ── Config as served to the client (single source: server config files) ──
export interface SlaPolicyInfo {
  first_response_minutes: number;
  resolution_minutes: number;
}

export interface AppConfig {
  agent: string;
  statuses: Status[];
  priorities: Priority[];
  transitions: Record<Status, Status[]>;
  sla: Record<Priority, SlaPolicyInfo>;
  at_risk_minutes: number;
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
  totals: { open: number; at_risk: number; breached: number; unassigned: number };
}

// ── Errors ─────────────────────────────────────────────────────────────
export interface FieldError {
  field: string;
  message: string;
}
