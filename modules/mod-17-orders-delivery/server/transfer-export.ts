import type Database from 'better-sqlite3';
import { TRANSFER_VERSION, transferLineNet, transferTotals, type DocumentTransfer, type TransferLine } from '../shared/transfer.js';
import { customerIdentity, deliveryNoteByNumber, orderDetail } from './orders.js';

export const MODULE_ID = 'mod-17-orders-delivery';

/**
 * A delivery note as a neutral document transfer (shared/transfer.ts), kind
 * `delivery`: what was delivered, at the order's prices — the lines a billing
 * module turns into an invoice for exactly this delivery.
 *
 * The reference is the delivery note number, so each delivery is billed once
 * however often it is fetched, and an order delivered in three parts becomes
 * three invoices. The customer travels with the identity it came with (PS-11
 * party id, the offer module's own reference), so every hop resolves the
 * same party rather than creating a lookalike.
 */
export function deliveryTransfer(db: Database.Database, number: string): DocumentTransfer {
  const note = deliveryNoteByNumber(db, number);
  const order = orderDetail(db, note.order_id);
  const identity = customerIdentity(db, note.order_id);
  const lines: TransferLine[] = note.lines.map((delivered) => {
    const line = order.lines.find((l) => l.id === delivered.order_line_id)!;
    const out = {
      description: line.description,
      quantity: delivered.quantity,
      unit_price_cents: line.unit_price_cents,
      discount_percent: line.discount_percent,
      vat_rate: line.vat_rate,
    };
    return { ...out, net_cents: transferLineNet(out) };
  });
  const ref = order.customer_reference ? ` · Ihre Bestellung ${order.customer_reference}` : '';
  return {
    transfer_version: TRANSFER_VERSION,
    origin: {
      kind: 'delivery',
      module: MODULE_ID,
      reference: note.number,
      issued_at: note.delivered_on,
      accepted_at: identity.accepted_at ?? order.order_date,
    },
    currency: 'EUR',
    customer: {
      name: order.customer.name,
      contact_person: order.customer.contact_person,
      email: order.customer.email,
      vat_id: order.customer.vat_id,
      address_lines: order.customer.address_lines,
      party_id: identity.party_id,
      source: identity.source ?? MODULE_ID,
      external_id: identity.external_id ?? order.number,
    },
    lines,
    totals: transferTotals(lines),
    note: `Lieferschein ${note.number} vom ${note.delivered_on} zu Auftrag ${order.number}${ref}`,
  };
}
