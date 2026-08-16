import type Database from 'better-sqlite3';
import { isCategory, isOutcome, TRANSITIONS } from './case-config.js';
import { generateCode, hashCode, looksLikeCode } from './codes.js';
import { acknowledgeDeadline, eraseDueOn, feedbackDeadline, nowIso } from './deadlines.js';
import type {
  CaseCategory,
  CaseDetail,
  CaseEvent,
  CaseMessage,
  CaseOutcome,
  CaseRow,
  CaseStatus,
  FieldError,
  IntakeResult,
  MessageVisibility,
  ReporterView,
} from '../shared/types.js';

export class DomainError extends Error {
  status: number;
  details: FieldError[];
  constructor(status: number, message: string, details: FieldError[] = []) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
    this.details = details;
  }
}

export function fail(status: number, message: string, details: FieldError[] = []): never {
  throw new DomainError(status, message, details);
}

export { nowIso };

// ── Rows as they come out of SQLite ────────────────────────────────────

interface CaseRecord {
  id: number;
  ref: string;
  category: string;
  subject: string | null;
  body: string | null;
  contact: string | null;
  code_hash: string;
  received_at: string;
}

interface EventRecord {
  id: number;
  case_id: number;
  type: 'received' | 'status_change' | 'message' | 'erased';
  actor: string;
  actor_type: 'handler' | 'reporter' | 'system';
  from_status: string | null;
  to_status: string | null;
  outcome: string | null;
  visibility: MessageVisibility | null;
  body: string | null;
  created_at: string;
}

function eventsOf(db: Database.Database, caseId: number): EventRecord[] {
  return db.prepare('SELECT * FROM case_events WHERE case_id = ? ORDER BY id').all(caseId) as EventRecord[];
}

// ── The folds: every piece of case state, derived from the trail ───────

/**
 * The current status is the target of the last status change, or `received`
 * if none has happened yet. There is no status column to disagree with this.
 */
export function foldStatus(events: EventRecord[]): CaseStatus {
  let status: CaseStatus = 'received';
  for (const event of events) {
    if (event.type === 'status_change' && event.to_status) status = event.to_status as CaseStatus;
  }
  return status;
}

function foldOutcome(events: EventRecord[]): CaseOutcome | null {
  for (const event of events) {
    if (event.type === 'status_change' && event.to_status === 'closed' && event.outcome) {
      return event.outcome as CaseOutcome;
    }
  }
  return null;
}

/** When the § 17 Abs. 1 acknowledgement happened — the FIRST one counts. */
function foldAcknowledgedAt(events: EventRecord[]): string | null {
  for (const event of events) {
    if (event.type === 'status_change' && event.to_status === 'acknowledged') return event.created_at;
  }
  return null;
}

function foldClosedAt(events: EventRecord[]): string | null {
  for (const event of events) {
    if (event.type === 'status_change' && event.to_status === 'closed') return event.created_at;
  }
  return null;
}

function foldErasedAt(events: EventRecord[]): string | null {
  for (const event of events) if (event.type === 'erased') return event.created_at;
  return null;
}

/**
 * When the reporter first got something substantive back.
 *
 * A handler message the reporter can actually read, or the closure of the
 * case. Deliberately NOT: the acknowledgement (that is receipt, not
 * feedback), an internal note (the reporter never sees it), or the
 * reporter's own follow-up. Counting any of those would let a case satisfy
 * the three-month obligation without a single word reaching the person who
 * filed it.
 */
function foldFeedbackGivenAt(events: EventRecord[]): string | null {
  for (const event of events) {
    if (event.type === 'message' && event.visibility === 'reporter' && event.actor_type !== 'reporter') {
      return event.created_at;
    }
    if (event.type === 'status_change' && event.to_status === 'closed') return event.created_at;
  }
  return null;
}

