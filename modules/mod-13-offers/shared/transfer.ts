/**
 * THE DOCUMENT TRANSFER SHAPE — the wire contract for handing a completed sales
 * document to whatever bills it.
 *
 * This file is the whole coupling surface between MOD-13 Offers and MOD-04
 * Invoice & Billing, and it is deliberately *neutral*: no MOD-13 ids, no MOD-13
 * statuses, no revision chain, nothing about how offers are stored. An exporter
 * fills it in; an importer consumes it. Both sides keep a copy of this file (the
 * repo's copy-in convention) and the round-trip is covered by tests on both
 * sides.
 *
 * Two rules make it safe to re-point at a different transport later — a PS-11
 * Customers lookup, a queue, a file drop:
 *
 * 1. **The customer is an identity, not a foreign key.** `customer.party_id` is
 *    the PS-11 master id when the exporter resolved one, and the rest of the
 *    fields are enough to resolve or create the party without it. An importer
 *    with PS-11 configured uses the id; one without it matches locally.
 * 2. **Money is exact and self-checking.** Lines carry the source's own
 *    quantity, undiscounted unit net price, line discount and VAT rate, plus
 *    the `net_cents` the source computed for that line, and the document
 *    carries the totals the source computed. An importer recomputes and refuses
 *    the transfer if the numbers disagree, so a rounding difference between two
 *    modules can never become a wrong invoice.
 */

/** Bumped only on a breaking change to the shape. Importers must check it. */
export const TRANSFER_VERSION = 1;

/** The customer, as an identity that can be resolved anywhere. */
export interface TransferParty {
  name: string;
  contact_person: string | null;
  email: string | null;
  /** Normalized by PS-11 when it resolves; sent as typed otherwise. */
  vat_id: string | null;
  address_lines: string[];
  /** PS-11 party id, when the exporter resolves through the master service. */
  party_id: number | null;
  /** The exporting module and its own id for this customer, for traceability. */
  source: string;
  external_id: string;
}

/**
 * One line of the document, at the source's full fidelity. `net_cents` is what
 * the source computed for this line — `round(quantity × unit_price_cents ×
 * (1 − discount_percent/100))` — and is authoritative.
 */
export interface TransferLine {
  description: string;
  quantity: number;
  /** Net unit price in integer cents, BEFORE the line discount. */
  unit_price_cents: number;
  /** Per-line discount percent (0..100). 0 when the source has no discounts. */
  discount_percent: number;
  vat_rate: number;
  net_cents: number;
}

/**
 * What kind of thing the source was handing over.
 *
 * This is the field an importer reads FIRST, because it decides whether the
 * transfer is something that importer may act on at all. The shape is the same
 * either way; what differs is how much the numbers are worth:
 *
 * - `offer` — a document the customer has agreed to. Its lines and totals are
 *   exact and self-checking, and an importer must refuse the transfer rather
 *   than re-round them (`validateTransfer`).
 * - `deal` — a pipeline opportunity. It carries the source's single value
 *   estimate as one line at `vat_rate: 0`, because a CRM has no VAT concept
 *   and inventing one there would put a tax rate in the module least qualified
 *   to choose it. An importer that needs a rate applies its OWN default and
 *   produces something an operator edits before it is issued.
 *
 * The distinction is load-bearing, not decorative: a deal is a guess about
 * money and an offer is a promise about it, so **an importer names the kinds it
 * accepts and refuses the rest**. MOD-04 bills offers and refuses deals; MOD-13
 * quotes deals and refuses offers; MOD-11 plans work from offers only.
 */
export type TransferKind = 'offer' | 'deal';

/** Where the document came from — the idempotency key of an import. */
export interface TransferOrigin {
  kind: TransferKind;
  /** The exporting module's registry id, e.g. "mod-13-offers". */
  module: string;
  /**
   * Stable, human-visible reference — an offer number, or `DEAL-<id>` for a
   * pipeline deal, which has no number of its own. It is the idempotency key of
   * every import, so it must identify the source thing for as long as that
   * thing exists, and never be reused for a different one.
   */
  reference: string;
  /** When the source document was issued, if it has such a date. */
  issued_at: string | null;
  /** When the customer accepted it. Always null for a deal — that is the point. */
  accepted_at: string | null;
}

export interface TransferTotals {
  net_cents: number;
  vat_cents: number;
  gross_cents: number;
}

export interface DocumentTransfer {
  transfer_version: number;
  origin: TransferOrigin;
  /** ISO 4217. The platform is euro-only today; the field makes that explicit. */
  currency: string;
  customer: TransferParty;
  lines: TransferLine[];
  /** Totals as the SOURCE computed them. An importer must verify these. */
  totals: TransferTotals;
  /** Free text the source wants carried over (an offer's intro, say). */
  note: string | null;
}

