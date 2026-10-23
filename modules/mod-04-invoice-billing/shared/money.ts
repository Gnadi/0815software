/**
 * Money math — THE core correctness property of this module.
 *
 * All amounts are integer cents; euros only ever exist at the rendering
 * edge. Totals are never stored: they are recomputed from the line items
 * by this one function, which the server (API + PDF), the client
 * (editor preview) and the tests all share — so the numbers on screen,
 * in the API and on the PDF cannot disagree.
 *
 * Rounding rules (Austrian/German practice):
 *   - line net  = round(quantity × unit_price_cents)   → per-line rounding
 *   - VAT       = round(sum of line nets at a rate × rate / 100)
 *                 → computed once per rate on the tax base, not per line
 *   - gross     = net + VAT
 * round() is half up; every input is non-negative. How the line net is
 * computed depends on when the invoice was issued — see `LineRounding`.
 */

/**
 * Every rate a line may carry: Austria (0 / 10 / 13 / 20) and Germany
 * (0 / 7 / 19). One list for the database CHECK and the API; the editor offers
 * only the rates of the seller's own country (`vatRatesFor`), so an Austrian
 * installation never sees 19 % in its dropdown.
 */
export const VAT_RATES = [0, 7, 10, 13, 19, 20] as const;
export type VatRate = (typeof VAT_RATES)[number];

/** The rates a seller established in `country` charges domestically. */
export function vatRatesFor(country: string): readonly number[] {
  if (country === 'DE') return [0, 7, 19];
  if (country === 'AT') return [0, 10, 13, 20];
  return VAT_RATES;
}

export interface LineAmounts {
  quantity: number;
  unit_price_cents: number;
  vat_rate: number;
}

export interface Totals {
  net_cents: number;
  vat_cents: number;
  gross_cents: number;
  /** Only rates that actually occur, ascending. */
  by_rate: { rate: number; base_cents: number; vat_cents: number }[];
}

/**
 * How a line's net is rounded to the cent.
 *
 * `decimal` — the quantity in ten-thousandths (the four decimals an e-invoice
 * states it with) times the unit price, rounded half up, in integers: exactly
 * BT-131, what a recipient recomputes and Peppol checks (PEPPOL-EN16931-R120).
 *
 * `float` — Math.round(quantity × unit price) in binary floating point. 0.29
 * is stored as 0.28999…, so 0.29 × 0.50 € came out 0.14 € instead of 0.15 €;
 * roughly one decimal quantity in a thousand rounded a cent low that way.
 * Invoices issued before the switch keep it — their amounts were sent, paid
 * and booked as computed then, and an issued invoice does not change.
 *
 * Which one an invoice uses is fixed when it is finalized (server/invoices.ts);
 * a draft always uses `LINE_ROUNDING`.
 */
export type LineRounding = 'decimal' | 'float';

/** The rounding every invoice finalized from now on is computed with. */
export const LINE_ROUNDING: LineRounding = 'decimal';

/** Decimal places a quantity may have: what the e-invoice states, so what is computed. */
export const QUANTITY_DECIMALS = 4;

/**
 * Whether `quantity` has at most four decimal places. A tolerance far below
 * 0.0001 absorbs binary noise (0.1 + 0.2), nothing that is a real fifth digit.
 */
export function fitsQuantityDecimals(quantity: number): boolean {
  const scaled = quantity * 10 ** QUANTITY_DECIMALS;
  return Math.abs(scaled - Math.round(scaled)) < 1e-6;
}

/** Net amount of a single line in cents, rounded per line. */
export function lineNetCents(line: LineAmounts, rounding: LineRounding): number {
  if (rounding === 'float') return Math.round(line.quantity * line.unit_price_cents);
  // Split so neither product leaves the exact integer range of a double:
  // 1,000,000 × 100,000,000 cents would, as one product in ten-thousandths.
  const tenThousandths = Math.round(line.quantity * 10_000);
  const whole = Math.floor(tenThousandths / 10_000);
  const part = tenThousandths - whole * 10_000;
  return whole * line.unit_price_cents + Math.floor((part * line.unit_price_cents + 5_000) / 10_000);
}

/** Derive net / VAT-per-rate / gross from line items. */
export function computeTotals(lines: LineAmounts[], rounding: LineRounding): Totals {
  const baseByRate = new Map<number, number>();
  for (const line of lines) {
    const net = lineNetCents(line, rounding);
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
  return { net_cents, vat_cents, gross_cents: net_cents + vat_cents, by_rate };
}

/** "1.234,56 €" from integer cents — deterministic de-AT formatting. */
export function fmtEur(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents);
  const euros = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}${euros},${rest} €`;
}