function toRow(record: CaseRecord, events: EventRecord[], now: string): CaseRow {
  const acknowledgedAt = foldAcknowledgedAt(events);
  const closedAt = foldClosedAt(events);
  return {
    id: record.id,
    ref: record.ref,
    category: record.category as CaseCategory,
    subject: record.subject,
    status: foldStatus(events),
    outcome: foldOutcome(events),
    anonymous: record.contact === null,
    received_at: record.received_at,
    acknowledge: acknowledgeDeadline(record.received_at, acknowledgedAt, now),
    feedback: feedbackDeadline(record.received_at, acknowledgedAt, foldFeedbackGivenAt(events), now),
    erased_at: foldErasedAt(events),
    erase_due_on: eraseDueOn(closedAt),
  };
}

function toMessage(event: EventRecord): CaseMessage {
  return {
    id: event.id,
    author: event.actor,
    author_type: event.actor_type,
    visibility: event.visibility!,
    body: event.body,
    created_at: event.created_at,
  };
}

function toEvent(event: EventRecord): CaseEvent {
  return {
    id: event.id,
    type: event.type,
    actor: event.actor,
    from_status: event.from_status as CaseStatus | null,
    to_status: event.to_status as CaseStatus | null,
    outcome: event.outcome as CaseOutcome | null,
    created_at: event.created_at,
  };
}

// ── Refs ───────────────────────────────────────────────────────────────

/**
 * `WB-2026-0001`. Per-year sequence, allocated inside the caller's
 * transaction so two simultaneous reports cannot take the same number.
 */
function nextRef(db: Database.Database, year: number): string {
  db.prepare('INSERT INTO case_counters (year, last_seq) VALUES (?, 0) ON CONFLICT(year) DO NOTHING').run(year);
  const row = db
    .prepare('UPDATE case_counters SET last_seq = last_seq + 1 WHERE year = ? RETURNING last_seq')
    .get(year) as { last_seq: number };
  return `WB-${year}-${String(row.last_seq).padStart(4, '0')}`;
}

// ── Intake ─────────────────────────────────────────────────────────────

export interface IntakeInput {
  category: string;
  subject: string;
  body: string;
  /** Whatever the reporter chose to give, or null. Never required. */
  contact: string | null;
}

/**
 * File a report.
 *
 * Returns the access code in the ONLY response that will ever contain it.
 * Everything after this point identifies the case by ref internally and by
 * the hash of the code externally.
 */
