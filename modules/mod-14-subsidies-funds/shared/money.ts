/**
 * Money math — same discipline as MOD-04: all amounts are integer cents,
 * euros only ever exist at the rendering edge. Balances are NEVER stored:
 * a program's grant ceiling and an application's eligible/requested/approved
 * amounts are the only stored money; everything derived (the funding cap, a
 * disbursement total, the remaining balance) is recomputed by these shared
 * functions, which the server, the client and the tests all import.
 *
 * No VAT handling: eligible costs and grants are treated as plain net
 * amounts (see README, out of scope).
 */

/**
 * The maximum grant a program's funding rate justifies for the given
 * eligible costs: floor(eligible_costs × funding_rate / 100). This is the
 * ceiling the requested amount is checked against (server/applications.ts).
 * Integer maths only — no floats leak into cents.
 */
export function fundingCapCents(eligibleCostsCents: number, fundingRatePercent: number): number {
  return Math.floor((eligibleCostsCents * fundingRatePercent) / 100);
}

/** Sum a set of disbursement tranche amounts (integer cents). */
export function sumTranches(amounts: number[]): number {
  return amounts.reduce((total, cents) => total + cents, 0);
}

/** "1.234,56 €" from integer cents — deterministic de-AT formatting. */
export function fmtEur(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents);
  const euros = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}${euros},${rest} €`;
}
