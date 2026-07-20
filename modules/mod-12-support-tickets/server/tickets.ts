import type Database from 'better-sqlite3';
import {
  isPriority,
  type ActorType,
  type Agent,
  type Channel,
  type CommentVisibility,
  type Dashboard,
  type EventPayload,
  type Priority,
  type PriorityBucket,
  type PublicEvent,
  type PublicTicket,
  type Status,
  type TicketDetail,
  type TicketEvent,
  type TicketRow,
  PRIORITIES,
  STATUSES,
} from '../shared/types.js';
import { evaluateSla, AT_RISK_MINUTES } from './sla-config.js';
import { allowedTransitions, canTransition, INITIAL_STATUS } from './status-config.js';

/** Error with an HTTP status and optional per-field details. */
export class DomainError extends Error {
  status: number;
  details: { field: string; message: string }[];

  constructor(status: number, message: string, details: { field: string; message: string }[] = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** ISO timestamp (seconds precision) from epoch millis — the ONE clock edge. */
export function nowIso(ms: number = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function toMs(iso: string): number {
  return Date.parse(iso);
}

export function requireRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new DomainError(404, `${what} not found`);
  return row;
}

// ── Stored rows ────────────────────────────────────────────────────────
interface TicketStoredRow {
  id: number;
  ref: string;
  requester_name: string;
  requester_email: string;
  subject: string;
  body: string;
  created_at: string;
}

interface EventStoredRow {
  id: number;
  ticket_id: number;
  type: TicketEvent['type'];
  actor: string;
  actor_type: ActorType;
  visibility: CommentVisibility | null;
  payload: string;
  created_at: string;
}

function getTicketRow(db: Database.Database, ref: string): TicketStoredRow {
  return requireRow(
    db.prepare('SELECT * FROM tickets WHERE ref = ?').get(ref) as TicketStoredRow | undefined,
    'Ticket',
  );
}

function eventsOf(db: Database.Database, ticketId: number): TicketEvent[] {
  const rows = db
    .prepare('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY created_at, id')
    .all(ticketId) as EventStoredRow[];
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    actor: row.actor,
    actor_type: row.actor_type,
    visibility: row.visibility,
    created_at: row.created_at,
    payload: JSON.parse(row.payload) as EventPayload,
  }));
}

// ── Derived current state (folded from the append-only timeline) ───────
export interface DerivedState {
  status: Status;
  priority: Priority;
  assignee_id: number | null;
  channel: Channel;
  first_response_at: string | null;
  resolved_at: string | null;
  updated_at: string;
}

/**
 * Fold the event stream into the ticket's current state. This is THE
 * definition of "current" — no column holds any of it.
 *   status    starts at INITIAL_STATUS, walked by status_change events
 *   priority  the created event's channel payload, walked by priority_change
 *   assignee  the latest assignment event
 *   first_response_at  the earliest PUBLIC comment authored by an AGENT
 *   resolved_at        the earliest time the ticket entered `resolved`
 */
export function deriveState(events: TicketEvent[], createdAt: string): DerivedState {
  let status: Status = INITIAL_STATUS;
  let priority: Priority = 'normal';
  let assignee: number | null = null;
  let channel: Channel = 'web';
  let firstResponseAt: string | null = null;
  let resolvedAt: string | null = null;
  let updatedAt = createdAt;

  for (const ev of events) {
    updatedAt = ev.created_at;
    switch (ev.type) {
      case 'created':
        if (isPriority(ev.payload.to_priority)) priority = ev.payload.to_priority;
        if (ev.payload.channel) channel = ev.payload.channel;
        break;
      case 'status_change':
        if (ev.payload.to) {
          status = ev.payload.to;
          if (ev.payload.to === 'resolved' && resolvedAt === null) resolvedAt = ev.created_at;
        }
        break;
      case 'priority_change':
        if (ev.payload.to_priority && isPriority(ev.payload.to_priority)) {
          priority = ev.payload.to_priority;
        }
        break;
      case 'assignment':
        assignee = ev.payload.assignee_id ?? null;
        break;
      case 'comment':
        if (ev.visibility === 'public' && ev.actor_type === 'agent' && firstResponseAt === null) {
          firstResponseAt = ev.created_at;
        }
        break;
    }
  }

  return {
    status,
    priority,
    assignee_id: assignee,
    channel,
    first_response_at: firstResponseAt,
    resolved_at: resolvedAt,
    updated_at: updatedAt,
  };
}

