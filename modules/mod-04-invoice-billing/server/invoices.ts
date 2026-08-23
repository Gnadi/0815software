import type Database from 'better-sqlite3';
import { computeTotals, lineNetCents } from '../shared/money.js';
import type {
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
}

function getInvoice(db: Database.Database, id: number): InvoiceStoredRow {
  return requireRow(
    db.prepare('SELECT * FROM invoices WHERE id = ?').get(id) as InvoiceStoredRow | undefined,
    'Invoice',
  );
}

function invoiceLines(db: Database.Database, invoiceId: number): InvoiceLine[] {
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

function paymentStatusOf(grossCents: number, paid: number): PaymentStatus {
  if (paid <= 0) return 'unpaid';
  return paid >= grossCents ? 'paid' : 'partially_paid';
}

/** Derived lifecycle status: "paid" is a sent invoice fully covered by payments. */
function derivedStatus(stored: StoredStatus, grossCents: number, paid: number): InvoiceStatus {
  if (stored === 'sent' && grossCents > 0 && paid >= grossCents) return 'paid';
  return stored;
}

function isOverdue(status: InvoiceStatus, dueDate: string | null, today: string): boolean {
  return status === 'sent' && dueDate !== null && dueDate < today;
}

function toRow(
  db: Database.Database,
  invoice: InvoiceStoredRow,
  today: string,
): { row: InvoiceRow; lines: InvoiceLine[] } {
  const lines = invoiceLines(db, invoice.id);
  const totals = computeTotals(lines);
  const paid = paidCents(db, invoice.id);
  const status = derivedStatus(invoice.status, totals.gross_cents, paid);
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
      payment_status: paymentStatusOf(totals.gross_cents, paid),
      issue_date: invoice.issue_date,
      due_date: invoice.due_date,
      overdue: isOverdue(status, invoice.due_date, today),
      net_cents: totals.net_cents,
      vat_cents: totals.vat_cents,
      gross_cents: totals.gross_cents,
      paid_cents: paid,
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
    cancelled_at: invoice.cancelled_at,
    cancellation_reason: invoice.cancellation_reason,
    lines,
    vat_breakdown: totals.by_rate,
    payments,
    open_cents:
      invoice.status === 'sent' ? Math.max(0, totals.gross_cents - row.paid_cents) : 0,
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
        `INSERT INTO invoices (customer_id, status, payment_terms_days, note, created_at)
         VALUES (?, 'draft', ?, ?, ?)`,
      )
      .run(input.customerId, input.paymentTermsDays, input.note, input.createdAt ?? nowIso());
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
      'UPDATE invoices SET customer_id = ?, payment_terms_days = ?, note = ? WHERE id = ?',
    ).run(input.customerId, input.paymentTermsDays, input.note, id);
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
    const gross = computeTotals(invoiceLines(db, id)).gross_cents;
    const open = gross - paidCents(db, id);
    if (input.amountCents > open) {
      throw new DomainError(422, 'Validation failed', [
        {
          field: 'amount_cents',
          message: `Payment exceeds the open amount (${open} cents open of ${gross} gross)`,
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
 * Customer statement: invoices, cancellations and payments in
 * chronological order with a running balance. The final balance always
 * equals total invoiced (finalized, non-cancelled) minus total paid —
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
    paid_cents: paid,
    balance_cents: invoiced - paid,
  };
}
