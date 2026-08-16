import type { EInvoiceInput, EInvoiceParty } from '@0815software/platform-clients';
import { computeTotals } from '../shared/money.js';
import { REASON_REQUIRED_CATEGORIES } from '../shared/types.js';
import type { Customer, InvoiceDetail } from '../shared/types.js';
import type { SellerConfig } from './config.js';

/**
 * Mapping an invoice this module already issued onto the EN 16931 contract.
 *
 * All of the standard's judgement lives in PS-12; this file only translates.
 * The one thing it does decide is when translation is IMPOSSIBLE, and it says
 * so rather than filling a gap with something plausible:
 *
 * - **A country code cannot be guessed from an address line.** EN 16931 makes
 *   it mandatory (BT-40 seller, BT-55 buyer) and this module stores addresses
 *   as free text. PS-11 holds the structured form; without it there is no
 *   honest answer, and an invented one produces a document the recipient's
 *   system rejects weeks later.
 * - **A 0 % line's meaning cannot be guessed either.** Zero-rated, exempt,
 *   reverse charge, intra-community, export and out-of-scope all show 0 %, and
 *   all but zero-rated legally require a stated reason.
 *
 * Both come back as a list of what is missing, naming the field and the line,
 * so an operator can fix it while the invoice is still a draft.
 */

/** The structured address EN 16931 needs, as PS-11 holds it. */
export interface StructuredAddress {
  street?: string | null;
  postcode?: string | null;
  city?: string | null;
  country_code?: string | null;
}

export interface MappingInput {
  invoice: InvoiceDetail;
  customer: Customer;
  seller: SellerConfig;
  /** The seller's structured address — PS-11's `self` party. */
  sellerAddress: StructuredAddress | null;
  /** The buyer's structured address — the PS-11 party this customer maps to. */
  buyerAddress: StructuredAddress | null;
  /** The Leitweg-ID a German public recipient routes on, when there is one. */
  buyerReference?: string | null;
}

export interface MappingGap {
  field: string;
  message: string;
}

export type MappingResult =
  | { ok: true; invoice: EInvoiceInput }
  | { ok: false; gaps: MappingGap[] };

function party(
  name: string,
  vatId: string | null,
  email: string | null,
  address: StructuredAddress | null,
): EInvoiceParty {
  return {
    name,
    vat_id: vatId,
    email,
    address: {
      street: address?.street ?? null,
      postcode: address?.postcode ?? null,
      city: address?.city ?? null,
      country_code: address?.country_code ?? null,
    },
  };
}

/**
 * Translate an invoice, or report exactly why it cannot be translated.
 *
 * Only ever called for a `sent` invoice: a draft has no number and no issue
 * date, and an e-invoice for a document that does not legally exist yet is not
 * a thing worth being able to produce.
 */
export function toEInvoice(input: MappingInput): MappingResult {
  const { invoice, customer, seller } = input;
  const gaps: MappingGap[] = [];

  if (invoice.number === null || invoice.issue_date === null) {
    return {
      ok: false,
      gaps: [
        {
          field: 'status',
          message: 'only a sent invoice can be issued as an e-invoice — a draft has no number and no issue date',
        },
      ],
    };
  }

  if (!input.sellerAddress?.country_code) {
    gaps.push({
      field: 'seller.country_code',
      message:
        'the seller has no country code (BT-40). It is mandatory and cannot be read out of an address line — set it on the `self` party in PS-11 Customers.',
    });
  }
  if (!input.buyerAddress?.country_code) {
    gaps.push({
      field: 'buyer.country_code',
      message: `the customer "${customer.name}" has no country code (BT-55). It is mandatory and cannot be read out of an address line — set it on their party in PS-11 Customers.`,
    });
  }

  for (const line of invoice.lines) {
    if (line.vat_category === null) {
      gaps.push({
        field: `lines[${line.position}].vat_category`,
        message: `line ${line.position} is at 0 % but does not say why. Zero-rated, exempt, reverse charge, intra-community, export and out-of-scope all show 0 % and mean different things — set vat_category.`,
      });
      continue;
    }
    if (REASON_REQUIRED_CATEGORIES.includes(line.vat_category) && !line.vat_exemption_reason?.trim()) {
      gaps.push({
        field: `lines[${line.position}].vat_exemption_reason`,
        message: `line ${line.position} is category ${line.vat_category}, which legally requires a stated reason why no VAT is charged.`,
      });
    }
  }

  if (gaps.length > 0) return { ok: false, gaps };

  // Totals come from the SAME shared function the API, the editor preview and
  // the PDF use, so the structured document cannot disagree with the paper one.
  // PS-12 checks the arithmetic again on its side and refuses if it ever does.
  const totals = computeTotals(invoice.lines);

  // The VAT breakdown, one row per (category, rate). `computeTotals` groups by
  // rate alone, which is right for money and not enough here: two 0 % lines can
  // be different categories and must be different rows.
  const byKey = new Map<string, { category: string; rate: number; base: number; reason: string | null }>();
  for (const line of invoice.lines) {
    const key = `${line.vat_category}|${line.vat_rate}`;
    const existing = byKey.get(key);
    // `net_cents` is what `lineNetCents` already derived — the same number the
    // API returned and the PDF printed. Recomputing it here would be a second
    // place for it to round differently.
    if (existing) existing.base += line.net_cents;
    else {
      byKey.set(key, {
        category: line.vat_category!,
        rate: line.vat_rate,
        base: line.net_cents,
        reason: line.vat_exemption_reason?.trim() || null,
      });
    }
  }

  const vatBreakdown = [...byKey.values()]
    .sort((a, b) => a.rate - b.rate || a.category.localeCompare(b.category))
    .map((row) => ({
      category: row.category as EInvoiceInput['vat_breakdown'][number]['category'],
      rate: row.rate,
      base_cents: row.base,
      vat_cents: Math.round((row.base * row.rate) / 100),
      exemption_reason: row.reason,
    }));

  return {
    ok: true,
    invoice: {
      number: invoice.number,
      issue_date: invoice.issue_date,
      due_date: invoice.due_date,
      document_type: '380',
      currency: 'EUR',
      note: invoice.note,
      buyer_reference: input.buyerReference ?? null,
      seller: party(seller.name, seller.vatId || null, null, input.sellerAddress),
      buyer: party(customer.name, customer.vat_id, customer.email, input.buyerAddress),
      lines: invoice.lines.map((line) => ({
        id: String(line.position),
        name: line.description,
        quantity: line.quantity,
        unit_code: 'C62',
        unit_price_cents: line.unit_price_cents,
        vat_category: line.vat_category as EInvoiceInput['lines'][number]['vat_category'],
        vat_rate: line.vat_rate,
        net_cents: line.net_cents,
      })),
      vat_breakdown: vatBreakdown,
      net_cents: totals.net_cents,
      vat_total_cents: totals.vat_cents,
      gross_cents: totals.gross_cents,
      paid_cents: invoice.paid_cents,
      payment: seller.iban ? { iban: seller.iban, bic: seller.bic || null, reference: invoice.number } : null,
    },
  };
}
