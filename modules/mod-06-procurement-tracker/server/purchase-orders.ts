import type Database from 'better-sqlite3';
import { computeTotalCents, lineNetCents } from '../shared/money.js';
import type {
  Approval,
  PoDetail,
  PoLine,
  PoRow,
  PoStatus,
  PoStoredStatus,
  Submission,
  Supplier,
} from '../shared/types.js';
import { requiredTiers, tierLabel } from './approval-config.js';

/** A LIKE pattern that matches the term literally — see the ESCAPE clauses below. */
export function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

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

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function requireRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new DomainError(404, `${what} not found`);
  return row;
}

export function getSupplier(db: Database.Database, id: number): Supplier {
  return requireRow(
    db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id) as Supplier | undefined,
    'Supplier',
  );
}

interface PoStoredRow {
  id: number;
  number: string;
  supplier_id: number;
  rfq_id: number | null;
  status: PoStoredStatus;
  submission_no: number;
  note: string | null;
  ordered_at: string | null;
  closed_at: string | null;
  created_at: string;
}

function getPo(db: Database.Database, id: number): PoStoredRow {
  return requireRow(
    db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as PoStoredRow | undefined,
    'Purchase order',
  );
}

export function poLines(db: Database.Database, poId: number): PoLine[] {
  const rows = db
    .prepare('SELECT * FROM po_lines WHERE po_id = ? ORDER BY position, id')
    .all(poId) as Omit<PoLine, 'net_cents'>[];
  return rows.map((row) => ({ ...row, net_cents: lineNetCents(row) }));
}

interface SubmissionStoredRow {
  submission_no: number;
  total_cents: number;
  required_tiers: string;
  created_at: string;
}

function submissionsOf(db: Database.Database, po: PoStoredRow): Submission[] {
  const rows = db
    .prepare(
      'SELECT submission_no, total_cents, required_tiers, created_at FROM po_submissions WHERE po_id = ? ORDER BY submission_no',
    )
    .all(po.id) as SubmissionStoredRow[];
  return rows.map((row) => ({
    submission_no: row.submission_no,
    total_cents: row.total_cents,
    required_tiers: JSON.parse(row.required_tiers) as number[],
    created_at: row.created_at,
    active: row.submission_no === po.submission_no && po.status !== 'draft',
  }));
}

/**
 * The frozen tier list of the CURRENT, active submission — [] while the
 * PO sits in draft (a draft has no active submission, even if it has
 * been submitted and rejected before).
 */
function activeRequiredTiers(db: Database.Database, po: PoStoredRow): number[] {
  if (po.status === 'draft') return [];
  const row = db
    .prepare('SELECT required_tiers FROM po_submissions WHERE po_id = ? AND submission_no = ?')
    .get(po.id, po.submission_no) as { required_tiers: string } | undefined;
  return row ? (JSON.parse(row.required_tiers) as number[]) : [];
}

interface ApprovalStoredRow {
  id: number;
  po_id: number;
  submission_no: number;
  tier: number;
  decision: 'approved' | 'rejected';
  approver: string;
  note: string | null;
  created_at: string;
}

function approvalHistory(db: Database.Database, po: PoStoredRow): Approval[] {
  const rows = db
    .prepare('SELECT * FROM approvals WHERE po_id = ? ORDER BY id')
    .all(po.id) as ApprovalStoredRow[];
  return rows.map((row) => ({
    ...row,
    tier_label: tierLabel(row.tier),
    // Derived, never stored: a row is void once its submission is no
    // longer the active one — either superseded by a re-submit or
    // orphaned because the PO went back to draft (rejection/withdrawal).
    voided: !(row.submission_no === po.submission_no && po.status !== 'draft'),
  }));
}

/** Tiers holding an ACTIVE approval (current submission, PO not in draft). */
function approvedTiers(db: Database.Database, po: PoStoredRow): number[] {
  if (po.status === 'draft') return [];
  const rows = db
    .prepare(
      "SELECT DISTINCT tier FROM approvals WHERE po_id = ? AND submission_no = ? AND decision = 'approved' ORDER BY tier",
    )
    .all(po.id, po.submission_no) as { tier: number }[];
  return rows.map((r) => r.tier);
}

