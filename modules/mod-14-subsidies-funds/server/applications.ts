import type Database from 'better-sqlite3';
import { fundingCapCents } from '../shared/money.js';
import {
  APPLICATION_STATUSES,
  type ApplicationDetail,
  type ApplicationEvent,
  type ApplicationRow,
  type ApplicationStatus,
  type Dashboard,
  type Obligation,
  type ObligationDeadlineItem,
  type PortfolioTotals,
  type ProgramDeadlineItem,
  type Tranche,
} from '../shared/types.js';
import { DomainError, nowIso, requireRow } from './core.js';
import { getProgramRow } from './programs.js';
import { AT_RISK_DAYS, deadlineState, obligationState } from './reporting-config.js';
import { allowedTransitions, canTransition, INITIAL_STATUS } from './status-config.js';

/** A LIKE pattern that matches the term literally — see the ESCAPE clauses below. */
export function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

// ── Stored rows ────────────────────────────────────────────────────────
interface ApplicationStoredRow {
  id: number;
  ref: string;
  program_id: number;
  title: string;
  status: ApplicationStatus;
  eligible_costs_cents: number;
  requested_amount_cents: number;
  approved_amount_cents: number | null;
  submission_date: string | null;
  reference: string | null;
  notes: string | null;
  created_at: string;
}

export function getApplicationRow(db: Database.Database, id: number): ApplicationStoredRow {
  return requireRow(
    db.prepare('SELECT * FROM applications WHERE id = ?').get(id) as ApplicationStoredRow | undefined,
    'Application',
  );
}

// ── Derived money helpers ──────────────────────────────────────────────
function disbursedCents(db: Database.Database, applicationId: number): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS total FROM disbursements WHERE application_id = ?')
    .get(applicationId) as { total: number };
  return row.total;
}

function latestActivity(db: Database.Database, app: ApplicationStoredRow): string {
  const row = db
    .prepare('SELECT MAX(created_at) AS at FROM application_events WHERE application_id = ?')
    .get(app.id) as { at: string | null };
  return row.at ?? app.created_at;
}

function tranchesOf(db: Database.Database, applicationId: number): Tranche[] {
  return db
    .prepare('SELECT * FROM disbursements WHERE application_id = ? ORDER BY disbursed_on, id')
    .all(applicationId) as Tranche[];
}

interface ObligationStoredRow {
  id: number;
  application_id: number;
  title: string;
  due_date: string;
  done: number;
  done_at: string | null;
  created_at: string;
}

function obligationsOf(db: Database.Database, applicationId: number, nowMs: number): Obligation[] {
  const rows = db
    .prepare('SELECT * FROM obligations WHERE application_id = ? ORDER BY due_date, id')
    .all(applicationId) as ObligationStoredRow[];
  return rows.map((row) => ({
    id: row.id,
    application_id: row.application_id,
    title: row.title,
    due_date: row.due_date,
    done: row.done === 1,
    done_at: row.done_at,
    state: obligationState(row.due_date, row.done === 1, nowMs),
    created_at: row.created_at,
  }));
}

function eventsOf(db: Database.Database, applicationId: number): ApplicationEvent[] {
  const rows = db
    .prepare('SELECT * FROM application_events WHERE application_id = ? ORDER BY created_at, id')
    .all(applicationId) as {
    id: number;
    type: 'created' | 'status_change';
    from_status: ApplicationStatus | null;
    to_status: ApplicationStatus;
    actor: string;
    note: string | null;
    approved_amount_cents: number | null;
    created_at: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    from_status: row.from_status,
    to_status: row.to_status,
    actor: row.actor,
    note: row.note,
    approved_amount_cents: row.approved_amount_cents,
    created_at: row.created_at,
  }));
}

