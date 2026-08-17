import type Database from 'better-sqlite3';
import { DomainError } from './domain.js';
import { dealRow } from './deals.js';
import { TRANSFER_VERSION, transferTotals, type DocumentTransfer } from '../shared/transfer.js';

export const MODULE_ID = 'mod-10-crm-lite';

/** Euro-only today; the transfer states it rather than leaving it implied. */
const CURRENCY = 'EUR';

/**
 * A CRM has no VAT concept and must not acquire one here.
 *
 * A deal's value is what a salesperson thinks the work is worth. Whether that
 * figure attracts 20 %, 10 % or nothing at all depends on what is being sold
 * and to whom — a judgement the quoting module owns, with a rate on every line
 * and an operator looking at it. Exporting `0` says "this module did not
 * decide", which the importer can act on; exporting a guessed rate would say
 * "this module decided, and here is the number", which it did not and is not.
 */
const NO_VAT_OPINION = 0;

export interface ExportContext {
  /** PS-11 party id for the deal's company, when the master service is wired. */
  partyId?: number | null;
}

interface CompanyRow {
  id: number;
  name: string;
  domain: string | null;
  party_id: number | null;
}

interface ContactRow {
  name: string;
  email: string | null;
}

/**
 * Render an OPEN deal as a neutral document transfer, so another module can
 * quote it.
 *
 * Only deals still in play can be exported. A won deal has already been quoted
 * — that is generally how it was won — and re-quoting it would produce a second
 * offer for work already sold; a lost deal is one the customer said no to, and
 * sending them a quote for it is worse than useless. Both are refused with the
 * stage in the message, the same posture MOD-13 takes about billing an offer
 * that was never accepted.
 *
 * Everything MOD-10-specific stays here: the caller gets identity, a value and
 * a note, and nothing about stages, probabilities or how deals are stored.
 */
export function dealTransfer(db: Database.Database, dealId: number, ctx: ExportContext = {}): DocumentTransfer {
  const deal = dealRow(db, dealId);
  if (deal.terminal) {
    throw new DomainError(
      409,
      `Only a deal still in play can be quoted — this one is ${deal.stage_label.toLowerCase()}`,
    );
  }
  if (deal.value_cents <= 0) {
    // A transfer must carry at least one line with a positive quantity and a
    // real amount (`validateTransfer`). A deal with no value yet is not a
    // failure of this module — it is a deal nobody has priced — so it is
    // refused here with a message that says what to do about it.
    throw new DomainError(422, 'This deal has no value yet — set one before quoting it');
  }

  const company = db.prepare('SELECT id, name, domain, party_id FROM companies WHERE id = ?').get(deal.company_id) as
    | CompanyRow
    | undefined;
  if (!company) throw new DomainError(404, 'Deal company not found');

  const contact =
    deal.primary_contact_id === null
      ? undefined
      : (db.prepare('SELECT name, email FROM contacts WHERE id = ?').get(deal.primary_contact_id) as
          | ContactRow
          | undefined);

  const lines = [
    {
      // The deal's own title, because that is the sentence the salesperson
      // already agreed with the customer. Whoever edits the quote will rewrite
      // it into line items; this is the starting point, not the finished thing.
      description: deal.title,
      quantity: 1,
      unit_price_cents: deal.value_cents,
      discount_percent: 0,
      vat_rate: NO_VAT_OPINION,
      net_cents: deal.value_cents,
    },
  ];

  return {
    transfer_version: TRANSFER_VERSION,
    origin: {
      kind: 'deal',
      module: MODULE_ID,
      // Deals have no number of their own, so the reference is derived from the
      // id, which is stable for as long as the deal exists and is never reused.
      reference: `DEAL-${deal.id}`,
      issued_at: deal.created_at,
      // A deal is by definition not agreed to. Stating the null is the point:
      // an importer that bills only accepted things has its answer here.
      accepted_at: null,
    },
    currency: CURRENCY,
    customer: {
      name: company.name,
      contact_person: contact?.name ?? null,
      email: contact?.email ?? null,
      // A CRM records who to call, not who to invoice. Both are genuinely
      // unknown here rather than merely absent, and a quoting module will ask.
      vat_id: null,
      address_lines: [],
      party_id: ctx.partyId ?? company.party_id ?? null,
      source: MODULE_ID,
      external_id: String(company.id),
    },
    lines,
    totals: transferTotals(lines),
    note: deal.note,
  };
}
