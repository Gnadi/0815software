import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  Bill,
  BillRow,
  BillStatus,
  Creditor,
  CreditorRow,
  PaymentConfig,
  PaymentRunDetail,
  PaymentRunItem,
  PaymentRunRow,
  RunStatus,
} from '../shared/types.js';
import {
  buildPain001,
  formatIban,
  ibanProblem,
  isValidBic,
  MAX_END_TO_END_ID,
  MAX_NAME,
  MAX_REMITTANCE,
  normalizeBic,
  normalizeIban,
  PAIN_VERSION,
  sepaControlSum,
  sepaText,
  validateSepaInstruction,
  type SepaInstruction,
} from '../shared/sepa.js';
import { DomainError, likeTerm, nowIso, todayIso } from './invoices.js';
import type { SellerConfig } from './config.js';

/**
 * PAYABLES — the bills we owe, and the bank file that pays them.
 *
 * The other half of MOD-04. Invoices are money coming in; a bill is money
 * going out, and the module's job with one is the mirror of its job with the
 * other: record the fact, keep the derived state derived, and produce the one
 * document the outside world needs. For an invoice that document is a PDF for
 * the customer; for a bill it is a **pain.001 SEPA credit transfer file** the
 * operator uploads in their online banking (`shared/sepa.ts`).
 *
 * Three rules, and the tests prove each of them:
 *
 * 1. **A bill can be paid once.** A bill enters at most one live payment run
 *    — checked here, and made impossible by a partial unique index in
 *    `db.ts`. Everything else about payables is recoverable; paying a
 *    supplier twice is the one mistake that costs real money and takes weeks
 *    to get back.
 * 2. **A produced file never changes.** A run freezes the debtor account, the
 *    creditor name, IBAN, BIC, amount and remittance of every transfer at the
 *    moment it is created. Correcting a supplier's IBAN afterwards changes
 *    the next run, never the file the bank already holds — and re-downloading
 *    a run yields byte-identical XML, because the identifiers and the
 *    creation timestamp are stored, not regenerated.
 * 3. **Nothing is stored that can be derived.** A bill's status
 *    (open / scheduled / paid / cancelled) and a run's status
 *    (created / executed / discarded) are computed at read time from the
 *    facts — the timestamps and whether a live run item exists — exactly as
 *    an invoice's "paid" is. There is no status column to drift.
 *
 * The module stops at the file. It holds no bank credentials, opens no EBICS
 * connection, and signs nothing: the operator uploads the file in the online
 * banking they already have, and their bank's own authorisation is what
 * releases the money. See the README for why that boundary is where it is.
 */

// ── Reading ───────────────────────────────────────────────────────────

interface CreditorCountRow extends Creditor {
  bill_count: number;
  open_cents: number | null;
}

export function listCreditors(db: Database.Database, search?: string): CreditorRow[] {
  const term = search?.trim();
  const rows = db
    .prepare(
      `SELECT c.*,
              COUNT(b.id)                                       AS bill_count,
              SUM(CASE WHEN b.paid_at IS NULL AND b.cancelled_at IS NULL
                       THEN b.amount_cents ELSE 0 END)          AS open_cents
       FROM creditors c
       LEFT JOIN bills b ON b.creditor_id = c.id
       ${term ? "WHERE c.name LIKE ? ESCAPE '\\' OR c.iban LIKE ? ESCAPE '\\'" : ''}
       GROUP BY c.id
       ORDER BY c.name COLLATE NOCASE`,
    )
    .all(...(term ? [likeTerm(term), likeTerm(term.replace(/\s+/g, '').toUpperCase())] : [])) as CreditorCountRow[];
  return rows.map((row) => ({ ...row, open_cents: row.open_cents ?? 0 }));
}

export function getCreditor(db: Database.Database, id: number): Creditor {
  const row = db.prepare('SELECT * FROM creditors WHERE id = ?').get(id) as Creditor | undefined;
  if (row === undefined) throw new DomainError(404, 'Creditor not found');
  return row;
}

interface BillJoinRow extends Bill {
  creditor_name: string;
  creditor_iban: string;
  creditor_bic: string | null;
  payment_run_id: number | null;
}

/** The label, from the facts. Order matters: cancelled and paid win over a run. */
function billStatus(bill: { paid_at: string | null; cancelled_at: string | null }, runId: number | null): BillStatus {
  if (bill.cancelled_at !== null) return 'cancelled';
  if (bill.paid_at !== null) return 'paid';
  return runId === null ? 'open' : 'scheduled';
}