// ── Row / detail builders (all derived) ────────────────────────────────
function buildRow(db: Database.Database, app: ApplicationStoredRow): ApplicationRow {
  const program = getProgramRow(db, app.program_id);
  const cap = fundingCapCents(app.eligible_costs_cents, program.funding_rate);
  const disbursed = disbursedCents(db, app.id);
  const approved = app.approved_amount_cents;
  return {
    id: app.id,
    ref: app.ref,
    program_id: app.program_id,
    program_name: program.name,
    funding_body: program.funding_body,
    title: app.title,
    status: app.status,
    eligible_costs_cents: app.eligible_costs_cents,
    requested_amount_cents: app.requested_amount_cents,
    funding_cap_cents: cap,
    approved_amount_cents: approved,
    disbursed_cents: disbursed,
    remaining_cents: approved === null ? null : approved - disbursed,
    fully_disbursed: approved !== null && disbursed === approved,
    submission_date: app.submission_date,
    reference: app.reference,
    created_at: app.created_at,
    updated_at: latestActivity(db, app),
  };
}

export function applicationDetail(db: Database.Database, id: number, nowMs: number): ApplicationDetail {
  const app = getApplicationRow(db, id);
  const program = getProgramRow(db, app.program_id);
  return {
    ...buildRow(db, app),
    notes: app.notes,
    program_funding_rate: program.funding_rate,
    program_max_grant_cents: program.max_grant_cents,
    program_status: program.status,
    events: eventsOf(db, id),
    tranches: tranchesOf(db, id),
    obligations: obligationsOf(db, id, nowMs),
    allowed_transitions: allowedTransitions(app.status),
  };
}

export interface ListOpts {
  status?: ApplicationStatus;
  programId?: number;
  search?: string;
}

export function listApplications(db: Database.Database, opts: ListOpts = {}): ApplicationRow[] {
  const search = opts.search?.trim();
  const apps = db
    .prepare(
      `SELECT * FROM applications
       ${search ? 'WHERE ref LIKE @s ESCAPE \'\\\' OR title LIKE @s ESCAPE \'\\\' OR reference LIKE @s ESCAPE \'\\\'' : ''}
       ORDER BY created_at DESC, id DESC`,
    )
    .all(search ? { s: likeTerm(search) } : {}) as ApplicationStoredRow[];
  let rows = apps.map((a) => buildRow(db, a));
  if (opts.status) rows = rows.filter((r) => r.status === opts.status);
  if (opts.programId) rows = rows.filter((r) => r.program_id === opts.programId);
  return rows;
}

export function applicationsForProgram(db: Database.Database, programId: number): ApplicationRow[] {
  const apps = db
    .prepare('SELECT * FROM applications WHERE program_id = ? ORDER BY created_at DESC, id DESC')
    .all(programId) as ApplicationStoredRow[];
  return apps.map((a) => buildRow(db, a));
}

// ── Writes ─────────────────────────────────────────────────────────────
export interface ApplicationInput {
  programId: number;
  title: string;
  eligibleCostsCents: number;
  requestedAmountCents: number;
  submissionDate: string | null;
  reference: string | null;
  notes: string | null;
  createdAt?: string;
}

/**
 * The sanity rule (documented + tested): the amount we request may not
 * exceed what the program's funding rate justifies for our eligible costs
 * — requested ≤ floor(eligible_costs × funding_rate / 100). We REJECT an
 * over-cap request with 422 rather than silently capping it.
 */
function assertWithinCap(fundingRate: number, input: ApplicationInput): void {
  const cap = fundingCapCents(input.eligibleCostsCents, fundingRate);
  if (input.requestedAmountCents > cap) {
    throw new DomainError(422, 'Validation failed', [
      {
        field: 'requested_amount_cents',
        message: `Requested amount exceeds the funding cap (${cap} cents = eligible costs × ${fundingRate}%)`,
      },
    ]);
  }
}

/**
 * Create a draft application. The ref (APP-<year>-<seq>) is assigned from a
 * per-year counter in the same transaction as the insert. The opening
 * `created` event starts the append-only timeline; the application sits in
 * INITIAL_STATUS.
 */