/** Derived lifecycle status: "approved" = submitted with every frozen tier approved. */
function derivedStatus(po: PoStoredRow, required: number[], approved: number[]): PoStatus {
  if (po.status === 'submitted' && required.every((t) => approved.includes(t))) return 'approved';
  return po.status;
}

function toRow(db: Database.Database, po: PoStoredRow): PoRow {
  const required = activeRequiredTiers(db, po);
  const approved = approvedTiers(db, po);
  const supplier = db
    .prepare('SELECT name FROM suppliers WHERE id = ?')
    .get(po.supplier_id) as { name: string };
  return {
    id: po.id,
    number: po.number,
    supplier_id: po.supplier_id,
    supplier_name: supplier.name,
    rfq_id: po.rfq_id,
    status: derivedStatus(po, required, approved),
    total_cents: computeTotalCents(poLines(db, po.id)),
    required_tiers: required,
    approved_tiers: approved,
    created_at: po.created_at,
    ordered_at: po.ordered_at,
  };
}

export function listPos(db: Database.Database, opts: { status?: PoStatus; search?: string } = {}): PoRow[] {
  const search = opts.search?.trim();
  const pos = db
    .prepare(
      `SELECT p.* FROM purchase_orders p JOIN suppliers s ON s.id = p.supplier_id
       ${search ? 'WHERE p.number LIKE ? ESCAPE \'\\\' OR s.name LIKE ? ESCAPE \'\\\'' : ''}
       ORDER BY p.number DESC`,
    )
    .all(...(search ? [likeTerm(search), likeTerm(search)] : [])) as PoStoredRow[];
  let rows = pos.map((po) => toRow(db, po));
  if (opts.status) rows = rows.filter((r) => r.status === opts.status);
  return rows;
}

export function poDetail(db: Database.Database, id: number): PoDetail {
  const po = getPo(db, id);
  const row = toRow(db, po);
  const pending = row.required_tiers.filter((t) => !row.approved_tiers.includes(t));
  return {
    ...row,
    note: po.note,
    closed_at: po.closed_at,
    submission_no: po.submission_no,
    next_tier: po.status === 'submitted' && pending.length > 0 ? pending[0]! : null,
    lines: poLines(db, id),
    submissions: submissionsOf(db, po),
    approvals: approvalHistory(db, po),
  };
}

export interface PoLineInput {
  description: string;
  quantity: number;
  unit: string;
  unitPriceCents: number;
}

export interface PoInput {
  supplierId: number;
  note: string | null;
  lines: PoLineInput[];
  rfqId?: number | null;
  createdAt?: string;
}