/** What the file will say as the payment purpose. */
export function paymentReference(bill: { remittance: string | null; reference: string }): string {
  const text = bill.remittance !== null && bill.remittance.trim() !== '' ? bill.remittance : bill.reference;
  return text.trim();
}

function toBillRow(row: BillJoinRow, today: string): BillRow {
  const status = billStatus(row, row.payment_run_id);
  return {
    ...row,
    status,
    overdue: status === 'open' && row.due_date < today,
    payment_reference: paymentReference(row),
  };
}

const BILL_SELECT = `
  SELECT b.*,
         c.name AS creditor_name,
         c.iban AS creditor_iban,
         c.bic  AS creditor_bic,
         live.run_id AS payment_run_id
  FROM bills b
  JOIN creditors c ON c.id = b.creditor_id
  LEFT JOIN payment_run_items live ON live.bill_id = b.id AND live.active = 1
`;

export interface BillListOptions {
  search?: string;
  status?: BillStatus;
  overdueOnly?: boolean;
}

export function listBills(
  db: Database.Database,
  opts: BillListOptions = {},
  today = todayIso(),
): BillRow[] {
  const search = opts.search?.trim();
  const rows = db
    .prepare(
      `${BILL_SELECT}
       ${search ? "WHERE b.reference LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\'" : ''}
       ORDER BY b.due_date, b.id DESC`,
    )
    .all(...(search ? [likeTerm(search), likeTerm(search)] : [])) as BillJoinRow[];

  let bills = rows.map((row) => toBillRow(row, today));
  if (opts.status) bills = bills.filter((b) => b.status === opts.status);
  if (opts.overdueOnly) bills = bills.filter((b) => b.overdue);
  return bills;
}

export function getBill(db: Database.Database, id: number, today = todayIso()): BillRow {
  const row = db.prepare(`${BILL_SELECT} WHERE b.id = ?`).get(id) as BillJoinRow | undefined;
  if (row === undefined) throw new DomainError(404, 'Bill not found');
  return toBillRow(row, today);
}

// ── Creditors ─────────────────────────────────────────────────────────

export interface CreditorInput {
  name: string;
  iban: string;
  bic: string | null;
  note: string | null;
}

/**
 * Validate a creditor as strictly as the bank will, and normalize what it
 * stores. The IBAN check is the whole point of the function: it is the last
 * moment a typo is free.
 */
function checkCreditor(input: CreditorInput): CreditorInput {
  const details: { field: string; message: string }[] = [];
  const name = input.name.trim();
  if (name === '' || name.length > 160) {
    details.push({ field: 'name', message: 'Name is required (max 160 characters)' });
  } else if (sepaText(name, MAX_NAME) === '') {
    details.push({ field: 'name', message: 'Name must contain at least one character a bank file can carry' });
  }
  const iban = normalizeIban(input.iban ?? '');
  const problem = ibanProblem(iban);
  if (problem) details.push({ field: 'iban', message: problem });
  const bic = input.bic === null || input.bic.trim() === '' ? null : normalizeBic(input.bic);
  if (bic !== null && !isValidBic(bic)) {
    details.push({ field: 'bic', message: 'BIC must be 8 or 11 characters (e.g. GIBAATWWXXX)' });
  }
  if (details.length > 0) throw new DomainError(422, 'Validation failed', details);
  return { name, iban, bic, note: input.note };
}

export function createCreditor(db: Database.Database, input: CreditorInput): number {
  const value = checkCreditor(input);
  const info = db
    .prepare('INSERT INTO creditors (name, iban, bic, note, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(value.name, value.iban, value.bic, value.note, nowIso());
  return Number(info.lastInsertRowid);
}

export function updateCreditor(db: Database.Database, id: number, input: CreditorInput): void {
  getCreditor(db, id);
  const value = checkCreditor(input);
  db.prepare('UPDATE creditors SET name = ?, iban = ?, bic = ?, note = ? WHERE id = ?').run(
    value.name,
    value.iban,
    value.bic,
    value.note,
    id,
  );
}

/**
 * Delete a creditor, but only one nothing points at. A creditor with bills is
 * part of the payment history — the run items keep their own frozen copy of
 * the name and IBAN, but the bills would lose theirs.
 */
export function deleteCreditor(db: Database.Database, id: number): void {
  getCreditor(db, id);
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM bills WHERE creditor_id = ?').get(id) as {
    count: number;
  };
  if (count > 0) {
    throw new DomainError(409, `This creditor has ${count} bill(s) — they would lose their payee`);
  }
  db.prepare('DELETE FROM creditors WHERE id = ?').run(id);
}