export function createApplication(db: Database.Database, input: ApplicationInput): number {
  const program = getProgramRow(db, input.programId);
  assertWithinCap(program.funding_rate, input);
  const createdAt = input.createdAt ?? nowIso();
  const year = Number(createdAt.slice(0, 4));
  return db.transaction(() => {
    const counter = db
      .prepare(
        `INSERT INTO application_counters (year, last_seq) VALUES (?, 1)
         ON CONFLICT (year) DO UPDATE SET last_seq = last_seq + 1
         RETURNING last_seq`,
      )
      .get(year) as { last_seq: number };
    const ref = `APP-${year}-${String(counter.last_seq).padStart(4, '0')}`;
    const info = db
      .prepare(
        `INSERT INTO applications
          (ref, program_id, title, status, eligible_costs_cents, requested_amount_cents, submission_date, reference, notes, created_at)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ref,
        input.programId,
        input.title,
        input.eligibleCostsCents,
        input.requestedAmountCents,
        input.submissionDate,
        input.reference,
        input.notes,
        createdAt,
      );
    const appId = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO application_events (application_id, type, from_status, to_status, actor, note, created_at)
       VALUES (?, 'created', NULL, 'draft', ?, NULL, ?)`,
    ).run(appId, 'applicant', createdAt);
    return appId;
  })();
}

/**
 * Replace a draft's editable fields. A submitted (or further) application is
 * frozen — its numbers are what the funding body saw — so editing one is a
 * 409. The funding-cap rule is re-checked here too.
 */
export function updateApplication(db: Database.Database, id: number, input: ApplicationInput): void {
  const app = getApplicationRow(db, id);
  if (app.status !== 'draft') {
    throw new DomainError(409, `${app.ref} is ${app.status} and frozen — only drafts can be edited`);
  }
  const program = getProgramRow(db, input.programId);
  assertWithinCap(program.funding_rate, input);
  db.prepare(
    `UPDATE applications SET
       program_id = ?, title = ?, eligible_costs_cents = ?, requested_amount_cents = ?,
       submission_date = ?, reference = ?, notes = ?
     WHERE id = ?`,
  ).run(
    input.programId,
    input.title,
    input.eligibleCostsCents,
    input.requestedAmountCents,
    input.submissionDate,
    input.reference,
    input.notes,
    id,
  );
}

/** Only a never-moved draft can be deleted; anything with history cannot. */
export function deleteApplication(db: Database.Database, id: number): void {
  const app = getApplicationRow(db, id);
  if (app.status !== 'draft') {
    throw new DomainError(409, `${app.ref} has history and cannot be deleted — the timeline is append-only`);
  }
  db.prepare('DELETE FROM applications WHERE id = ?').run(id);
}

export interface TransitionInput {
  to: ApplicationStatus;
  actor: string;
  note: string | null;
  approvedAmountCents?: number | null;
  at?: string;
}

/**
 * Move an application to a new status. Illegal transition → 422 (the legal
 * moves live in status-config.ts). Approving requires an approved_amount
 * that is > 0 and ≤ the program's max grant, else 422; that amount is
 * frozen on both the application row and the timeline event, in one
 * transaction. Every move appends an event — the timeline is never mutated.
 */
