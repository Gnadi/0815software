/**
 * Money math — THE core correctness property of this module.
 *
 * All amounts are integer cents; euros only ever exist at the rendering
 * edge. This is a consumer-facing shop, so a product's price is the
 * GROSS sticker price (VAT included) — what the customer pays. VAT is
 * extracted per rate from the gross tax base, the Austrian/German B2C
 * convention.
 *
 * Totals are never stored: they are recomputed from the (snapshotted)
 * order lines by this one function, which the server, the client (cart
 * preview) and the tests all share — so the numbers on screen, in the
 * API and in the CSV export cannot disagree or drift.
 *
 * Rounding rules:
 *   - line gross = quantity × unit_price_cents   (integer × integer — exact)
 *   - per rate:  gross base = sum of line grosses at that rate
 *                net        = round(gross base × 100 / (100 + rate))
 *                VAT        = gross base − net
 *                → VAT is computed once per rate on the tax base, not per line
 *   - order:     gross = Σ gross bases, vat = Σ VAT, net = gross − vat
 * round() is half-away-from-zero on non-negative inputs (Math.round).
 */

export const VAT_RATES = [0, 10, 20] as const;
export type VatRate = (typeof VAT_RATES)[number];

export interface LineAmounts {
  quantity: number;
  /** Gross (VAT-inclusive) unit price in cents. */
  unit_price_cents: number;
  vat_rate: number;
}

export interface Totals {
  net_cents: number;
  vat_cents: number;
  gross_cents: number;
  /** Only rates that actually occur, ascending. */
  by_rate: { rate: number; gross_cents: number; net_cents: number; vat_cents: number }[];
}

/** Gross amount of a single line in cents. Quantities are integers, so this is exact. */
export function lineGrossCents(line: LineAmounts): number {
  return line.quantity * line.unit_price_cents;
}

/** Derive net / VAT-per-rate / gross from (cart or order) lines. */
export function computeTotals(lines: LineAmounts[]): Totals {
  const grossByRate = new Map<number, number>();
  for (const line of lines) {
    const gross = lineGrossCents(line);
    grossByRate.set(line.vat_rate, (grossByRate.get(line.vat_rate) ?? 0) + gross);
  }
  const by_rate = [...grossByRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, gross_cents]) => {
      const net_cents = Math.round((gross_cents * 100) / (100 + rate));
      return { rate, gross_cents, net_cents, vat_cents: gross_cents - net_cents };
    });
  const gross_cents = by_rate.reduce((sum, r) => sum + r.gross_cents, 0);
  const vat_cents = by_rate.reduce((sum, r) => sum + r.vat_cents, 0);
  return { net_cents: gross_cents - vat_cents, vat_cents, gross_cents, by_rate };
}

/** "1.234,56 €" from integer cents — deterministic de-AT formatting. */
export function fmtEur(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents);
  const euros = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}${euros},${rest} €`;
}
