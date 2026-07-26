import type Database from 'better-sqlite3';
import { DomainError, offerDetail } from './offers.js';
import { TRANSFER_VERSION, transferTotals, type DocumentTransfer } from '../shared/transfer.js';

export const MODULE_ID = 'mod-13-offers';

/** Euro-only today; the transfer states it rather than leaving it implied. */
const CURRENCY = 'EUR';

export interface ExportContext {
  today?: string;
  /** PS-11 party id for the offer's customer, when the master service is wired. */
  partyId?: number | null;
}

/**
 * Render an ACCEPTED offer as a neutral document transfer.
 *
 * Only accepted offers can be exported: billing a quote the customer has not
 * agreed to is exactly the mistake this endpoint must not enable. A draft, a
 * merely sent offer, a rejected or withdrawn one, and an offer that has been
 * superseded by a revision are all refused, with the status in the message.
 *
 * Everything MOD-13-specific stays here: the caller gets identity, line items,
 * VAT and totals, and nothing about how offers are stored.
 */
export function offerTransfer(db: Database.Database, offerNumber: string, ctx: ExportContext = {}): DocumentTransfer {
  const row = db.prepare('SELECT id FROM offers WHERE number = ?').get(offerNumber) as { id: number } | undefined;
  if (!row) throw new DomainError(404, 'Offer not found');

  const offer = offerDetail(db, row.id, { today: ctx.today });
  if (offer.status !== 'accepted') {
    throw new DomainError(409, `Only an accepted offer can be billed — this one is ${offer.status}`);
  }

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(offer.customer_id) as
    | {
        id: number;
        name: string;
        contact_person: string | null;
        email: string | null;
        vat_id: string | null;
        address: string | null;
      }
    | undefined;
  if (!customer) throw new DomainError(404, 'Offer customer not found');

  const acceptedAt = offer.events.find((event) => event.event === 'accepted')?.created_at ?? null;

  const lines = offer.lines.map((line) => ({
    description: line.description,
    quantity: line.quantity,
    unit_price_cents: line.unit_price_cents,
    discount_percent: line.discount_percent,
    vat_rate: line.vat_rate,
    // offerDetail already derives this with the module's own money rules; the
    // transfer carries it so the importer never has to reproduce them.
    net_cents: line.net_cents,
  }));

  return {
    transfer_version: TRANSFER_VERSION,
    origin: {
      kind: 'offer',
      module: MODULE_ID,
      reference: offer.number ?? offerNumber,
      issued_at: offer.sent_at,
      accepted_at: acceptedAt,
    },
    currency: CURRENCY,
    customer: {
      name: customer.name,
      contact_person: customer.contact_person,
      email: customer.email,
      vat_id: customer.vat_id,
      address_lines: (customer.address ?? '')
        .split(/\r?\n|,\s*/)
        .map((line) => line.trim())
        .filter((line) => line !== ''),
      party_id: ctx.partyId ?? null,
      source: MODULE_ID,
      external_id: String(customer.id),
    },
    lines,
    totals: transferTotals(lines),
    note: offer.intro,
  };
}