export function transitionApplication(db: Database.Database, id: number, input: TransitionInput): void {
  const app = getApplicationRow(db, id);
  if (!canTransition(app.status, input.to)) {
    throw new DomainError(422, 'Validation failed', [
      {
        field: 'to',
        message: `Illegal transition ${app.status} → ${input.to} (allowed: ${allowedTransitions(app.status).join(', ') || 'none — terminal'})`,
      },
    ]);
  }
  const at = input.at ?? nowIso();

  let approvedAmount: number | null = null;
  if (input.to === 'approved') {
    const program = getProgramRow(db, app.program_id);
    const amount = input.approvedAmountCents;
    if (amount === undefined || amount === null || !Number.isInteger(amount) || amount <= 0) {
      throw new DomainError(422, 'Validation failed', [
        { field: 'approved_amount_cents', message: 'Approval requires a positive approved_amount_cents (integer)' },
      ]);
    }
    if (amount > program.max_grant_cents) {
      throw new DomainError(422, 'Validation failed', [
        {
          field: 'approved_amount_cents',
          message: `Approved amount exceeds the program's max grant (${program.max_grant_cents} cents)`,
        },
      ]);
    }
    approvedAmount = amount;
  }

  db.transaction(() => {
    // Draft → submitted stamps a submission_date if we didn't record one.
    if (input.to === 'submitted' && app.submission_date === null) {
      db.prepare('UPDATE applications SET submission_date = ? WHERE id = ?').run(at.slice(0, 10), id);
    }
    if (approvedAmount !== null) {
      db.prepare('UPDATE applications SET status = ?, approved_amount_cents = ? WHERE id = ?').run(
        input.to,
        approvedAmount,
        id,
      );
    } else {
      db.prepare('UPDATE applications SET status = ? WHERE id = ?').run(input.to, id);
    }
    db.prepare(
      `INSERT INTO application_events
        (application_id, type, from_status, to_status, actor, note, approved_amount_cents, created_at)
       VALUES (?, 'status_change', ?, ?, ?, ?, ?, ?)`,
    ).run(id, app.status, input.to, input.actor, input.note, approvedAmount, at);
  })();
}

// ── Disbursements (append-only tranches; derived remaining) ─────────────
export interface TrancheInput {
  disbursedOn: string;
  amountCents: number;
  reference: string | null;
  note: string | null;
  at?: string;
}

/**
 * Record a tranche of money we received. Only an APPROVED application can
 * be disbursed against (else 409). The remaining balance is derived
 * (approved_amount − SUM(tranches)); a tranche that would exceed it is
 * rejected with 422 INSIDE the transaction, so nothing is written. Returns
 * the new derived totals.
 */
