/**
 * Money math — same discipline as MOD-04: all amounts are integer cents,
 * euros only ever exist at the rendering edge. A purchase order's total
 * is NEVER stored while the PO is editable: it is recomputed from the
 * line items by this one function, which the server, the client (editor
 * preview) and the tests all share. The only place a total is written
 * down is the append-only `po_submissions` row created when a PO is
 * submitted for approval — that snapshot is what the required approval
 * tiers were derived from, frozen forever.
 *
 * Procurement prices are net (no VAT handling — see README, out of scope).
 * Rounding: line net = round(quantity × unit_price_cents), per line,
 * half-away-from-zero on non-negative inputs (Math.round).
 */

export interface LineAmounts {
  quantity: number;
  unit_price_cents: number;
}

/** Net amount of a single line in cents, rounded per line. */
export function lineNetCents(line: LineAmounts): number {
  return Math.round(line.quantity * line.unit_price_cents);
}

/** Total of a set of lines — the number approval tiers are derived from. */
export function computeTotalCents(lines: LineAmounts[]): number {
  return lines.reduce((sum, line) => sum + lineNetCents(line), 0);
}

/** "1.234,56 €" from integer cents — deterministic de-AT formatting. */
export function fmtEur(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents);
  const euros = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}${euros},${rest} €`;
}