export function createCase(db: Database.Database, input: IntakeInput, at = nowIso()): IntakeResult {
  if (!isCategory(input.category)) {
    fail(422, 'Validation failed', [{ field: 'category', message: 'is not a known category' }]);
  }

  return db.transaction((): IntakeResult => {
    const ref = nextRef(db, Number(at.slice(0, 4)));
    const code = generateCode();
    const info = db
      .prepare(
        `INSERT INTO cases (ref, category, subject, body, contact, code_hash, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(ref, input.category, input.subject, input.body, input.contact, hashCode(code), at);

    db.prepare(
      `INSERT INTO case_events (case_id, type, actor, actor_type, created_at)
       VALUES (?, 'received', 'reporter', 'reporter', ?)`,
    ).run(Number(info.lastInsertRowid), at);

    return {
      ref,
      code,
      acknowledge_due_at: acknowledgeDeadline(at, null, at).due_at,
    };
  })();
}

// ── Lookup ─────────────────────────────────────────────────────────────

function record(db: Database.Database, id: number): CaseRecord {
  const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(id) as CaseRecord | undefined;
  if (!row) fail(404, 'Case not found');
  return row;
}

/**
 * Find a case by the reporter's access code.
 *
 * Returns null for both "no such code" and "not shaped like a code", so a
 * caller cannot accidentally tell the two apart in a response.
 */
export function caseByCode(db: Database.Database, code: unknown): CaseRecord | null {
  if (!looksLikeCode(code)) return null;
  const row = db.prepare('SELECT * FROM cases WHERE code_hash = ?').get(hashCode(code)) as CaseRecord | undefined;
  return row ?? null;
}

export function getCase(db: Database.Database, id: number, now = nowIso()): CaseDetail {
  const found = record(db, id);
  const events = eventsOf(db, found.id);
  return {
    ...toRow(found, events, now),
    body: found.body,
    contact: found.contact,
    messages: events.filter((event) => event.type === 'message').map(toMessage),
    events: events.map(toEvent),
  };
}

/**
 * The reporter's view of their own case, built from scratch rather than by
 * stripping fields off the handler's — see shared/types.ts.
 */
export function reporterViewOf(db: Database.Database, found: CaseRecord, now = nowIso()): ReporterView {
  const events = eventsOf(db, found.id);
  const acknowledgedAt = foldAcknowledgedAt(events);
  return {
    ref: found.ref,
    category: found.category as CaseCategory,
    subject: found.subject,
    status: foldStatus(events),
    outcome: foldOutcome(events),
    received_at: found.received_at,
    body: found.body,
    erased_at: foldErasedAt(events),
    messages: events.filter((event) => event.type === 'message' && event.visibility === 'reporter').map(toMessage),
    acknowledge_due_at: acknowledgeDeadline(found.received_at, acknowledgedAt, now).due_at,
    feedback_due_at: feedbackDeadline(found.received_at, acknowledgedAt, null, now).due_at,
    acknowledged_at: acknowledgedAt,
  };
}

export interface CaseFilter {
  status?: CaseStatus;
  category?: CaseCategory;
  /** Only cases with at least one deadline missed or at risk. */
  attention?: boolean;
}

export function listCases(db: Database.Database, filter: CaseFilter = {}, now = nowIso()): CaseRow[] {
  const records = db.prepare('SELECT * FROM cases ORDER BY id DESC').all() as CaseRecord[];
  const rows = records.map((found) => toRow(found, eventsOf(db, found.id), now));
  return rows.filter((row) => {
    if (filter.status !== undefined && row.status !== filter.status) return false;
    if (filter.category !== undefined && row.category !== filter.category) return false;
    if (filter.attention === true) {
      const pressing = (state: string): boolean => state === 'missed' || state === 'at_risk';
      // A closed case is nobody's outstanding work, even if a deadline was
      // missed on the way — the miss stays visible on the case itself.
      if (row.status === 'closed') return false;
      if (!pressing(row.acknowledge.state) && !pressing(row.feedback.state)) return false;
    }
    return true;
  });
}

// ── Handling ───────────────────────────────────────────────────────────

function requireLive(found: CaseRecord, events: EventRecord[]): void {
  if (foldErasedAt(events) !== null) {
    fail(409, `${found.ref} has been erased under § 11 Abs. 5 HinSchG and can no longer be worked on`);
  }
}

export function transitionCase(
  db: Database.Database,
  id: number,
  to: CaseStatus,
  actor: string,
  outcome: CaseOutcome | null,
  at = nowIso(),
): CaseDetail {
  return db.transaction((): CaseDetail => {
    const found = record(db, id);
    const events = eventsOf(db, id);
    requireLive(found, events);
    const from = foldStatus(events);
    if (!TRANSITIONS[from].includes(to)) {
      fail(409, `A ${from} case cannot become ${to}`);
    }
    if (to === 'closed') {
      if (!isOutcome(outcome)) {
        fail(422, 'Closing a case requires an outcome', [{ field: 'outcome', message: 'is required' }]);
      }
    } else if (outcome !== null) {
      fail(422, 'Only a closure carries an outcome', [{ field: 'outcome', message: 'is not allowed here' }]);
    }
    db.prepare(
      `INSERT INTO case_events (case_id, type, actor, actor_type, from_status, to_status, outcome, created_at)
       VALUES (?, 'status_change', ?, 'handler', ?, ?, ?, ?)`,
    ).run(id, actor, from, to, to === 'closed' ? outcome : null, at);
    return getCase(db, id, at);
  })();
}

export interface MessageInput {
  actor: string;
  actorType: 'handler' | 'reporter';
  visibility: MessageVisibility;
  body: string;
}

export function addMessage(db: Database.Database, id: number, input: MessageInput, at = nowIso()): CaseDetail {
  return db.transaction((): CaseDetail => {
    const found = record(db, id);
    const events = eventsOf(db, id);
    requireLive(found, events);
    // The reporter writes into their own channel and nowhere else. An
    // internal note is a handler's tool; letting the wire choose would mean
    // a reporter could file a note only handlers read, or worse, read one.
    if (input.actorType === 'reporter' && input.visibility !== 'reporter') {
      fail(422, 'A reporter can only write in their own channel');
    }
    if (foldStatus(events) === 'closed' && input.actorType === 'reporter') {
      fail(409, `${found.ref} is closed and no longer accepts follow-up`);
    }
    db.prepare(
      `INSERT INTO case_events (case_id, type, actor, actor_type, visibility, body, created_at)
       VALUES (?, 'message', ?, ?, ?, ?, ?)`,
    ).run(id, input.actor, input.actorType, input.visibility, input.body, at);
    return getCase(db, id, at);
  })();
}

/**
 * Erase the documentation — § 11 Abs. 5 HinSchG.
 *
 * Destructive on purpose and irreversible: the report, the contact details
 * and every message body are set to NULL. What survives is the skeleton —
 * ref, category, dates, statuses, who acted when — because the organisation
 * still has to be able to show it ran a compliant procedure, and because an
 * erasure that left no trace of itself would be indistinguishable from a
 * case quietly disappearing.
 *
 * Refused before the retention period ends unless `force` is set: erasing
 * early destroys evidence somebody may still be entitled to, and that should
 * take a deliberate act rather than a mis-click.
 */
export function eraseCase(db: Database.Database, id: number, actor: string, force = false, at = nowIso()): CaseDetail {
  return db.transaction((): CaseDetail => {
    const found = record(db, id);
    const events = eventsOf(db, id);
    if (foldErasedAt(events) !== null) fail(409, `${found.ref} has already been erased`);
    const closedAt = foldClosedAt(events);
    if (closedAt === null) fail(409, `${found.ref} is still open — conclude the procedure before erasing it`);
    const dueOn = eraseDueOn(closedAt)!;
    if (!force && at.slice(0, 10) < dueOn) {
      fail(409, `${found.ref} is retained until ${dueOn}`, [
        { field: 'force', message: 'pass force to erase before the retention period ends' },
      ]);
    }
    db.prepare('UPDATE cases SET subject = NULL, body = NULL, contact = NULL WHERE id = ?').run(id);
    db.prepare('UPDATE case_events SET body = NULL WHERE case_id = ? AND type = ?').run(id, 'message');
    db.prepare(
      `INSERT INTO case_events (case_id, type, actor, actor_type, created_at)
       VALUES (?, 'erased', ?, 'handler', ?)`,
    ).run(id, actor, at);
    return getCase(db, id, at);
  })();
}

// ── Dashboard ──────────────────────────────────────────────────────────

export interface Overview {
  total: number;
  open: number;
  awaiting_acknowledgement: number;
  acknowledgement_missed: number;
  feedback_at_risk: number;
  feedback_missed: number;
  due_for_erasure: number;
}

/**
 * The numbers a compliance officer is asked for, all derived. Deliberately
 * counts obligations rather than cases: one case can be late twice.
 */
export function overview(db: Database.Database, now = nowIso()): Overview {
  const rows = listCases(db, {}, now);
  const live = rows.filter((row) => row.erased_at === null);
  return {
    total: rows.length,
    open: live.filter((row) => row.status !== 'closed').length,
    awaiting_acknowledgement: live.filter((row) => row.acknowledge.met_at === null).length,
    acknowledgement_missed: live.filter((row) => row.acknowledge.state === 'missed').length,
    feedback_at_risk: live.filter((row) => row.status !== 'closed' && row.feedback.state === 'at_risk').length,
    feedback_missed: live.filter((row) => row.feedback.state === 'missed').length,
    due_for_erasure: live.filter((row) => row.erase_due_on !== null && row.erase_due_on <= now.slice(0, 10)).length,
  };
}