export function recordTranche(
  db: Database.Database,
  id: number,
  input: TrancheInput,
): { disbursed_cents: number; remaining_cents: number } {
  const app = getApplicationRow(db, id);
  if (app.status !== 'approved') {
    throw new DomainError(409, `${app.ref} is ${app.status} — only approved applications can be disbursed against`);
  }
  const approved = app.approved_amount_cents as number; // non-null when approved
  return db.transaction(() => {
    const already = disbursedCents(db, id);
    const remaining = approved - already;
    if (input.amountCents > remaining) {
      throw new DomainError(422, 'Validation failed', [
        {
          field: 'amount_cents',
          message: `Tranche of ${input.amountCents} exceeds the remaining balance of ${remaining} cents (approved ${approved} − disbursed ${already})`,
        },
      ]);
    }
    db.prepare(
      `INSERT INTO disbursements (application_id, disbursed_on, amount_cents, reference, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.disbursedOn, input.amountCents, input.reference, input.note, input.at ?? nowIso());
    const disbursed = already + input.amountCents;
    return { disbursed_cents: disbursed, remaining_cents: approved - disbursed };
  })();
}

// ── Reporting obligations ──────────────────────────────────────────────
export interface ObligationInput {
  title: string;
  dueDate: string;
  at?: string;
}

/** Add a post-award reporting obligation. Only on approved applications (else 409). */
export function addObligation(db: Database.Database, id: number, input: ObligationInput): number {
  const app = getApplicationRow(db, id);
  if (app.status !== 'approved') {
    throw new DomainError(
      409,
      `${app.ref} is ${app.status} — reporting obligations attach to approved applications only`,
    );
  }
  const info = db
    .prepare('INSERT INTO obligations (application_id, title, due_date, created_at) VALUES (?, ?, ?, ?)')
    .run(id, input.title, input.dueDate, input.at ?? nowIso());
  return Number(info.lastInsertRowid);
}

/**
 * Toggle an obligation between done and not-done. Marking it done records
 * the moment (done_at); un-marking clears it. Returns the owning
 * application id so the caller can re-render its detail.
 */
export function toggleObligation(db: Database.Database, obligationId: number, at?: string): number {
  const row = requireRow(
    db.prepare('SELECT * FROM obligations WHERE id = ?').get(obligationId) as ObligationStoredRow | undefined,
    'Reporting obligation',
  );
  if (row.done === 1) {
    db.prepare('UPDATE obligations SET done = 0, done_at = NULL WHERE id = ?').run(obligationId);
  } else {
    db.prepare('UPDATE obligations SET done = 1, done_at = ? WHERE id = ?').run(at ?? nowIso(), obligationId);
  }
  return row.application_id;
}

// ── Deadlines dashboard + portfolio (all derived) ──────────────────────
export function dashboard(db: Database.Database, nowMs: number): Dashboard {
  // (a) Application deadlines of programs that are still open.
  const programRows = db
    .prepare(
      `SELECT id, name, funding_body, application_deadline
       FROM programs
       WHERE status = 'open' AND application_deadline IS NOT NULL`,
    )
    .all() as { id: number; name: string; funding_body: string; application_deadline: string }[];
  const programDeadlines: ProgramDeadlineItem[] = programRows
    .map((p) => ({
      kind: 'program' as const,
      program_id: p.id,
      program_name: p.name,
      funding_body: p.funding_body,
      due_date: p.application_deadline,
      state: deadlineState(p.application_deadline, nowMs),
    }))
    .sort((a, b) => a.due_date.localeCompare(b.due_date));

  // (b) Outstanding (not-done) reporting obligations across all applications.
  const obligationRows = db
    .prepare(
      `SELECT o.id, o.application_id, o.title, o.due_date, a.ref, a.title AS app_title, p.name AS program_name
       FROM obligations o
       JOIN applications a ON a.id = o.application_id
       JOIN programs p ON p.id = a.program_id
       WHERE o.done = 0`,
    )
    .all() as {
    id: number;
    application_id: number;
    title: string;
    due_date: string;
    ref: string;
    app_title: string;
    program_name: string;
  }[];
  const obligationDeadlines: ObligationDeadlineItem[] = obligationRows
    .map((o) => ({
      kind: 'obligation' as const,
      obligation_id: o.id,
      application_id: o.application_id,
      application_ref: o.ref,
      application_title: o.app_title,
      program_name: o.program_name,
      title: o.title,
      due_date: o.due_date,
      state: deadlineState(o.due_date, nowMs),
    }))
    .sort((a, b) => a.due_date.localeCompare(b.due_date));

  const totals = { overdue: 0, at_risk: 0, upcoming: 0 };
  for (const item of [...programDeadlines, ...obligationDeadlines]) totals[item.state] += 1;

  return {
    program_deadlines: programDeadlines,
    obligation_deadlines: obligationDeadlines,
    totals,
    portfolio: portfolioTotals(db),
  };
}

/** Portfolio money, derived across every application. */
export function portfolioTotals(db: Database.Database): PortfolioTotals {
  const counts = Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, 0])) as Record<ApplicationStatus, number>;

  const rows = db
    .prepare('SELECT status, requested_amount_cents, approved_amount_cents FROM applications')
    .all() as { status: ApplicationStatus; requested_amount_cents: number; approved_amount_cents: number | null }[];

  let requested = 0;
  let approved = 0;
  for (const r of rows) {
    counts[r.status] += 1;
    requested += r.requested_amount_cents;
    if (r.approved_amount_cents !== null) approved += r.approved_amount_cents;
  }

  const disbursedRow = db
    .prepare(
      `SELECT COALESCE(SUM(d.amount_cents), 0) AS total
       FROM disbursements d
       JOIN applications a ON a.id = d.application_id
       WHERE a.status = 'approved'`,
    )
    .get() as { total: number };
  const disbursed = disbursedRow.total;

  const programCount = (db.prepare('SELECT COUNT(*) AS n FROM programs').get() as { n: number }).n;
  const applicationCount = rows.length;

  return {
    requested_cents: requested,
    approved_cents: approved,
    disbursed_cents: disbursed,
    remaining_cents: approved - disbursed,
    program_count: programCount,
    application_count: applicationCount,
    counts_by_status: counts,
  };
}

export { AT_RISK_DAYS, INITIAL_STATUS };