function writeLines(db: Database.Database, poId: number, lines: PoLineInput[]): void {
  const insert = db.prepare(
    `INSERT INTO po_lines (po_id, position, description, quantity, unit, unit_price_cents)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  lines.forEach((line, i) => {
    insert.run(poId, i + 1, line.description, line.quantity, line.unit, line.unitPriceCents);
  });
}

/**
 * Create a draft PO. The number (PO-<year>-<seq>) is assigned here, from
 * a per-year counter, in the same transaction as the insert — POs keep
 * their number through every submit/reject cycle.
 */
export function createPo(db: Database.Database, input: PoInput): number {
  getSupplier(db, input.supplierId);
  const createdAt = input.createdAt ?? nowIso();
  const year = Number(createdAt.slice(0, 4));
  return db.transaction(() => {
    const counter = db
      .prepare(
        `INSERT INTO po_counters (year, last_seq) VALUES (?, 1)
         ON CONFLICT (year) DO UPDATE SET last_seq = last_seq + 1
         RETURNING last_seq`,
      )
      .get(year) as { last_seq: number };
    const number = `PO-${year}-${String(counter.last_seq).padStart(4, '0')}`;
    const info = db
      .prepare(
        `INSERT INTO purchase_orders (number, supplier_id, rfq_id, status, note, created_at)
         VALUES (?, ?, ?, 'draft', ?, ?)`,
      )
      .run(number, input.supplierId, input.rfqId ?? null, input.note, createdAt);
    const poId = Number(info.lastInsertRowid);
    writeLines(db, poId, input.lines);
    return poId;
  })();
}

/**
 * Replace a draft's supplier, note and lines. THE 409 rule: a PO that
 * has been submitted (or is further along) is frozen — its lines are
 * exactly what the approvers saw. Send it back to draft first (which
 * voids the approvals), then edit.
 */
export function updatePo(db: Database.Database, id: number, input: PoInput): void {
  const po = getPo(db, id);
  if (po.status !== 'draft') {
    throw new DomainError(
      409,
      `${po.number} is ${po.status} and frozen — return it to draft first (this voids all approvals)`,
    );
  }
  getSupplier(db, input.supplierId);
  db.transaction(() => {
    db.prepare('UPDATE purchase_orders SET supplier_id = ?, note = ? WHERE id = ?').run(
      input.supplierId,
      input.note,
      id,
    );
    db.prepare('DELETE FROM po_lines WHERE po_id = ?').run(id);
    writeLines(db, id, input.lines);
  })();
}

/** Never-submitted drafts can be deleted; anything with history cannot. */
export function deletePo(db: Database.Database, id: number): void {
  const po = getPo(db, id);
  if (po.status !== 'draft' || po.submission_no > 0) {
    throw new DomainError(
      409,
      `${po.number} has approval history and cannot be deleted — history is append-only`,
    );
  }
  const awarded = db
    .prepare('SELECT id FROM rfqs WHERE awarded_po_id = ?')
    .get(id) as { id: number } | undefined;
  if (awarded) {
    throw new DomainError(409, `${po.number} was created by awarding RFQ #${awarded.id} and cannot be deleted`);
  }
  db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(id);
}

/**
 * Submit a draft for approval — the moment the workflow is frozen. The
 * required tiers are computed FROM THE TOTAL via the one config file
 * and written into an immutable po_submissions snapshot together with
 * that total; later edits to the config never touch already-submitted
 * POs.
 */