function agentName(db: Database.Database, id: number | null): string | null {
  if (id === null) return null;
  const row = db.prepare('SELECT name FROM agents WHERE id = ?').get(id) as { name: string } | undefined;
  return row?.name ?? null;
}

function buildRow(db: Database.Database, ticket: TicketStoredRow, events: TicketEvent[], nowMs: number): TicketRow {
  const state = deriveState(events, ticket.created_at);
  const sla = evaluateSla({
    createdMs: toMs(ticket.created_at),
    priority: state.priority,
    firstResponseMs: state.first_response_at ? toMs(state.first_response_at) : null,
    resolvedMs: state.resolved_at ? toMs(state.resolved_at) : null,
    nowMs,
  });
  return {
    id: ticket.id,
    ref: ticket.ref,
    subject: ticket.subject,
    requester_name: ticket.requester_name,
    requester_email: ticket.requester_email,
    status: state.status,
    priority: state.priority,
    assignee_id: state.assignee_id,
    assignee_name: agentName(db, state.assignee_id),
    channel: state.channel,
    created_at: ticket.created_at,
    updated_at: state.updated_at,
    sla,
  };
}

export function ticketDetail(db: Database.Database, ref: string, nowMs: number): TicketDetail {
  const ticket = getTicketRow(db, ref);
  const events = eventsOf(db, ticket.id);
  const row = buildRow(db, ticket, events, nowMs);
  return {
    ...row,
    body: ticket.body,
    first_response_at: deriveState(events, ticket.created_at).first_response_at,
    resolved_at: deriveState(events, ticket.created_at).resolved_at,
    events,
    allowed_transitions: allowedTransitions(row.status),
  };
}

export interface ListOpts {
  status?: Status;
  priority?: Priority;
  assignee?: number | 'unassigned';
  search?: string;
}

export function listTickets(db: Database.Database, opts: ListOpts, nowMs: number): TicketRow[] {
  const search = opts.search?.trim();
  const tickets = db
    .prepare(
      `SELECT * FROM tickets
       ${search ? 'WHERE ref LIKE @s OR subject LIKE @s OR requester_name LIKE @s OR requester_email LIKE @s' : ''}
       ORDER BY created_at DESC, id DESC`,
    )
    .all(search ? { s: `%${search}%` } : {}) as TicketStoredRow[];

  let rows = tickets.map((t) => buildRow(db, t, eventsOf(db, t.id), nowMs));
  if (opts.status) rows = rows.filter((r) => r.status === opts.status);
  if (opts.priority) rows = rows.filter((r) => r.priority === opts.priority);
  if (opts.assignee === 'unassigned') rows = rows.filter((r) => r.assignee_id === null);
  else if (typeof opts.assignee === 'number') rows = rows.filter((r) => r.assignee_id === opts.assignee);
  return rows;
}

// ── Public (requester-facing) projection ───────────────────────────────
// Only the created event, PUBLIC comments and status changes are exposed.
// Internal notes, assignments and priority changes never leave the queue.
export function publicView(db: Database.Database, ref: string): PublicTicket {
  const ticket = getTicketRow(db, ref);
  const events = eventsOf(db, ticket.id);
  const state = deriveState(events, ticket.created_at);
  const publicEvents: PublicEvent[] = [];
  for (const ev of events) {
    if (ev.type === 'created') {
      publicEvents.push({
        type: 'created',
        author: ticket.requester_name,
        author_type: 'requester',
        created_at: ev.created_at,
      });
    } else if (ev.type === 'status_change' && ev.payload.to) {
      publicEvents.push({
        type: 'status_change',
        author: ev.actor,
        author_type: ev.actor_type,
        to: ev.payload.to,
        created_at: ev.created_at,
      });
    } else if (ev.type === 'comment' && ev.visibility === 'public') {
      publicEvents.push({
        type: 'comment',
        author: ev.actor,
        author_type: ev.actor_type,
        body: ev.payload.body,
        created_at: ev.created_at,
      });
    }
  }
  return {
    ref: ticket.ref,
    subject: ticket.subject,
    status: state.status,
    priority: state.priority,
    created_at: ticket.created_at,
    updated_at: state.updated_at,
    events: publicEvents,
  };
}

