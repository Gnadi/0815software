import type Database from 'better-sqlite3';
import { createDraft, DomainError, getCustomer, nowIso } from './offers.js';
import { validateTransfer, type DocumentTransfer, type TransferLine } from '../shared/transfer.js';

export const MODULE_ID = 'mod-13-offers';

/**
 * The VAT rate a line gets when the source expressed no opinion.
 *
 * This is the rate this module's own editor puts on a new line
 * (`src/components/OfferEditor.tsx`, `EMPTY_LINE`), and using the same one is
 * the point: an imported draft starts where a hand-typed one starts, so
 * whoever finishes it is looking at the module's normal default rather than at
 * something a CRM chose. It is a DRAFT — nobody sends it without reading it.
 */
const DEFAULT_VAT_RATE = 20;

/** How long an imported quote is valid, unless someone changes it. */
const DEFAULT_VALID_DAYS = 30;

export interface ImportContext {
  /** PS-11 party id, when the master service resolved one for this customer. */
  partyId?: number | null;
  createdAt?: string;
  /** Today, for deriving the validity date. Injectable so tests are stable. */
  today?: string;
}

export interface ImportResult {
  offerId: number;
  customerId: number;
  /** True when an earlier import of the same origin already produced it. */
  replayed: boolean;
}

interface CustomerRow {
  id: number;
  name: string;
  contact_person: string | null;
  email: string | null;
  vat_id: string | null;
  address: string | null;
  party_id: number | null;
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Turn a transfer line into an offer line.
 *
 * A deal carries `vat_rate: 0`, which is not a rate — it is a CRM saying it has
 * no VAT opinion (see `TransferKind`). This module has one, so it applies it.
 * A line that really is zero-rated is a case an operator sets on the draft; the
 * alternative, an import that silently quoted everything at 0 %, is the one
 * mistake here that reaches a customer as a wrong number.
 */
function toOfferLine(line: TransferLine): {
  description: string;
  quantity: number;
  unitPriceCents: number;
  vatRate: number;
  discountPercent: number;
} {
  return {
    description: line.description,
    quantity: line.quantity,
    unitPriceCents: line.unit_price_cents,
    vatRate: line.vat_rate > 0 ? line.vat_rate : DEFAULT_VAT_RATE,
    discountPercent: line.discount_percent,
  };
}

/**
 * Find or create the local customer row for a transfer's party.
 *
 * The same rules MOD-04's importer follows, for the same reason: when PS-11
 * resolved a party id that id is the identity, and without PS-11 the module
 * falls back to its own matching (VAT id, then email, then name), which is the
 * standalone behaviour and is why this works with no platform at all.
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
    // It matters more in this direction than in MOD-04's: a CRM knows a
    // contact and an email and nothing about VAT ids or invoicing addresses,
    // so an import from one must not blank the fields it has no answer for.
    db.prepare(
      `UPDATE customers SET
         contact_person = COALESCE(NULLIF(contact_person, ''), ?),
         email          = COALESCE(NULLIF(email, ''), ?),
         vat_id         = COALESCE(NULLIF(vat_id, ''), ?),
         address        = COALESCE(NULLIF(address, ''), ?),
         party_id       = COALESCE(party_id, ?)
       WHERE id = ?`,
    ).run(party.contact_person, party.email, party.vat_id, address, partyId, existing.id);
    return existing.id;
  }

  const info = db
    .prepare(
      `INSERT INTO customers (name, contact_person, email, vat_id, address, party_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(party.name, party.contact_person, party.email, party.vat_id, address, partyId, nowIso());
  return Number(info.lastInsertRowid);
}

/**
 * Turn a validated document transfer into a DRAFT offer.
 *
 * This module quotes DEALS. A transfer whose kind is `offer` is refused, and
 * the refusal is not pedantry: importing an offer into the module that owns
 * offers would produce a rival copy of a document that already exists here,
 * with its own number and its own acceptance state. The operation someone
 * actually wants in that case is a REVISION, which this module already has
 * (`reviseOffer`) and which keeps the chain intact.
 *
 * Idempotent on the origin reference: a second import of the same deal returns
 * the draft the first one produced, so a retried request — or an operator
 * clicking twice — can never leave a customer holding two quotes for one job.
 *
 * The result is a DRAFT, always. It has no number, it is not sent, and every
 * figure on it is editable, because what arrived was one value and a title and
 * the person quoting is the one who turns that into a document.
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
      'The transferred document cannot be quoted',
      problems.map((p) => ({ field: p.field, message: p.message })),
    );
  }
  const transfer = value as DocumentTransfer;

  if (transfer.origin.kind !== 'deal') {
    throw new DomainError(
      422,
      `Only a pipeline deal can be quoted here — ${transfer.origin.reference} is a ${transfer.origin.kind}.` +
        ' To change an offer this module already owns, revise it instead.',
    );
  }

  if (transfer.currency !== 'EUR') {
    throw new DomainError(422, `Only EUR can be quoted today, got ${transfer.currency}`);
  }

  const reference = transfer.origin.reference.trim();
  const existing = db
    .prepare('SELECT id, customer_id FROM offers WHERE origin_reference = ?')
    .get(reference) as { id: number; customer_id: number } | undefined;
  if (existing) {
    return { offerId: existing.id, customerId: existing.customer_id, replayed: true };
  }

  const today = ctx.today ?? new Date().toISOString().slice(0, 10);

  return db.transaction((): ImportResult => {
    const customerId = resolveLocalCustomer(db, transfer, ctx.partyId ?? transfer.customer.party_id ?? null);
    const offerId = createDraft(db, {
      customerId,
      // A transfer carries no document title of its own, and for a deal the
      // first line's description IS the deal's title — the sentence the
      // salesperson already agreed with the customer. `validateTransfer`
      // guarantees at least one line with a non-empty description, so this is
      // total rather than merely usually right.
      title: transfer.lines[0]!.description,
      // A draft may have no validity date at all; giving it one saves a step
      // and is trivially editable. Finalization requires one either way.
      validUntil: addDays(today, DEFAULT_VALID_DAYS),
      intro: transfer.note,
      terms: null,
      lines: transfer.lines.map(toOfferLine),
      createdAt: ctx.createdAt,
    });
    db.prepare('UPDATE offers SET origin_reference = ? WHERE id = ?').run(reference, offerId);
    // Re-read through the module's own accessor so a broken write fails loudly
    // here rather than when someone opens the draft.
    getCustomer(db, customerId);
    return { offerId, customerId, replayed: false };
  })();
}