export function submitPo(db: Database.Database, id: number, at?: string): void {
  const po = getPo(db, id);
  if (po.status !== 'draft') {
    throw new DomainError(409, `Only drafts can be submitted (status: ${po.status})`);
  }
  const lines = poLines(db, id);
  if (lines.length === 0) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'lines', message: 'A purchase order needs at least one line before it can be submitted' },
    ]);
  }
  const total = computeTotalCents(lines);
  const tiers = requiredTiers(total);
  db.transaction(() => {
    const next = po.submission_no + 1;
    db.prepare(
      `INSERT INTO po_submissions (po_id, submission_no, total_cents, required_tiers, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, next, total, JSON.stringify(tiers), at ?? nowIso());
    db.prepare("UPDATE purchase_orders SET status = 'submitted', submission_no = ? WHERE id = ?").run(
      next,
      id,
    );
  })();
}

/**
 * Withdraw a submitted PO back to draft. Nothing is deleted: the
 * current submission simply stops being active, so its approvals become
 * void by derivation while every history row survives.
 */
export function returnToDraft(db: Database.Database, id: number): void {
  const po = getPo(db, id);
  if (po.status !== 'submitted') {
    throw new DomainError(409, `Only submitted POs can be returned to draft (status: ${po.status})`);
  }
  db.prepare("UPDATE purchase_orders SET status = 'draft' WHERE id = ?").run(id);
}

export interface DecisionInput {
  tier: number;
  approver: string;
  note: string | null;
  at?: string;
}

/**
 * Record a tier approval. Strictly in tier order: every required tier
 * below this one must already hold an active approval, otherwise 422.
 * Approving a tier the total does not require is 422; approving the
 * same tier twice is 409. Rows are appended, never mutated.
 */
export function approvePo(db: Database.Database, id: number, input: DecisionInput): void {
  const po = getPo(db, id);
  if (po.status !== 'submitted') {
    throw new DomainError(409, `Only submitted POs can be approved (status: ${po.status})`);
  }
  db.transaction(() => {
    const required = activeRequiredTiers(db, po);
    if (!required.includes(input.tier)) {
      throw new DomainError(422, 'Validation failed', [
        {
          field: 'tier',
          message: `Tier ${input.tier} is not required for this PO (required: ${required.join(', ')})`,
        },
      ]);
    }
    const approved = approvedTiers(db, po);
    if (approved.includes(input.tier)) {
      throw new DomainError(409, `Tier ${input.tier} has already approved ${po.number}`);
    }
    const pendingBelow = required.filter((t) => t < input.tier && !approved.includes(t));
    if (pendingBelow.length > 0) {
      throw new DomainError(422, 'Validation failed', [
        {
          field: 'tier',
          message: `Approvals must happen in tier order — tier ${pendingBelow[0]} (${tierLabel(pendingBelow[0]!)}) has not approved yet`,
        },
      ]);
    }
    db.prepare(
      `INSERT INTO approvals (po_id, submission_no, tier, decision, approver, note, created_at)
       VALUES (?, ?, ?, 'approved', ?, ?, ?)`,
    ).run(id, po.submission_no, input.tier, input.approver, input.note, input.at ?? nowIso());
  })();
}

/**
 * Reject at a tier: appends a rejection row and returns the PO to
 * draft, which voids every approval of this submission by derivation —
 * the rows themselves are retained forever (append-only). Any required
 * tier that has not already approved may reject; approvals so far are
 * lost either way.
 */
export function rejectPo(db: Database.Database, id: number, input: DecisionInput): void {
  const po = getPo(db, id);
  if (po.status !== 'submitted') {
    throw new DomainError(409, `Only submitted POs can be rejected (status: ${po.status})`);
  }
  db.transaction(() => {
    const required = activeRequiredTiers(db, po);
    if (!required.includes(input.tier)) {
      throw new DomainError(422, 'Validation failed', [
        {
          field: 'tier',
          message: `Tier ${input.tier} is not required for this PO (required: ${required.join(', ')})`,
        },
      ]);
    }
    if (approvedTiers(db, po).includes(input.tier)) {
      throw new DomainError(409, `Tier ${input.tier} has already approved ${po.number} and cannot also reject it`);
    }
    db.prepare(
      `INSERT INTO approvals (po_id, submission_no, tier, decision, approver, note, created_at)
       VALUES (?, ?, ?, 'rejected', ?, ?, ?)`,
    ).run(id, po.submission_no, input.tier, input.approver, input.note, input.at ?? nowIso());
    db.prepare("UPDATE purchase_orders SET status = 'draft' WHERE id = ?").run(id);
  })();
}

/** Only a FULLY approved PO may become ordered — anything pending is 422. */
export function markOrdered(db: Database.Database, id: number, at?: string): void {
  const po = getPo(db, id);
  if (po.status !== 'submitted') {
    throw new DomainError(409, `Only submitted POs can be marked ordered (status: ${po.status})`);
  }
  db.transaction(() => {
    const required = activeRequiredTiers(db, po);
    const approved = approvedTiers(db, po);
    const pending = required.filter((t) => !approved.includes(t));
    if (pending.length > 0) {
      throw new DomainError(422, 'Validation failed', [
        {
          field: 'status',
          message: `Not fully approved — tier${pending.length > 1 ? 's' : ''} ${pending.join(', ')} still pending`,
        },
      ]);
    }
    db.prepare("UPDATE purchase_orders SET status = 'ordered', ordered_at = ? WHERE id = ?").run(
      at ?? nowIso(),
      id,
    );
  })();
}

export function closePo(db: Database.Database, id: number, at?: string): void {
  const po = getPo(db, id);
  if (po.status !== 'ordered') {
    throw new DomainError(409, `Only ordered POs can be closed (status: ${po.status})`);
  }
  db.prepare("UPDATE purchase_orders SET status = 'closed', closed_at = ? WHERE id = ?").run(
    at ?? nowIso(),
    id,
  );
}