// ── Writes (all append events; nothing is ever mutated) ────────────────
function appendEvent(
  db: Database.Database,
  ticketId: number,
  ev: {
    type: TicketEvent['type'];
    actor: string;
    actorType: ActorType;
    visibility?: CommentVisibility | null;
    payload: EventPayload;
    at: string;
  },
): void {
  db.prepare(
    `INSERT INTO ticket_events (ticket_id, type, actor, actor_type, visibility, payload, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ticketId,
    ev.type,
    ev.actor,
    ev.actorType,
    ev.visibility ?? null,
    JSON.stringify(ev.payload),
    ev.at,
  );
}

export interface NewTicketInput {
  requesterName: string;
  requesterEmail: string;
  subject: string;
  body: string;
  priority: Priority;
  channel: Channel;
  actor: string;
  actorType: ActorType;
  at: string;
}

/**
 * Create a ticket. The ref (TKT-<year>-<seq>) is assigned from a per-year
 * counter in the same transaction as the insert. The opening `created`
 * event freezes the intake channel and initial priority; the ticket
 * starts in INITIAL_STATUS purely by derivation.
 */
export function createTicket(db: Database.Database, input: NewTicketInput): string {
  const year = Number(input.at.slice(0, 4));
  return db.transaction(() => {
    const counter = db
      .prepare(
        `INSERT INTO ticket_counters (year, last_seq) VALUES (?, 1)
         ON CONFLICT (year) DO UPDATE SET last_seq = last_seq + 1
         RETURNING last_seq`,
      )
      .get(year) as { last_seq: number };
    const ref = `TKT-${year}-${String(counter.last_seq).padStart(4, '0')}`;
    const info = db
      .prepare(
        `INSERT INTO tickets (ref, requester_name, requester_email, subject, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(ref, input.requesterName, input.requesterEmail, input.subject, input.body, input.at);
    appendEvent(db, Number(info.lastInsertRowid), {
      type: 'created',
      actor: input.actor,
      actorType: input.actorType,
      payload: { channel: input.channel, to_priority: input.priority },
      at: input.at,
    });
    return ref;
  })();
}

/** Change status. Illegal transition → 422. Same status is a no-op 422. */
export function changeStatus(
  db: Database.Database,
  ref: string,
  to: Status,
  actor: string,
  actorType: ActorType,
  at: string,
): void {
  const ticket = getTicketRow(db, ref);
  const state = deriveState(eventsOf(db, ticket.id), ticket.created_at);
  if (to === state.status) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'to', message: `Ticket is already ${to}` },
    ]);
  }
  if (!canTransition(state.status, to)) {
    throw new DomainError(422, 'Validation failed', [
      {
        field: 'to',
        message: `Illegal transition ${state.status} → ${to} (allowed: ${allowedTransitions(state.status).join(', ') || 'none'})`,
      },
    ]);
  }
  appendEvent(db, ticket.id, {
    type: 'status_change',
    actor,
    actorType,
    payload: { from: state.status, to },
    at,
  });
}

/** Change priority. New priority must differ; SLA is re-derived from it. */
export function changePriority(
  db: Database.Database,
  ref: string,
  to: Priority,
  actor: string,
  at: string,
): void {
  const ticket = getTicketRow(db, ref);
  const state = deriveState(eventsOf(db, ticket.id), ticket.created_at);
  if (to === state.priority) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'priority', message: `Ticket is already ${to} priority` },
    ]);
  }
  appendEvent(db, ticket.id, {
    type: 'priority_change',
    actor,
    actorType: 'agent',
    payload: { from_priority: state.priority, to_priority: to },
    at,
  });
}

