import type { Totals } from './types.js';

/**
 * The money rules, the same as the document transfer's (shared/transfer.ts):
 * a line net is rounded once per line, VAT once per rate on that rate's base.
 * Kept separate from the transfer copy because that file is identical across
 * modules and must not grow this module's helpers.
 */
export function lineNetCents(line: { quantity: number; unit_price_cents: number; discount_percent: number }): number {
  return Math.round(line.quantity * line.unit_price_cents * (1 - line.discount_percent / 100));
}

export function totalsOf(lines: { net_cents: number; vat_rate: number }[]): Totals {
  const baseByRate = new Map<number, number>();
  for (const line of lines) baseByRate.set(line.vat_rate, (baseByRate.get(line.vat_rate) ?? 0) + line.net_cents);
  let net = 0;
  let vat = 0;
  for (const [rate, base] of baseByRate) {
    net += base;
    vat += Math.round((base * rate) / 100);
  }
  return { net_cents: net, vat_cents: vat, gross_cents: net + vat };
}

/**
 * Quantities are compared in thousandths. Floating-point sums of deliveries
 * (0.1 + 0.2) must not make "everything delivered" read as 0.0000001 short.
 */
export const QTY_SCALE = 1000;
export const milli = (quantity: number): number => Math.round(quantity * QTY_SCALE);

export function fmtEur(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const euros = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${sign}${euros},${String(abs % 100).padStart(2, '0')} €`;
}
