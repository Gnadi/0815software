import type Database from 'better-sqlite3';
import { matchBookings, type BankBooking, type MatchResult, type OpenInvoice } from '../shared/matching.js';
import { DomainError, invoiceDetail, recordPayment } from './invoices.js';

/**
 * Incoming payments: what the bank received, against what is still owed.
 *
 * ## The standalone posture, stated once
 *
 * **Nothing here is required to record a payment.** `POST
 * /api/invoices/:id/payments` works exactly as it always has, a human types the
 * amount, and a deployment with no `BANKING_URL` never touches this file. What
 * this adds is the typing removed: the same payments, proposed from what the
 * bank actually received.
 *
 * The matching rules themselves are in `shared/matching.ts` and import nothing
 * — they work on bookings from any source. This file is only the part that
 * needs a database: which invoices are open, which bookings were already used,
 * and writing a confirmed payment.
 *
 * ## Nothing is recorded without a human
 *
 * `suggest` proposes; `apply` records what a person confirmed. There is
 * deliberately no route that does both. A payment recorded against the wrong
 * invoice is two wrong balances and a customer chased for money they already
 * paid — and the bank is only certain about the money, never about which
 * invoice it settles.
 */

/** Every invoice with money still open, in the shape the matcher wants. */
export function openInvoices(db: Database.Database): OpenInvoice[] {
  const rows = db
    .prepare(
      `SELECT i.id, i.number, i.customer_id, i.issue_date, i.due_date, c.name AS customer_name
         FROM invoices i JOIN customers c ON c.id = i.customer_id
        WHERE i.status = 'sent'
        ORDER BY i.issue_date, i.id`,
    )
    .all() as {
    id: number;
    number: string;
    customer_id: number;
    issue_date: string | null;
    due_date: string | null;
    customer_name: string;
  }[];

  const open: OpenInvoice[] = [];
  for (const row of rows) {
    // Through `invoiceDetail` rather than recomputing: it is where "what is
    // still open" is defined, and a second implementation of that arithmetic
    // is a second place for it to drift.
    //
    // Cancelled and draft invoices are excluded by the query above; a sent one
    // that is fully paid is excluded here, because it can absorb nothing.
    const detail = invoiceDetail(db, row.id);
    if (detail.open_cents <= 0) continue;
    open.push({
      id: row.id,
      number: row.number,
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      open_cents: detail.open_cents,
      issue_date: row.issue_date,
      due_date: row.due_date,
    });
  }
  return open;
}

/** The bookings already turned into payments — the replay guard's memory. */
export function appliedBookingKeys(db: Database.Database): Set<string> {
  const rows = db
    .prepare('SELECT external_ref FROM payments WHERE external_ref IS NOT NULL')
    .all() as { external_ref: string }[];
  return new Set(rows.map((r) => r.external_ref));
}

/** Match a set of bookings against what is open. Records nothing. */
export function suggest(db: Database.Database, bookings: BankBooking[]): MatchResult {
  return matchBookings(bookings, openInvoices(db), appliedBookingKeys(db));
}

export interface Application {
  /** The booking's identity — see `bookingKey`. */
  bookingKey: string;
  invoiceId: number;
  amountCents: number;
  date: string;
  note: string | null;
}

export interface ApplicationOutcome {
  bookingKey: string;
  invoiceId: number;
  /** `recorded`, or why it was not. */
  status: 'recorded' | 'already_applied' | 'refused';
  message?: string;
}

/**
 * Record what a human confirmed.
 *
 * Each application is independent: one refusal does not abandon the rest, and
 * every outcome is reported. An operator confirming twenty proposals wants the
 * nineteen that worked, plus a straight answer about the twentieth — not a
 * transaction rolled back because one invoice was cancelled meanwhile.
 *
 * The replay guard is the UNIQUE index on `payments.external_ref`, not a check
 * here: two operators pressing confirm at the same moment is exactly the case
 * a read-then-write check misses.
 */
export function apply(
  db: Database.Database,
  applications: Application[],
  now?: () => string,
): ApplicationOutcome[] {
  const outcomes: ApplicationOutcome[] = [];
  // Read once for the LABEL. The index below is what actually guarantees it —
  // this only means a second confirmation reads as "already applied" rather
  // than colliding with the overpayment check and reading as "refused".
  const already = appliedBookingKeys(db);
  for (const application of applications) {
    if (already.has(application.bookingKey)) {
      outcomes.push({
        bookingKey: application.bookingKey,
        invoiceId: application.invoiceId,
        status: 'already_applied',
      });
      continue;
    }
    try {
      recordPayment(db, application.invoiceId, {
        date: application.date,
        amountCents: application.amountCents,
        note: application.note,
        externalRef: application.bookingKey,
        ...(now === undefined ? {} : { createdAt: now() }),
      });
      already.add(application.bookingKey);
      outcomes.push({ bookingKey: application.bookingKey, invoiceId: application.invoiceId, status: 'recorded' });
    } catch (err) {
      // The unique index fires as a SqliteError, not a DomainError — this is
      // the same arrival being confirmed twice, which is a no-op and not a
      // failure worth shouting about.
      if (err instanceof Error && /UNIQUE constraint failed: payments\.external_ref/.test(err.message)) {
        outcomes.push({
          bookingKey: application.bookingKey,
          invoiceId: application.invoiceId,
          status: 'already_applied',
        });
        continue;
      }
      if (err instanceof DomainError) {
        // The useful sentence is in `details` — `message` is "Validation
        // failed", which tells an operator nothing about which one failed.
        outcomes.push({
          bookingKey: application.bookingKey,
          invoiceId: application.invoiceId,
          status: 'refused',
          message: err.details[0]?.message ?? err.message,
        });
        continue;
      }
      throw err;
    }
  }
  return outcomes;
}
