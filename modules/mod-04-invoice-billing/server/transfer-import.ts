import type Database from 'better-sqlite3';
import { createDraft, DomainError, getCustomer, nowIso } from './invoices.js';
import { validateTransfer, type DocumentTransfer, type TransferLine } from '../shared/transfer.js';
import { fmtEur } from '../shared/money.js';

export const MODULE_ID = 'mod-04-invoice-billing';

export interface ImportContext {
  /** PS-11 party id, when the master service resolved one for this customer. */
  partyId?: number | null;
  paymentTermsDays?: number;
  createdAt?: string;
}

export interface ImportResult {
  invoiceId: number;
  customerId: number;
  /** True when an earlier import of the same origin already produced it. */
  replayed: boolean;
}

interface CustomerRow {
  id: number;
  name: string;
  email: string | null;
  vat_id: string | null;
  address: string | null;
  party_id: number | null;
}

/**
 * This module's invoice lines carry no per-line discount, so a discounted
 * transfer line is folded into a single-quantity line at its exact net amount
 * and the arithmetic is spelled out in the description. That keeps the money
 * bit-exact — which is the property both modules advertise — at the cost of
 * some presentation detail, rather than re-rounding and being a cent out.
 */
function toInvoiceLine(line: TransferLine): {
  description: string;
  quantity: number;
  unitPriceCents: number;
  vatRate: number;
} {
  if (line.discount_percent === 0) {
    return {
      description: line.description,
      quantity: line.quantity,
      unitPriceCents: line.unit_price_cents,
      vatRate: line.vat_rate,
    };
  }
  const detail = `${line.quantity} × ${fmtEur(line.unit_price_cents)} − ${line.discount_percent}%`;
  return {
    description: `${line.description} (${detail})`,
    quantity: 1,
    unitPriceCents: line.net_cents,
    vatRate: line.vat_rate,
  };
}

/**
 * Find or create the local customer row for a transfer's party.
 *
 * When PS-11 resolved a party id, that id is the identity — the local row is
 * just this module's handle on it, so a second import of the same party reuses
 * the row no matter what the name says. Without PS-11 the module falls back to
 * its own matching (VAT id, then email, then name), which is the standalone
 * behaviour and is why this works with no platform at all.
 */
export function resolveLocalCustomer(
  db: Database.Database,
  transfer: DocumentTransfer,
  partyId: number | null,
): number {
  const party = transfer.customer;
  const find = (sql: string, ...params: unknown[]): CustomerRow | undefined =>
    db.prepare(`SELECT * FROM customers WHERE ${sql}`).get(...params) as CustomerRow | undefined;

  let existing: CustomerRow | undefined;
  if (partyId !== null) existing = find('party_id = ?', partyId);
  if (!existing && party.vat_id) {
    existing = find('vat_id IS NOT NULL AND vat_id <> \'\' AND UPPER(REPLACE(vat_id, \' \', \'\')) = ?',
      party.vat_id.replace(/\s+/g, '').toUpperCase());
  }
  if (!existing && party.email) existing = find('LOWER(email) = ?', party.email.toLowerCase());
  if (!existing) existing = find('name = ?', party.name);

  const address = party.address_lines.length > 0 ? party.address_lines.join('\n') : null;

  if (existing) {
    // Enrich, never clobber — the same rule PS-11 applies (see its README).
    db.prepare(
      `UPDATE customers SET
         email   = COALESCE(NULLIF(email, ''), ?),
         vat_id  = COALESCE(NULLIF(vat_id, ''), ?),
         address = COALESCE(NULLIF(address, ''), ?),
         party_id = COALESCE(party_id, ?)
       WHERE id = ?`,
    ).run(party.email, party.vat_id, address, partyId, existing.id);
    return existing.id;
  }

  const info = db
    .prepare('INSERT INTO customers (name, email, vat_id, address, party_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(party.name, party.email, party.vat_id, address, partyId, nowIso());
  return Number(info.lastInsertRowid);
}

/**
 * Turn a validated document transfer into a DRAFT invoice.
 *
 * Idempotent on the origin reference: a second import of the same offer returns
 * the invoice the first one produced, so a retried request — or an operator
 * clicking twice — can never double-bill. The origin reference is recorded on
 * the invoice, so the paper trail from quote to invoice is in the data, not in
 * someone's memory.
 */
export function importTransfer(
  db: Database.Database,
  value: unknown,
  ctx: ImportContext = {},
): ImportResult {
  const problems = validateTransfer(value);
  if (problems.length > 0) {
    throw new DomainError(
      422,
      'The transferred document is not billable',
      problems.map((p) => ({ field: p.field, message: p.message })),
    );
  }
  const transfer = value as DocumentTransfer;

  // This module bills DOCUMENTS. The transfer shape can also carry a pipeline
  // deal — MOD-10 exports one so MOD-13 can quote it — and a deal is a guess
  // about money that nobody has agreed to. Its value is one salesperson's
  // estimate at a rate the CRM did not choose, and turning that into an
  // invoice is the single most expensive mistake this endpoint could make.
  //
  // The refusal is explicit rather than implied by a validation failure,
  // because the shape validates perfectly well: only the meaning is wrong, and
  // the operator deserves to be told which.
  if (transfer.origin.kind !== 'offer') {
    throw new DomainError(
      422,
      `Only an accepted offer can be billed — ${transfer.origin.reference} is a ${transfer.origin.kind}.` +
        ' Quote it in MOD-13 first, and bill the offer the customer accepts.',
    );
  }

  if (transfer.currency !== 'EUR') {
    throw new DomainError(422, `Only EUR can be invoiced today, got ${transfer.currency}`);
  }

  const reference = transfer.origin.reference.trim();
  const existing = db
    .prepare('SELECT id, customer_id FROM invoices WHERE origin_offer_number = ?')
    .get(reference) as { id: number; customer_id: number } | undefined;
  if (existing) {
    return { invoiceId: existing.id, customerId: existing.customer_id, replayed: true };
  }

  return db.transaction((): ImportResult => {
    const customerId = resolveLocalCustomer(db, transfer, ctx.partyId ?? transfer.customer.party_id ?? null);
    const invoiceId = createDraft(db, {
      customerId,
      paymentTermsDays: ctx.paymentTermsDays ?? 14,
      note: transfer.note,
      lines: transfer.lines.map(toInvoiceLine),
      createdAt: ctx.createdAt,
    });
    db.prepare('UPDATE invoices SET origin_offer_number = ? WHERE id = ?').run(reference, invoiceId);
    // Re-read through the module's own accessor so a broken write fails loudly
    // here rather than at finalization.
    getCustomer(db, customerId);
    return { invoiceId, customerId, replayed: false };
  })();
}
