import type Database from 'better-sqlite3';
import { computeTotals, lineNetCents } from '../shared/money.js';
import type {
  CreditNote,
  Customer,
  InvoiceDetail,
  InvoiceLine,
  InvoiceRow,
  InvoiceStatus,
  Ledger,
  LedgerEntry,
  Payment,
  PaymentStatus,
  StoredStatus,
  TaxExemptionCategory,
  VatBreakdownRow,
} from '../shared/types.js';

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

/** "YYYY-MM-DD" for today (UTC) — the reference date for "overdue". */
export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** date + n days, both as "YYYY-MM-DD". */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function requireRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new DomainError(404, `${what} not found`);
  return row;
}

export function getCustomer(db: Database.Database, id: number): Customer {
  return requireRow(
    db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Customer | undefined,
    'Customer',
  );
}

interface InvoiceStoredRow {
  id: number;
  number: string | null;
  customer_id: number;
  status: StoredStatus;
  issue_date: string | null;
  due_date: string | null;
  payment_terms_days: number;
  note: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  created_at: string;
  buyer_reference: string | null;
  delivery_date: string | null;
  tax_exemption_category: TaxExemptionCategory | null;
  tax_exemption_reason: string | null;
  seller_snapshot: string | null;
  buyer_snapshot: string | null;
}

export function getInvoice(db: Database.Database, id: number): InvoiceStoredRow {
  return requireRow(
    db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as InvoiceStoredRow | undefined,
    'Invoice',
  );
}

export function invoiceLines(db: Database.Database, invoiceId: number): InvoiceLine[] {
  const rows = db
    .prepare('SELECT * FROM invoice_lines WHERE invoice_id = ? ORDER BY position, id')
    .all(invoiceId) as Omit<InvoiceLine, 'net_cents'>[];
  return rows.map((row) => ({ ...row, net_cents: lineNetCents(row) }));
}

function paidCents(db: Database.Database, invoiceId: number): number {
  const row = db
    .prepare('SELECT COALESCE(SUM(amount_cents), 0) AS paid FROM payments WHERE invoice_id = ?')
    .get(invoiceId) as { paid: number };
  return row.paid;
}

interface CreditNoteStoredRow {
  id: number;
  invoice_id: number;
  seq: number;
  number: string;
  issue_date: string;
  reason: string;
  actor: string;
  created_at: string;
}

/** The credit notes of an invoice, oldest first, each with its own totals. */
export function creditNotesOf(db: Database.Database, invoiceId: number): CreditNote[] {
  const notes = db
    .prepare('SELECT * FROM credit_notes WHERE invoice_id = ? ORDER BY seq')
    .all(invoiceId) as CreditNoteStoredRow[];
  if (notes.length === 0) return [];
  const invoiceNumber = (db.prepare('SELECT number FROM invoices WHERE id = ?').get(invoiceId) as { number: string }).number;
  return notes.map((note) => toCreditNote(db, note, invoiceNumber));
}

function toCreditNote(db: Database.Database, note: CreditNoteStoredRow, invoiceNumber: string): CreditNote {
  const rows = db
    .prepare('SELECT * FROM credit_note_lines WHERE credit_note_id = ? ORDER BY position, id')
    .all(note.id) as (Omit<InvoiceLine, 'net_cents' | 'invoice_id'> & { credit_note_id: number })[];
  const lines: InvoiceLine[] = rows.map(({ credit_note_id: _cn, ...row }) => ({
    ...row,
    invoice_id: note.invoice_id,
    net_cents: lineNetCents(row),
  }));
  const totals = computeTotals(lines);
  return {
    id: note.id,
    invoice_id: note.invoice_id,
    invoice_number: invoiceNumber,
    number: note.number,
    issue_date: note.issue_date,
    reason: note.reason,
    lines,
    vat_breakdown: totals.by_rate,
    net_cents: totals.net_cents,
    vat_cents: totals.vat_cents,
    gross_cents: totals.gross_cents,
    actor: note.actor,
    created_at: note.created_at,
  };
}

