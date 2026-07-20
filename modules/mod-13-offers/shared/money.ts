/**
 * Money math — THE core correctness property of this module.
 *
 * All amounts are integer cents; euros only ever exist at the rendering
 * edge. Totals are never stored: they are recomputed from the line items
 * by this one function, which the server (API + PDF + CSV), the client
 * (editor preview) and the tests all share — so the numbers on screen,
 * in the API, on the PDF and in the export cannot disagree.
 *
 * Rounding rules (Austrian/German practice):
 *   - line net  = round(quantity × unit_price_cents × (1 − discount%/100))
 *                 → per-line rounding, AFTER the line discount
 *   - VAT       = round(sum of line nets at a rate × rate / 100)
 *                 → computed once per rate on the discounted tax base,
 *                   not per line
 *   - gross     = net + VAT
 * round() is half-away-from-zero on non-negative inputs (Math.round).
 */

export const VAT_RATES = [0, 10, 20] as const;
export type VatRate = (typeof VAT_RATES)[number];

export interface LineAmounts {
  quantity: number;
  unit_price_cents: number;
  vat_rate: number;
  /** Per-line discount as a percentage 0..100. Optional; 0 when absent. */
  discount_percent?: number;
}

export interface Totals {
  /** Gross-of-discount line subtotal (before any line discount). */
  gross_before_discount_cents: number;
  /** Total of the line discounts (gross-of-discount − net). */
  discount_cents: number;
  net_cents: number;
  vat_cents: number;
  gross_cents: number;
  /** Only rates that actually occur, ascending. */
  by_rate: { rate: number; base_cents: number; vat_cents: number }[];
}

/** Undiscounted line amount in cents, rounded per line. */
export function lineGrossCents(line: LineAmounts): number {
  return Math.round(line.quantity * line.unit_price_cents);
}

/** Net amount of a single line in cents, after its discount, rounded per line. */
export function lineNetCents(line: LineAmounts): number {
  const discount = line.discount_percent ?? 0;
  return Math.round(line.quantity * line.unit_price_cents * (1 - discount / 100));
}

/** Derive discounted net / VAT-per-rate / gross from line items. */
export function computeTotals(lines: LineAmounts[]): Totals {
  const baseByRate = new Map<number, number>();
  let grossBeforeDiscount = 0;
  for (const line of lines) {
    const net = lineNetCents(line);
    grossBeforeDiscount += lineGrossCents(line);
    baseByRate.set(line.vat_rate, (baseByRate.get(line.vat_rate) ?? 0) + net);
  }
  const by_rate = [...baseByRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([rate, base_cents]) => ({
      rate,
      base_cents,
      vat_cents: Math.round((base_cents * rate) / 100),
    }));
  const net_cents = by_rate.reduce((sum, r) => sum + r.base_cents, 0);
  const vat_cents = by_rate.reduce((sum, r) => sum + r.vat_cents, 0);
  return {
    gross_before_discount_cents: grossBeforeDiscount,
    discount_cents: grossBeforeDiscount - net_cents,
    net_cents,
    vat_cents,
    gross_cents: net_cents + vat_cents,
    by_rate,
  };
}

/** "1.234,56 €" from integer cents — deterministic de-AT formatting. */
export function fmtEur(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents);
  const euros = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}${euros},${rest} €`;
}