/** Assign (or, with null, unassign) the ticket. Appends an assignment event. */
export function assignTicket(
  db: Database.Database,
  ref: string,
  assigneeId: number | null,
  actor: string,
  at: string,
): void {
  const ticket = getTicketRow(db, ref);
  let name: string | null = null;
  if (assigneeId !== null) {
    const agent = db.prepare('SELECT name FROM agents WHERE id = ?').get(assigneeId) as
      | { name: string }
      | undefined;
    if (!agent) {
      throw new DomainError(422, 'Validation failed', [
        { field: 'assignee_id', message: `No agent with id ${assigneeId}` },
      ]);
    }
    name = agent.name;
  }
  const state = deriveState(eventsOf(db, ticket.id), ticket.created_at);
  if (state.assignee_id === assigneeId) {
    throw new DomainError(422, 'Validation failed', [
      {
        field: 'assignee_id',
        message: assigneeId === null ? 'Ticket is already unassigned' : `Ticket is already assigned to ${name}`,
      },
    ]);
  }
  appendEvent(db, ticket.id, {
    type: 'assignment',
    actor,
    actorType: 'agent',
    payload: { assignee_id: assigneeId, assignee_name: name },
    at,
  });
}

export interface CommentInput {
  body: string;
  visibility: CommentVisibility;
  actor: string;
  actorType: ActorType;
  at: string;
}

/**
 * Append a comment. A requester follow-up (actorType 'requester') on a
 * resolved or closed ticket REOPENS it: a status_change to `open` is
 * appended right after the comment, tagged reopened. Internal notes are
 * agent-only.
 */
export function addComment(db: Database.Database, ref: string, input: CommentInput): void {
  const ticket = getTicketRow(db, ref);
  const state = deriveState(eventsOf(db, ticket.id), ticket.created_at);
  if (input.visibility === 'internal' && input.actorType !== 'agent') {
    throw new DomainError(422, 'Validation failed', [
      { field: 'visibility', message: 'Only agents can add internal notes' },
    ]);
  }
  db.transaction(() => {
    appendEvent(db, ticket.id, {
      type: 'comment',
      actor: input.actor,
      actorType: input.actorType,
      visibility: input.visibility,
      payload: { body: input.body },
      at: input.at,
    });
    if (input.actorType === 'requester' && (state.status === 'resolved' || state.status === 'closed')) {
      appendEvent(db, ticket.id, {
        type: 'status_change',
        actor: input.actor,
        actorType: 'system',
        payload: { from: state.status, to: 'open', reopened: true },
        at: input.at,
      });
    }
  })();
}

// ── Email intake matching ──────────────────────────────────────────────
/** A ticket the given ref points at, if it exists and is NOT closed. */
export function openTicketByRef(db: Database.Database, ref: string): TicketStoredRow | null {
  const ticket = db.prepare('SELECT * FROM tickets WHERE ref = ?').get(ref) as
    | TicketStoredRow
    | undefined;
  if (!ticket) return null;
  const state = deriveState(eventsOf(db, ticket.id), ticket.created_at);
  return state.status === 'closed' ? null : ticket;
}

// ── Agents ─────────────────────────────────────────────────────────────
export function listAgents(db: Database.Database): Agent[] {
  return db.prepare('SELECT * FROM agents ORDER BY name').all() as Agent[];
}

// ── SLA dashboard (all derived) ────────────────────────────────────────
export function dashboard(db: Database.Database, nowMs: number): Dashboard {
  const tickets = db.prepare('SELECT * FROM tickets').all() as TicketStoredRow[];
  const rows = tickets.map((t) => buildRow(db, t, eventsOf(db, t.id), nowMs));

  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  const byPriority = new Map<Priority, PriorityBucket>(
    PRIORITIES.map((p) => [p, { priority: p, open: 0, at_risk: 0, breached: 0 }]),
  );
  const totals = { open: 0, at_risk: 0, breached: 0, unassigned: 0 };

  for (const row of rows) {
    byStatus[row.status] += 1;
    // "Open work" for the dashboard = anything not closed.
    if (row.status === 'closed') continue;
    const bucket = byPriority.get(row.priority)!;
    bucket.open += 1;
    totals.open += 1;
    if (row.assignee_id === null) totals.unassigned += 1;
    const breached = row.sla.first_response.breached || row.sla.resolution.breached;
    const atRisk =
      !breached &&
      (row.sla.first_response.state === 'at_risk' || row.sla.resolution.state === 'at_risk');
    if (breached) {
      bucket.breached += 1;
      totals.breached += 1;
    } else if (atRisk) {
      bucket.at_risk += 1;
      totals.at_risk += 1;
    }
  }

  return {
    by_priority: PRIORITIES.map((p) => byPriority.get(p)!),
    by_status: byStatus,
    totals,
  };
}

export { AT_RISK_MINUTES };