export function getCreditNote(db: Database.Database, id: number): CreditNote {
  const note = requireRow(
    db.prepare('SELECT * FROM credit_notes WHERE id = ?').get(id) as CreditNoteStoredRow | undefined,
    'Credit note',
  );
  const invoice = getInvoice(db, note.invoice_id);
  return toCreditNote(db, note, invoice.number!);
}

/**
 * Per VAT rate, what a further credit note may still take back: the
 * invoice's base and VAT minus every credit note's. Both, not only the base —
 * each document rounds its VAT on its own base, so two half credits could
 * otherwise return a cent more VAT than the invoice charged.
 */
export function creditableByRate(db: Database.Database, invoiceId: number): VatBreakdownRow[] {
  const invoiced = computeTotals(invoiceLines(db, invoiceId)).by_rate;
  const notes = creditNotesOf(db, invoiceId);
  return invoiced.map((row) => {
    const taken = notes.flatMap((n) => n.vat_breakdown).filter((r) => r.rate === row.rate);
    return {
      rate: row.rate,
      base_cents: row.base_cents - taken.reduce((sum, r) => sum + r.base_cents, 0),
      vat_cents: row.vat_cents - taken.reduce((sum, r) => sum + r.vat_cents, 0),
    };
  });
}

function creditedCents(db: Database.Database, invoiceId: number): number {
  return creditNotesOf(db, invoiceId).reduce((sum, n) => sum + n.gross_cents, 0);
}

/** What the customer still owes on an issued invoice; may be negative after a credit on a paid one. */
function owedCents(grossCents: number, credited: number): number {
  return grossCents - credited;
}

function paymentStatusOf(owed: number, paid: number): PaymentStatus {
  if (paid <= 0) return 'unpaid';
  return paid >= owed ? 'paid' : 'partially_paid';
}

/**
 * Derived lifecycle status: "paid" is a sent invoice whose payments cover
 * what is owed. One credited in full without a payment stays "sent" with
 * nothing open — nobody paid it.
 */
function derivedStatus(stored: StoredStatus, owed: number, paid: number): InvoiceStatus {
  if (stored === 'sent' && owed > 0 && paid >= owed) return 'paid';
  return stored;
}

function isOverdue(status: InvoiceStatus, dueDate: string | null, open: number, today: string): boolean {
  return status === 'sent' && open > 0 && dueDate !== null && dueDate < today;
}

function toRow(
  db: Database.Database,
  invoice: InvoiceStoredRow,
  today: string,
): { row: InvoiceRow; lines: InvoiceLine[] } {
  const lines = invoiceLines(db, invoice.id);
  const totals = computeTotals(lines);
  const paid = paidCents(db, invoice.id);
  const credited = invoice.status === 'draft' ? 0 : creditedCents(db, invoice.id);
  const owed = owedCents(totals.gross_cents, credited);
  const status = derivedStatus(invoice.status, owed, paid);
  const open = invoice.status === 'sent' ? Math.max(0, owed - paid) : 0;
  const customer = db
    .prepare('SELECT name FROM customers WHERE id = ?')
    .get(invoice.customer_id) as { name: string };
  return {
    lines,
    row: {
      id: invoice.id,
      number: invoice.number,
      customer_id: invoice.customer_id,
      customer_name: customer.name,
      status,
      payment_status: paymentStatusOf(owed, paid),
      issue_date: invoice.issue_date,
      due_date: invoice.due_date,
      overdue: isOverdue(status, invoice.due_date, open, today),
      net_cents: totals.net_cents,
      vat_cents: totals.vat_cents,
      gross_cents: totals.gross_cents,
      credited_cents: credited,
      paid_cents: paid,
      open_cents: open,
      created_at: invoice.created_at,
    },
  };
}

export interface ListOptions {
  search?: string;
  status?: InvoiceStatus;
  overdueOnly?: boolean;
}