/** Line net as every side must compute it. Duplicated intentionally: the
 *  transfer contract cannot depend on either module's money module. */
export function transferLineNet(line: {
  quantity: number;
  unit_price_cents: number;
  discount_percent?: number;
}): number {
  return Math.round(line.quantity * line.unit_price_cents * (1 - (line.discount_percent ?? 0) / 100));
}

/** Recompute the totals from the lines, using the source's own line nets. */
export function transferTotals(lines: TransferLine[]): TransferTotals {
  const baseByRate = new Map<number, number>();
  for (const line of lines) {
    baseByRate.set(line.vat_rate, (baseByRate.get(line.vat_rate) ?? 0) + line.net_cents);
  }
  let net = 0;
  let vat = 0;
  for (const [rate, base] of [...baseByRate.entries()].sort((a, b) => a[0] - b[0])) {
    net += base;
    vat += Math.round((base * rate) / 100);
  }
  return { net_cents: net, vat_cents: vat, gross_cents: net + vat };
}

export interface TransferProblem {
  field: string;
  message: string;
}

/**
 * Validate a transfer as an importer must: the version, the shape, and — the
 * part that matters — that the declared totals are exactly what the declared
 * lines add up to. Returns an empty array when the transfer is safe to bill.
 */
export function validateTransfer(value: unknown): TransferProblem[] {
  const problems: TransferProblem[] = [];
  const push = (field: string, message: string): void => void problems.push({ field, message });

  if (value === null || typeof value !== 'object') {
    return [{ field: 'transfer', message: 'must be an object' }];
  }
  const t = value as Partial<DocumentTransfer>;

  if (t.transfer_version !== TRANSFER_VERSION) {
    push('transfer_version', `must be ${TRANSFER_VERSION}, got ${String(t.transfer_version)}`);
    return problems; // nothing below can be trusted across a version break
  }
  if (typeof t.currency !== 'string' || !/^[A-Z]{3}$/.test(t.currency)) {
    push('currency', 'must be a three-letter ISO 4217 code');
  }

  const origin = t.origin;
  if (!origin || typeof origin !== 'object') push('origin', 'is required');
  else {
    // The contract validates that the kind is one it knows. WHICH kinds are
    // acceptable is the importer's call, not the shape's — see TransferKind.
    if (origin.kind !== 'offer' && origin.kind !== 'deal') {
      push('origin.kind', 'must be "offer" or "deal"');
    }
    if (typeof origin.module !== 'string' || origin.module === '') push('origin.module', 'is required');
    if (typeof origin.reference !== 'string' || origin.reference.trim() === '') {
      push('origin.reference', 'is required — it is what makes an import idempotent');
    }
  }

  const customer = t.customer;
  if (!customer || typeof customer !== 'object') push('customer', 'is required');
  else if (typeof customer.name !== 'string' || customer.name.trim() === '') {
    push('customer.name', 'is required');
  }

  if (!Array.isArray(t.lines) || t.lines.length === 0) {
    push('lines', 'must contain at least one line');
  } else {
    t.lines.forEach((line, i) => {
      const at = (field: string): string => `lines[${i}].${field}`;
      if (typeof line?.description !== 'string' || line.description.trim() === '') {
        push(at('description'), 'is required');
      }
      if (typeof line?.quantity !== 'number' || !(line.quantity > 0)) push(at('quantity'), 'must be > 0');
      if (!Number.isInteger(line?.unit_price_cents)) push(at('unit_price_cents'), 'must be integer cents');
      if (!Number.isInteger(line?.net_cents)) push(at('net_cents'), 'must be integer cents');
      if (typeof line?.vat_rate !== 'number' || line.vat_rate < 0 || line.vat_rate > 100) {
        push(at('vat_rate'), 'must be a percentage between 0 and 100');
      }
      const discount = line?.discount_percent ?? 0;
      if (typeof discount !== 'number' || discount < 0 || discount > 100) {
        push(at('discount_percent'), 'must be a percentage between 0 and 100');
      }
      if (
        Number.isInteger(line?.net_cents) &&
        Number.isInteger(line?.unit_price_cents) &&
        typeof line?.quantity === 'number' &&
        line.net_cents !== transferLineNet(line)
      ) {
        push(at('net_cents'), `does not match quantity × unit price × discount (expected ${transferLineNet(line)})`);
      }
    });
  }

  if (!t.totals || typeof t.totals !== 'object') push('totals', 'is required');
  else if (problems.length === 0) {
    const recomputed = transferTotals(t.lines as TransferLine[]);
    for (const key of ['net_cents', 'vat_cents', 'gross_cents'] as const) {
      if (t.totals[key] !== recomputed[key]) {
        push(`totals.${key}`, `declared ${String(t.totals[key])} but the lines add up to ${recomputed[key]}`);
      }
    }
  }

  return problems;
}
