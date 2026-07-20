/**
 * Money math — same discipline as MOD-04: all amounts are integer cents,
 * euros only ever exist at the rendering edge. A deal's value is stored
 * as integer cents; its EXPECTED value (value × the current stage's
 * win-probability) is never stored — it is derived on demand from the
 * pipeline config (server/pipeline-config.ts) so it can never drift when
 * the deal moves stage or the config changes.
 *
 * Rounding: half-away-from-zero on non-negative inputs (Math.round).
 */

/** "1.234,56 €" from integer cents — deterministic de-AT formatting. */
export function fmtEur(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents);
  const euros = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}${euros},${rest} €`;
}