export function listInvoices(
  db: Database.Database,
  opts: ListOptions = {},
  today = todayIso(),
): InvoiceRow[] {
  const search = opts.search?.trim();
  const invoices = db
    .prepare(
      `SELECT i.* FROM invoices i JOIN customers c ON c.id = i.customer_id
       ${search ? 'WHERE i.number LIKE ? ESCAPE \'\\\' OR c.name LIKE ? ESCAPE \'\\\'' : ''}
       ORDER BY i.number IS NULL DESC, i.number DESC, i.id DESC`,
    )
    .all(...(search ? [likeTerm(search), likeTerm(search)] : [])) as InvoiceStoredRow[];

  let rows = invoices.map((invoice) => toRow(db, invoice, today).row);
  if (opts.status) rows = rows.filter((r) => r.status === opts.status);
  if (opts.overdueOnly) rows = rows.filter((r) => r.overdue);
  return rows;
}

export function invoiceDetail(
  db: Database.Database,
  id: number,
  today = todayIso(),
): InvoiceDetail {
  const invoice = getInvoice(db, id);
  const { row, lines } = toRow(db, invoice, today);
  const totals = computeTotals(lines);
  const payments = db
    .prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY date, id')
    .all(id) as Payment[];
  return {
    ...row,
    payment_terms_days: invoice.payment_terms_days,
    note: invoice.note,
    buyer_reference: invoice.buyer_reference,
    delivery_date: invoice.delivery_date,
    tax_exemption_category: invoice.tax_exemption_category,
    tax_exemption_reason: invoice.tax_exemption_reason,
    parties_frozen: invoice.seller_snapshot !== null && invoice.buyer_snapshot !== null,
    cancelled_at: invoice.cancelled_at,
    cancellation_reason: invoice.cancellation_reason,
    lines,
    vat_breakdown: totals.by_rate,
    payments,
    credit_notes: invoice.status === 'draft' ? [] : creditNotesOf(db, id),
    creditable: invoice.status === 'sent' ? creditableByRate(db, id) : [],
  };
}

export interface LineInput {
  description: string;
  quantity: number;
  unitPriceCents: number;
  vatRate: number;
}

export interface DraftInput {
  customerId: number;
  paymentTermsDays: number;
  note: string | null;
  lines: LineInput[];
  createdAt?: string;
  /** E-invoice fields — optional so every existing caller keeps working. */
  buyerReference?: string | null;
  deliveryDate?: string | null;
  taxExemptionCategory?: TaxExemptionCategory | null;
  taxExemptionReason?: string | null;
}

