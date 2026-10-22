import type Database from 'better-sqlite3';
import { validateTransfer, type DocumentTransfer } from '../shared/transfer.js';
import { createOrder, DomainError, todayIso } from './orders.js';

export interface OfferImport {
  orderId: number;
  /** True when this offer had already become an order — nothing new was written. */
  replayed: boolean;
}

/**
 * Turn an ACCEPTED offer (a document transfer from MOD-13) into an order.
 *
 * Only `offer` transfers: a deal is nobody's agreement, and a delivery is
 * already past the order. The lines and totals must check out exactly
 * (`validateTransfer`), and they are taken over as they are — the order says
 * what the customer accepted, cent for cent. Idempotent on the offer: an offer
 * becomes at most one order, so a retried import returns the same one.
 */
export function importOffer(db: Database.Database, value: unknown, actor: string, today = todayIso()): OfferImport {
  const problems = validateTransfer(value);
  if (problems.length > 0) {
    throw new DomainError(422, 'The transferred offer is not valid', problems);
  }
  const transfer = value as DocumentTransfer;
  if (transfer.origin.kind !== 'offer') {
    throw new DomainError(
      422,
      `Only an accepted offer becomes an order — ${transfer.origin.reference} is a ${transfer.origin.kind}`,
    );
  }
  if (transfer.currency !== 'EUR') throw new DomainError(422, `Only EUR orders are kept today, got ${transfer.currency}`);

  const sourceReference = `${transfer.origin.module}:${transfer.origin.reference.trim()}`;
  const existing = db.prepare('SELECT id FROM orders WHERE source_reference = ?').get(sourceReference) as { id: number } | undefined;
  if (existing) return { orderId: existing.id, replayed: true };

  const c = transfer.customer;
  const orderId = createOrder(
    db,
    {
      orderDate: transfer.origin.accepted_at?.slice(0, 10) ?? today,
      customer: {
        name: c.name,
        contactPerson: c.contact_person,
        email: c.email,
        vatId: c.vat_id,
        addressLines: c.address_lines,
        partyId: c.party_id,
        source: c.source,
        externalId: c.external_id,
      },
      customerReference: null,
      note: transfer.note,
      lines: transfer.lines.map((l) => ({
        description: l.description,
        quantity: l.quantity,
        unitPriceCents: l.unit_price_cents,
        discountPercent: l.discount_percent,
        vatRate: l.vat_rate,
      })),
      sourceReference,
      sourceAcceptedAt: transfer.origin.accepted_at,
    },
    actor,
  );
  return { orderId, replayed: false };
}