// ── Bills ─────────────────────────────────────────────────────────────

export interface BillInput {
  creditorId: number;
  reference: string;
  remittance: string | null;
  amountCents: number;
  issueDate: string | null;
  dueDate: string;
  note: string | null;
  createdAt?: string;
}

/** A bill is only editable while it is open — see the status ladder above. */
function requireOpen(bill: BillRow, action: string): void {
  if (bill.status === 'open') return;
  const why: Record<Exclude<BillStatus, 'open'>, string> = {
    scheduled: `it is in payment run ${bill.payment_run_id ?? ''} — discard that run first`,
    paid: 'it is already settled',
    cancelled: 'it is cancelled',
  };
  throw new DomainError(409, `Cannot ${action} this bill: ${why[bill.status]}`);
}

/** A duplicate reference is the database's answer, translated for a human. */
function withDuplicateCheck<T>(db: Database.Database, creditorId: number, reference: string, run: () => T): T {
  const existing = db
    .prepare('SELECT id FROM bills WHERE creditor_id = ? AND reference = ?')
    .get(creditorId, reference) as { id: number } | undefined;
  if (existing !== undefined) {
    throw new DomainError(
      409,
      `${getCreditor(db, creditorId).name} already has a bill with reference "${reference}" (#${existing.id})`,
    );
  }
  return run();
}

