/**
 * THE EXPENSE CLAIM TRANSFER — what an approved claim looks like to the module
 * that pays it by bank transfer (MOD-04 Invoicing takes it over as a bill).
 *
 * The importer keeps its own copy of this shape (the repo's copy-in
 * convention for wire contracts). Two rules make it safe:
 *
 * 1. **The payee is the person's own account, as they last gave it.** The
 *    claim carries holder, IBAN and BIC; the importer pays exactly that, and
 *    matches or creates its creditor by the IBAN.
 * 2. **Money is exact and self-checking.** Every line's amount is integer
 *    cents and the lines add up to `totals.total_cents`; an importer refuses a
 *    transfer whose numbers disagree, so a rounding difference between two
 *    modules can never become a wrong payment.
 *
 * Only an approved claim set to be paid by bank transfer is handed over, and
 * the importer reports back twice: before it creates the bill
 * (`handed-over`, so the claim cannot also be paid by hand) and when the bill
 * is paid (`paid`). Both are idempotent.
 *
 * Byte-identical in MOD-11 (which exports) and MOD-04 (which imports).
 */

/** Bumped only on a breaking change to the shape. Importers must check it. */
export const EXPENSE_TRANSFER_VERSION = 1;

/** Gross amount per VAT rate, the rate in basis points (2000 = 20 %). */
export interface ExpenseTransferVatLine {
  rate_bp: number;
  gross_cents: number;
}

export interface ExpenseTransferTotals {
  per_diem_cents: number;
  nights_cents: number;
  mileage_cents: number;
  receipts_cents: number;
  total_cents: number;
}

export interface ExpenseTransferLine {
  kind: 'per_diem' | 'nights' | 'mileage' | 'receipt';
  date: string;
  description: string;
  amount_cents: number;
  /** A receipt's gross amounts per VAT rate, for the books; empty for allowances. */
  vat_lines: ExpenseTransferVatLine[];
}

export interface ExpenseClaimTransfer {
  version: typeof EXPENSE_TRANSFER_VERSION;
  source: string;
  number: string;
  title: string;
  employee: { name: string; email: string | null };
  payee: { holder: string; iban: string; bic: string | null };
  approved_at: string;
  approved_by: string;
  currency: 'EUR';
  totals: ExpenseTransferTotals;
  lines: ExpenseTransferLine[];
  /** The bill it already became, if it was handed over before. */
  handed_over_ref: string | null;
}

/** Why a transfer cannot be trusted, or null. */
export function expenseTransferProblem(t: ExpenseClaimTransfer): string | null {
  if (t.version !== EXPENSE_TRANSFER_VERSION) return `Unknown expense transfer version ${String(t.version)}`;
  if (t.currency !== 'EUR') return 'Only euro claims are paid by SEPA transfer';
  const sum = t.lines.reduce((a, l) => a + l.amount_cents, 0);
  if (sum !== t.totals.total_cents) return `The lines add up to ${sum} cents, the claim to ${t.totals.total_cents}`;
  if (t.totals.total_cents <= 0) return 'The claim pays nothing out';
  if (!t.payee || typeof t.payee.iban !== 'string' || t.payee.iban === '') return 'The claim names no account to pay';
  return null;
}
