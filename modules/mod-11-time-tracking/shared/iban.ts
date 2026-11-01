/**
 * IBAN checks for where expenses are paid to — this module's own copy, so it
 * runs without MOD-04 (which carries the same rules for its payment files).
 *
 * An expense payout leaves by SEPA credit transfer or with the salary, so the
 * account must be in the SEPA scheme area; the country list is the length
 * check as well (EPC IBAN registry). The check digits are ISO 7064 MOD 97-10.
 */

export const SEPA_IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AT: 20, BE: 16, BG: 22, CH: 21, CY: 28, CZ: 24, DE: 22, DK: 18,
  EE: 20, ES: 24, FI: 18, FR: 27, GB: 22, GI: 23, GR: 27, HR: 21, HU: 28,
  IE: 22, IS: 26, IT: 27, LI: 21, LT: 20, LU: 20, LV: 21, MC: 27, MT: 31,
  NL: 18, NO: 15, PL: 28, PT: 25, RO: 24, SE: 24, SI: 19, SK: 24, SM: 27,
  VA: 22,
};

export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** "AT61 1904 3002 3457 3201". */
export function formatIban(iban: string): string {
  return normalizeIban(iban).replace(/(.{4})(?=.)/g, '$1 ');
}

/** "AT61 **** **** **** 3201" — enough to recognise one's own account by. */
export function maskIban(iban: string): string {
  const n = normalizeIban(iban);
  return formatIban(n.slice(0, 4) + '*'.repeat(Math.max(0, n.length - 8)) + n.slice(-4));
}

function mod97(input: string): number {
  let remainder = 0;
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (code >= 48 && code <= 57) remainder = (remainder * 10 + (code - 48)) % 97;
    else if (code >= 65 && code <= 90) remainder = (remainder * 100 + (code - 55)) % 97;
    else return -1;
  }
  return remainder;
}

/** Why an IBAN cannot be paid to, or null. */
export function ibanProblem(raw: string): string | null {
  const iban = normalizeIban(raw);
  if (iban === '') return 'IBAN is required';
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) return 'An IBAN starts with two letters and two check digits, then letters and digits only';
  const country = iban.slice(0, 2);
  const expected = SEPA_IBAN_LENGTHS[country];
  if (expected === undefined) return `${country} is not in the SEPA area — an expense payout cannot reach this account`;
  if (iban.length !== expected) return `An ${country} IBAN has ${expected} characters, this one has ${iban.length}`;
  if (mod97(iban.slice(4) + iban.slice(0, 4)) !== 1) return 'The check digits do not match — check for a typo';
  return null;
}

export function isValidBic(raw: string): boolean {
  return /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(raw.replace(/\s+/g, '').toUpperCase());
}