export function createBill(db: Database.Database, input: BillInput): number {
  getCreditor(db, input.creditorId);
  return withDuplicateCheck(db, input.creditorId, input.reference, () => {
    const info = db
      .prepare(
        `INSERT INTO bills
           (creditor_id, reference, remittance, amount_cents, issue_date, due_date, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.creditorId,
        input.reference,
        input.remittance,
        input.amountCents,
        input.issueDate,
        input.dueDate,
        input.note,
        input.createdAt ?? nowIso(),
      );
    return Number(info.lastInsertRowid);
  });
}

export function updateBill(db: Database.Database, id: number, input: BillInput): void {
  const bill = getBill(db, id);
  requireOpen(bill, 'edit');
  getCreditor(db, input.creditorId);
  const changedKey = bill.creditor_id !== input.creditorId || bill.reference !== input.reference;
  const write = (): void => {
    db.prepare(
      `UPDATE bills SET creditor_id = ?, reference = ?, remittance = ?, amount_cents = ?,
                        issue_date = ?, due_date = ?, note = ?
       WHERE id = ?`,
    ).run(
      input.creditorId,
      input.reference,
      input.remittance,
      input.amountCents,
      input.issueDate,
      input.dueDate,
      input.note,
      id,
    );
  };
  if (changedKey) withDuplicateCheck(db, input.creditorId, input.reference, write);
  else write();
}

/**
 * Delete a bill — only one that was never part of a payment run, not even a
 * discarded one. Once a file carrying it has left the building, the bill is
 * history: cancel it instead, and the record of what was sent survives.
 */
export function deleteBill(db: Database.Database, id: number): void {
  const bill = getBill(db, id);
  requireOpen(bill, 'delete');
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM payment_run_items WHERE bill_id = ?').get(id) as {
    count: number;
  };
  if (count > 0) {
    throw new DomainError(409, 'This bill has been in a payment run — cancel it instead of deleting it');
  }
  db.prepare('DELETE FROM bills WHERE id = ?').run(id);
}

export function cancelBill(db: Database.Database, id: number, at?: string): void {
  requireOpen(getBill(db, id), 'cancel');
  db.prepare('UPDATE bills SET cancelled_at = ? WHERE id = ?').run(at ?? nowIso(), id);
}

/**
 * Record that a bill was settled outside a payment run — cash, a card, a
 * standing order, a transfer typed straight into the bank. A scheduled bill
 * is refused: its run is the record of how it is being paid, and marking the
 * bill alone would leave the run claiming to pay something already settled.
 */
export function markBillPaid(db: Database.Database, id: number, at?: string): void {
  requireOpen(getBill(db, id), 'settle');
  db.prepare('UPDATE bills SET paid_at = ? WHERE id = ?').run(at ?? nowIso(), id);
}

// ── Payment runs ──────────────────────────────────────────────────────

/** How this installation's own account is doing as a debtor. */
export function paymentConfig(
  seller: SellerConfig,
  batchBooking = false,
  bankingConfigured = false,
): PaymentConfig {
  const iban = normalizeIban(seller.iban ?? '');
  const problem = ibanProblem(iban);
  const bic = seller.bic && isValidBic(seller.bic) ? normalizeBic(seller.bic) : null;
  return {
    debtor_name: seller.name,
    debtor_iban: iban === '' ? '' : formatIban(iban),
    debtor_bic: bic,
    ready: problem === null,
    problem: problem === null ? null : `SELLER_IBAN is not a usable debtor account — ${problem}`,
    pain_version: PAIN_VERSION,
    batch_booking: batchBooking,
    banking_configured: bankingConfigured,
  };
}

/**
 * `GrpHdr/MsgId` — 24 characters of "which file is this".
 *
 * A bank rejects a second file carrying a `MsgId` it has already seen, which
 * is exactly the protection wanted here, so the id must never repeat: the
 * random half is what keeps that true across a restored backup, where the row
 * ids start again from numbers that have already been used.
 */
function newMessageId(today: string): string {
  return `MOD04-${today.replace(/-/g, '')}-${randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * `EndToEndId` — what comes back on the bank statement, so it leads with the
 * bill id (unique, and what the operator searches for) and then as much of the
 * supplier's own reference as the 35 characters allow.
 */
export function endToEndId(billId: number, reference: string): string {
  const tail = sepaText(reference, MAX_END_TO_END_ID).replace(/ /g, '-');
  const id = `B${billId}-${tail}`.slice(0, MAX_END_TO_END_ID).replace(/-+$/, '');
  return id === `B${billId}` || id === '' ? `B${billId}` : id;
}

export interface RunInput {
  billIds: number[];
  /** "YYYY-MM-DD" — when the bank should execute. Defaults to today. */
  executionDate?: string;
  createdBy?: string | null;
  batchBooking?: boolean;
  createdAt?: string;
  today?: string;
}

interface RunStoredRow {
  id: number;
  message_id: string;
  execution_date: string;
  batch_booking: number;
  debtor_name: string;
  debtor_iban: string;
  debtor_bic: string | null;
  created_by: string | null;
  executed_at: string | null;
  discarded_at: string | null;
  created_at: string;
  submitted_at: string | null;
  rejected_at: string | null;
  banking_order_id: string | null;
  bank_status: string | null;
  bank_message: string | null;
}

/**
 * Fold the timestamps into a label. Order is the ladder, most final first:
 * once the money moved or the file was thrown away, nothing earlier applies.
 */
function runStatus(row: {
  executed_at: string | null;
  discarded_at: string | null;
  submitted_at?: string | null;
  rejected_at?: string | null;
}): RunStatus {
  if (row.discarded_at !== null) return 'discarded';
  if (row.executed_at !== null) return 'executed';
  if ((row.rejected_at ?? null) !== null) return 'rejected';
  if ((row.submitted_at ?? null) !== null) return 'submitted';
  return 'created';
}

/**
 * Turn a set of open bills into one payment run: the file, frozen.
 *
 * Everything that can go wrong is refused BEFORE a row is written — an
 * unconfigured or mistyped own IBAN, a bill that is not payable, a bill
 * already sitting in a live run, a creditor whose IBAN no longer validates, a
 * date in the past. The alternative is a half-built run and a file the bank
 * bounces, discovered by an operator who has already moved on.
 */
export function createPaymentRun(db: Database.Database, seller: SellerConfig, input: RunInput): number {
  const today = input.today ?? todayIso();
  const config = paymentConfig(seller, input.batchBooking ?? false);
  if (!config.ready) throw new DomainError(409, config.problem ?? 'No debtor account is configured');

  const ids = [...new Set(input.billIds)];
  if (ids.length === 0) throw new DomainError(422, 'Select at least one bill to pay');

  const executionDate = input.executionDate ?? today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(executionDate) || Number.isNaN(Date.parse(`${executionDate}T00:00:00Z`))) {
    throw new DomainError(422, 'Execution date must be a date in YYYY-MM-DD format', [
      { field: 'execution_date', message: 'must be a date in YYYY-MM-DD format' },
    ]);
  }
  // A bank cannot execute in the past; it would either reject the file or
  // silently move every payment to the next possible day, which is a
  // different promise from the one the screen made.
  if (executionDate < today) {
    throw new DomainError(422, 'Execution date cannot be in the past', [
      { field: 'execution_date', message: `must be ${today} or later` },
    ]);
  }

  const bills = ids.map((id) => getBill(db, id, today));
  const notPayable = bills.filter((b) => b.status !== 'open');
  if (notPayable.length > 0) {
    throw new DomainError(
      409,
      `Only open bills can be paid — ${notPayable
        .map((b) => `${b.reference} is ${b.status}`)
        .join(', ')}`,
    );
  }

  const items = bills.map((bill, index) => ({
    bill_id: bill.id,
    position: index + 1,
    end_to_end_id: endToEndId(bill.id, bill.reference),
    amount_cents: bill.amount_cents,
    creditor_name: bill.creditor_name,
    creditor_iban: bill.creditor_iban,
    creditor_bic: bill.creditor_bic,
    remittance: sepaText(bill.payment_reference, MAX_REMITTANCE),
  }));

  // The bank's own file check, run here where the fields can still be fixed.
  const problems = validateSepaInstruction({
    message_id: 'PREFLIGHT',
    created_at: input.createdAt ?? nowIso(),
    execution_date: executionDate,
    batch_booking: config.batch_booking,
    debtor_name: config.debtor_name,
    debtor_iban: normalizeIban(seller.iban),
    debtor_bic: config.debtor_bic,
    payments: items.map((item) => ({
      end_to_end_id: item.end_to_end_id,
      amount_cents: item.amount_cents,
      creditor_name: item.creditor_name,
      creditor_iban: item.creditor_iban,
      creditor_bic: item.creditor_bic,
      remittance: item.remittance,
    })),
  });
  if (problems.length > 0) {
    // Name the bill, not the array index: "payments[2]" means nothing on a
    // screen that lists bills by their supplier's reference.
    const details = problems.map((problem) => {
      const at = /^payments\[(\d+)\]\.(.+)$/.exec(problem.field);
      if (!at) return problem;
      const bill = bills[Number(at[1])];
      return { field: `bill:${bill?.id ?? at[1]}.${at[2]}`, message: `${bill?.reference ?? ''}: ${problem.message}` };
    });
    throw new DomainError(422, 'This payment run cannot be turned into a bank file', details);
  }

  const createdAt = input.createdAt ?? nowIso();
  return db.transaction((): number => {
    const info = db
      .prepare(
        `INSERT INTO payment_runs
           (message_id, execution_date, batch_booking, debtor_name, debtor_iban, debtor_bic, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newMessageId(today),
        executionDate,
        config.batch_booking ? 1 : 0,
        config.debtor_name,
        normalizeIban(seller.iban),
        config.debtor_bic,
        input.createdBy ?? null,
        createdAt,
      );
    const runId = Number(info.lastInsertRowid);
    const insert = db.prepare(
      `INSERT INTO payment_run_items
         (run_id, bill_id, position, end_to_end_id, amount_cents,
          creditor_name, creditor_iban, creditor_bic, remittance, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    for (const item of items) {
      try {
        insert.run(
          runId,
          item.bill_id,
          item.position,
          item.end_to_end_id,
          item.amount_cents,
          item.creditor_name,
          item.creditor_iban,
          item.creditor_bic,
          item.remittance,
        );
      } catch (err) {
        // The partial unique index in db.ts fired: something else put this
        // bill in a live run between the check above and this insert.
        if (String(err).includes('idx_run_items_live_bill')) {
          throw new DomainError(409, `Bill ${item.bill_id} is already in a payment run`);
        }
        throw err;
      }
    }
    return runId;
  })();
}

function runRow(db: Database.Database, row: RunStoredRow): PaymentRunRow {
  const totals = db
    .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(amount_cents), 0) AS total FROM payment_run_items WHERE run_id = ?')
    .get(row.id) as { count: number; total: number };
  return {
    id: row.id,
    message_id: row.message_id,
    execution_date: row.execution_date,
    status: runStatus(row),
    debtor_name: row.debtor_name,
    debtor_iban: row.debtor_iban,
    debtor_bic: row.debtor_bic,
    item_count: totals.count,
    total_cents: totals.total,
    created_by: row.created_by,
    created_at: row.created_at,
    executed_at: row.executed_at,
    discarded_at: row.discarded_at,
    submitted_at: row.submitted_at ?? null,
    rejected_at: row.rejected_at ?? null,
    banking_order_id: row.banking_order_id ?? null,
    bank_status: row.bank_status ?? null,
    bank_message: row.bank_message ?? null,
  };
}

export function listPaymentRuns(db: Database.Database): PaymentRunRow[] {
  const rows = db.prepare('SELECT * FROM payment_runs ORDER BY id DESC').all() as RunStoredRow[];
  return rows.map((row) => runRow(db, row));
}

function getRun(db: Database.Database, id: number): RunStoredRow {
  const row = db.prepare('SELECT * FROM payment_runs WHERE id = ?').get(id) as RunStoredRow | undefined;
  if (row === undefined) throw new DomainError(404, 'Payment run not found');
  return row;
}

export function paymentRunDetail(db: Database.Database, id: number): PaymentRunDetail {
  const row = getRun(db, id);
  const items = db
    .prepare(
      `SELECT i.bill_id, i.position, i.end_to_end_id, i.amount_cents,
              i.creditor_name, i.creditor_iban, i.creditor_bic, i.remittance,
              b.reference AS reference
       FROM payment_run_items i
       JOIN bills b ON b.id = i.bill_id
       WHERE i.run_id = ?
       ORDER BY i.position`,
    )
    .all(id) as PaymentRunItem[];
  return { ...runRow(db, row), items };
}

/**
 * The file for a run — rebuilt from the frozen snapshot every time, and
 * therefore identical every time. Nothing here reads a creditor, the seller
 * config or the clock.
 */
export function paymentRunXml(db: Database.Database, id: number): string {
  const row = getRun(db, id);
  const detail = paymentRunDetail(db, id);
  const instruction: SepaInstruction = {
    message_id: row.message_id,
    created_at: row.created_at,
    execution_date: row.execution_date,
    batch_booking: row.batch_booking === 1,
    debtor_name: row.debtor_name,
    debtor_iban: row.debtor_iban,
    debtor_bic: row.debtor_bic,
    payments: detail.items.map((item) => ({
      end_to_end_id: item.end_to_end_id,
      amount_cents: item.amount_cents,
      creditor_name: item.creditor_name,
      creditor_iban: item.creditor_iban,
      creditor_bic: item.creditor_bic,
      remittance: item.remittance,
    })),
  };
  const problems = validateSepaInstruction(instruction);
  if (problems.length > 0) {
    // Unreachable through the API — createPaymentRun validates the same
    // instruction before storing it — and worth failing loudly if a hand-edited
    // database ever makes it reachable, rather than emitting a broken file.
    throw new DomainError(500, 'The stored payment run is not a valid SEPA instruction', problems);
  }
  return buildPain001(instruction);
}

/** Filename for a downloaded run: the MsgId is what the bank calls it too. */
export function paymentRunFilename(messageId: string): string {
  return `sepa-${messageId.toLowerCase()}.xml`;
}

// ── Sending the file over EBICS (PS-12 Banking) ────────────────────────

/** What PS-12 said about the order, as this module needs it. */
export interface BankSubmission {
  /** PS-12's own id for the order — the handle for every later question. */
  orderId: string;
  /** `accepted`, `rejected`, `failed`, or a mid-flight status. */
  status: string;
  message: string | null;
}

/**
 * Record what the bank did with a run.
 *
 * The three outcomes are deliberately not collapsed, because the operator's
 * next move differs completely:
 *
 * - **accepted** — the run is `submitted`. Its bills stay `scheduled`: the
 *   bank taking the file is not the bank having paid it.
 * - **rejected** — the bank refused it, so nobody acted on it: the run is
 *   `rejected` and its items go inactive, releasing the bills back to `open`
 *   so a corrected run can be built. That run gets a fresh `MsgId`, which is
 *   what the bank's own duplicate check requires.
 * - **failed** — the conversation broke and whether the bank has the file is
 *   UNKNOWN. This is the dangerous one, so it behaves like `accepted`: the run
 *   is `submitted` and the bills stay scheduled. Releasing bills whose file may
 *   be in a bank's queue is how the same invoice gets paid twice. The stored
 *   `bank_status` is what the screens use to say so out loud.
 */
export function recordBankSubmission(
  db: Database.Database,
  id: number,
  submission: BankSubmission,
  at?: string,
): void {
  const row = getRun(db, id);
  const when = at ?? nowIso();
  const rejected = submission.status === 'rejected';

  db.transaction(() => {
    db.prepare(
      `UPDATE payment_runs
          SET banking_order_id = ?, bank_status = ?, bank_message = ?,
              submitted_at = COALESCE(submitted_at, ?), rejected_at = ?
        WHERE id = ?`,
    ).run(submission.orderId, submission.status, submission.message, when, rejected ? when : null, id);

    if (rejected) {
      db.prepare('UPDATE payment_run_items SET active = 0 WHERE run_id = ?').run(row.id);
    }
  })();
}

/**
 * May this run be handed to the bank at all?
 *
 * Separate from `recordBankSubmission` so the check can run BEFORE the call
 * that moves money, and so the route can refuse without a network round trip.
 */
export function assertRunSubmittable(db: Database.Database, id: number): PaymentRunRow {
  const run = runRow(db, getRun(db, id));
  if (run.status !== 'created') {
    throw new DomainError(
      409,
      run.status === 'submitted'
        ? `This payment run was already sent to the bank as ${run.banking_order_id ?? 'an order'}`
        : `This payment run is ${run.status} — only a run that has not been sent can be submitted`,
    );
  }
  if (run.item_count === 0) throw new DomainError(409, 'This payment run has no transfers');
  return run;
}

/**
 * The bank executed the file: every bill in the run is settled, in one
 * transaction. The run stays live (its items keep `active = 1`), so its bills
 * can never be pulled into a second run.
 */
export function markRunExecuted(db: Database.Database, id: number, at?: string): void {
  const row = getRun(db, id);
  const status = runStatus(row);
  // `submitted` is allowed as well as `created`: sending the file over EBICS
  // and confirming the bank actually paid it are two different facts, and the
  // second one still arrives by hand until phase 6 reads camt.053.
  if (status !== 'created' && status !== 'submitted') {
    throw new DomainError(409, `This payment run is already ${status}`);
  }
  const when = at ?? nowIso();
  db.transaction(() => {
    db.prepare('UPDATE payment_runs SET executed_at = ? WHERE id = ?').run(when, id);
    db.prepare(
      `UPDATE bills SET paid_at = ?
       WHERE paid_at IS NULL AND cancelled_at IS NULL
         AND id IN (SELECT bill_id FROM payment_run_items WHERE run_id = ?)`,
    ).run(when, id);
  })();
}

/**
 * Throw the run away: it was never uploaded, or the bank refused it. Its
 * items go inactive, which releases the bills back to `open` — the only way a
 * bill ever leaves a run. The run itself is kept, because "we produced this
 * file and then did not use it" is exactly the thing an operator needs to see
 * when a payment goes missing.
 *
 * A discarded run is never re-usable: the next run gets a new `MsgId`, so a
 * file the bank might have seen can never be produced a second time.
 */
export function discardRun(db: Database.Database, id: number, at?: string): void {
  const row = getRun(db, id);
  const status = runStatus(row);
  // A run already handed to the bank cannot be discarded, and that is the
  // point: discarding releases its bills, and releasing bills whose file may
  // be sitting in a bank's queue is how the same invoice gets paid twice.
  if (status !== 'created') {
    throw new DomainError(409, `This payment run is ${status} — it cannot be discarded`);
  }
  const when = at ?? nowIso();
  db.transaction(() => {
    db.prepare('UPDATE payment_runs SET discarded_at = ? WHERE id = ?').run(when, id);
    db.prepare('UPDATE payment_run_items SET active = 0 WHERE run_id = ?').run(id);
  })();
}

/** Totals for the payables screens — the same numbers the list adds up to. */
export function payablesSummary(
  db: Database.Database,
  today = todayIso(),
): { open_count: number; open_cents: number; overdue_count: number; overdue_cents: number; scheduled_count: number; scheduled_cents: number } {
  const bills = listBills(db, {}, today);
  const open = bills.filter((b) => b.status === 'open');
  const overdue = open.filter((b) => b.overdue);
  const scheduled = bills.filter((b) => b.status === 'scheduled');
  return {
    open_count: open.length,
    open_cents: sepaControlSum(open),
    overdue_count: overdue.length,
    overdue_cents: sepaControlSum(overdue),
    scheduled_count: scheduled.length,
    scheduled_cents: sepaControlSum(scheduled),
  };
}