function writeLines(db: Database.Database, invoiceId: number, lines: LineInput[]): void {
  const insert = db.prepare(
    `INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit_price_cents, vat_rate)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  lines.forEach((line, i) => {
    insert.run(invoiceId, i + 1, line.description, line.quantity, line.unitPriceCents, line.vatRate);
  });
}

/** Create a draft. Drafts have NO number — numbering happens at finalization. */
export function createDraft(db: Database.Database, input: DraftInput): number {
  getCustomer(db, input.customerId);
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO invoices (customer_id, status, payment_terms_days, note, created_at,
                               buyer_reference, delivery_date, tax_exemption_category, tax_exemption_reason)
         VALUES (?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.customerId,
        input.paymentTermsDays,
        input.note,
        input.createdAt ?? nowIso(),
        input.buyerReference ?? null,
        input.deliveryDate ?? null,
        input.taxExemptionCategory ?? null,
        input.taxExemptionReason ?? null,
      );
    const invoiceId = Number(info.lastInsertRowid);
    writeLines(db, invoiceId, input.lines);
    return invoiceId;
  })();
}

/** Replace a draft's fields and lines. Sent invoices are immutable → 409. */
export function updateDraft(db: Database.Database, id: number, input: DraftInput): void {
  const invoice = getInvoice(db, id);
  if (invoice.status !== 'draft') {
    throw new DomainError(
      409,
      `Sent invoices are immutable — cancel ${invoice.number} and issue a new invoice instead`,
    );
  }
  getCustomer(db, input.customerId);
  db.transaction(() => {
    db.prepare(
      `UPDATE invoices SET customer_id = ?, payment_terms_days = ?, note = ?, buyer_reference = ?,
         delivery_date = ?, tax_exemption_category = ?, tax_exemption_reason = ? WHERE id = ?`,
    ).run(
      input.customerId,
      input.paymentTermsDays,
      input.note,
      input.buyerReference ?? null,
      input.deliveryDate ?? null,
      input.taxExemptionCategory ?? null,
      input.taxExemptionReason ?? null,
      id,
    );
    db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(id);
    writeLines(db, id, input.lines);
  })();
}

/** Drafts can be deleted (they have no number, so no gap). Anything else → 409. */
export function deleteDraft(db: Database.Database, id: number): void {
  const invoice = getInvoice(db, id);
  if (invoice.status !== 'draft') {
    throw new DomainError(
      409,
      `Only drafts can be deleted — ${invoice.number} keeps its number (cancel it instead)`,
    );
  }
  db.prepare('DELETE FROM invoices WHERE id = ?').run(id);
}

/**
 * Finalize ("send") a draft: assign the next gapless sequential number
 * for the issue year and flip to `sent` — atomically, in ONE transaction.
 * The per-year counter row is the single source of numbers; because the
 * read-increment-assign happens inside a SQLite transaction (and
 * better-sqlite3 serializes writes), two finalizations can never draw
 * the same number and no number is ever skipped.
 */
export function finalizeInvoice(
  db: Database.Database,
  id: number,
  issueDate?: string,
  numberOverride?: string,
  /**
   * Freezes the seller and the buyer into the invoice in the same transaction
   * that numbers it (server/einvoice-data.ts). Optional so tests that only care
   * about numbering can leave it out; the API always passes it.
   */
  freeze?: (invoiceId: number) => void,
): { number: string; issue_date: string; due_date: string } {
  const invoice = getInvoice(db, id);
  if (invoice.status !== 'draft') {
    throw new DomainError(409, `Only drafts can be finalized (status: ${invoice.status})`);
  }
  const lineCount = db
    .prepare('SELECT COUNT(*) AS c FROM invoice_lines WHERE invoice_id = ?')
    .get(id) as { c: number };
  if (lineCount.c === 0) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'lines', message: 'An invoice needs at least one line item before it can be sent' },
    ]);
  }

  const issue = issueDate ?? todayIso();
  const year = Number(issue.slice(0, 4));
  const due = addDays(issue, invoice.payment_terms_days);

  return db.transaction(() => {
    // A caller-supplied number (e.g. from PS-10 Number) wins; otherwise the
    // local gapless per-year counter assigns it.
    let number: string;
    if (numberOverride) {
      number = numberOverride;
    } else {
      const counter = db
        .prepare(
          `INSERT INTO invoice_counters (year, last_seq) VALUES (?, 1)
           ON CONFLICT (year) DO UPDATE SET last_seq = last_seq + 1
           RETURNING last_seq`,
        )
        .get(year) as { last_seq: number };
      number = `INV-${year}-${String(counter.last_seq).padStart(4, '0')}`;
    }
    db.prepare(
      "UPDATE invoices SET number = ?, status = 'sent', issue_date = ?, due_date = ? WHERE id = ?",
    ).run(number, issue, due, id);
    freeze?.(id);
    return { number, issue_date: issue, due_date: due };
  })();
}

/**
 * Cancel a sent invoice. The number is kept forever — a cancellation is
 * a status plus an audit trail (timestamp + reason), never a deletion.
 * Corrections happen by issuing a new invoice.
 */
export function cancelInvoice(
  db: Database.Database,
  id: number,
  reason: string,
  cancelledAt?: string,
): void {
  const invoice = getInvoice(db, id);
  if (invoice.status === 'draft') {
    throw new DomainError(409, 'Drafts have no number to keep — delete the draft instead');
  }
  if (invoice.status === 'cancelled') {
    throw new DomainError(409, `${invoice.number} is already cancelled`);
  }
  // A cancellation reverses the whole invoice; on top of a credit note it
  // would take the credited part back twice.
  const notes = creditNotesOf(db, id);
  if (notes.length > 0) {
    throw new DomainError(
      409,
      `${invoice.number} is partly credited (${notes.map((n) => n.number).join(', ')}) — credit the rest with another credit note instead of cancelling`,
    );
  }
  db.prepare(
    "UPDATE invoices SET status = 'cancelled', cancelled_at = ?, cancellation_reason = ? WHERE id = ?",
  ).run(cancelledAt ?? nowIso(), reason, id);
}

export interface PaymentInput {
  date: string;
  amountCents: number;
  note: string | null;
  createdAt?: string;
  /**
   * A bank booking's identity, when this payment came from one.
   *
   * Null for a payment typed in by hand — which is every payment in a
   * standalone deployment. When set, the UNIQUE index makes recording the
   * same arrival twice impossible rather than merely unlikely.
   */
  externalRef?: string | null;
}

/**
 * Record a payment against a sent invoice. The overpayment check and the
 * insert share one transaction, so the sum of payments can never exceed
 * the (derived) gross total.
 */
export function recordPayment(db: Database.Database, id: number, input: PaymentInput): number {
  const invoice = getInvoice(db, id);
  if (invoice.status === 'draft') {
    throw new DomainError(409, 'Drafts cannot receive payments — send the invoice first');
  }
  if (invoice.status === 'cancelled') {
    throw new DomainError(409, `${invoice.number} is cancelled and cannot receive payments`);
  }

  return db.transaction(() => {
    const gross = owedCents(computeTotals(invoiceLines(db, id)).gross_cents, creditedCents(db, id));
    const open = gross - paidCents(db, id);
    if (input.amountCents > open) {
      throw new DomainError(422, 'Validation failed', [
        {
          field: 'amount_cents',
          message: `Payment exceeds the open amount (${open} cents open of ${gross} owed)`,
        },
      ]);
    }
    const info = db
      .prepare(
        'INSERT INTO payments (invoice_id, date, amount_cents, note, created_at, external_ref) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(id, input.date, input.amountCents, input.note, input.createdAt ?? nowIso(), input.externalRef ?? null);
    return Number(info.lastInsertRowid);
  })();
}

/**
 * Customer statement: invoices, cancellations, credit notes and payments in
 * chronological order with a running balance. The final balance always
 * equals total invoiced (finalized, non-cancelled) minus credited minus paid —
 * the test suite proves it.
 */
export function customerLedger(db: Database.Database, customerId: number): Ledger {
  const customer = getCustomer(db, customerId);
  const invoices = db
    .prepare("SELECT * FROM invoices WHERE customer_id = ? AND status != 'draft'")
    .all(customerId) as InvoiceStoredRow[];

  const entries: (Omit<LedgerEntry, 'balance_cents'> & { seq: number })[] = [];
  let seq = 0;
  let invoiced = 0;
  let credited = 0;
  let paid = 0;

  for (const invoice of invoices) {
    const gross = computeTotals(invoiceLines(db, invoice.id)).gross_cents;
    entries.push({
      date: invoice.issue_date!,
      type: 'invoice',
      invoice_id: invoice.id,
      number: invoice.number!,
      amount_cents: gross,
      seq: seq++,
    });
    if (invoice.status === 'cancelled') {
      entries.push({
        date: invoice.cancelled_at!.slice(0, 10),
        type: 'cancellation',
        invoice_id: invoice.id,
        number: invoice.number!,
        amount_cents: -gross,
        seq: seq++,
      });
    } else {
      invoiced += gross;
    }
    for (const note of creditNotesOf(db, invoice.id)) {
      entries.push({
        date: note.issue_date,
        type: 'credit_note',
        invoice_id: invoice.id,
        number: note.number,
        amount_cents: -note.gross_cents,
        seq: seq++,
      });
      credited += note.gross_cents;
    }
    const payments = db
      .prepare('SELECT * FROM payments WHERE invoice_id = ? ORDER BY date, id')
      .all(invoice.id) as Payment[];
    for (const payment of payments) {
      entries.push({
        date: payment.date,
        type: 'payment',
        invoice_id: invoice.id,
        number: invoice.number!,
        amount_cents: -payment.amount_cents,
        seq: seq++,
      });
      paid += payment.amount_cents;
    }
  }

  entries.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.seq - b.seq));

  let balance = 0;
  const withBalance: LedgerEntry[] = entries.map(({ seq: _seq, ...entry }) => {
    balance += entry.amount_cents;
    return { ...entry, balance_cents: balance };
  });

  return {
    customer,
    entries: withBalance,
    invoiced_cents: invoiced,
    credited_cents: credited,
    paid_cents: paid,
    balance_cents: invoiced - credited - paid,
  };
}
