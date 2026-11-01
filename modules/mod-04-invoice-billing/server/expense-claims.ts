import type Database from 'better-sqlite3';
import { expenseTransferProblem, type ExpenseClaimTransfer } from '../shared/expense-transfer.js';
import { ibanProblem, isValidBic, MAX_REMITTANCE, normalizeBic, normalizeIban, sepaText } from '../shared/sepa.js';
import type { BillLine, BillRow } from '../shared/types.js';
import { createBill, createCreditor, getBill } from './bills.js';
import { DomainError, nowIso, todayIso } from './invoices.js';
import { OfferFetchError, type PlatformHooks } from './platform.js';

/**
 * Expense claims from MOD-11 Time Tracking, paid by bank transfer.
 *
 * An approved claim set to be paid "by transfer" is taken over as a bill to
 * the employee — the same bill, creditor and payment run as a supplier's, so
 * the money leaves through the one door that is already checked: the IBAN
 * validated, the pain.001 file, the run that cannot carry a bill twice.
 *
 * - **Once.** The bill names its claim (`expense_claim`, unique) and carries
 *   the claim number as its reference; a second import returns the first
 *   bill. MOD-11 is told it is handed over BEFORE the bill exists, and from
 *   then refuses to mark the claim paid by hand — the other way a claim
 *   would be paid twice.
 * - **Exact.** The amount is the claim's total, and the transfer's lines must
 *   add up to it (shared/expense-transfer.ts); an expense bill's amount and
 *   reference cannot be edited, and it is paid, not cancelled or deleted.
 * - **Reported back.** When the bill is paid, MOD-11 hears it. A report that
 *   does not get through is kept (`expense_reported_at` stays empty) and sent
 *   again the next time anyone opens the expense claims here.
 */

/** What MOD-11 is told the claim became here. */
export const handoverReference = (number: string): string => `MOD-04:${number}`;

function peerError(err: unknown): never {
  if (err instanceof OfferFetchError) {
    // MOD-11's own refusals (not found, not approved, no account) are the
    // operator's to read; anything else is MOD-11 being unreachable.
    throw new DomainError([404, 409, 422, 501].includes(err.status) ? err.status : 502, err.message);
  }
  throw err;
}

function readTransfer(raw: unknown, number: string): ExpenseClaimTransfer {
  if (!raw || typeof raw !== 'object') throw new DomainError(502, 'The time tracking module sent something that is not an expense claim');
  const t = raw as ExpenseClaimTransfer;
  const problem = expenseTransferProblem(t);
  if (problem) throw new DomainError(422, `Expense claim ${number} cannot be paid: ${problem}`);
  if (t.number !== number) throw new DomainError(502, `Asked for ${number}, the time tracking module answered with ${String(t.number)}`);
  const iban = ibanProblem(t.payee.iban);
  if (iban) throw new DomainError(422, `Expense claim ${number} cannot be paid: ${iban}`);
  if (t.payee.bic && !isValidBic(t.payee.bic)) throw new DomainError(422, `Expense claim ${number} cannot be paid: the BIC is not valid`);
  return t;
}

/** One bill line per allowance, and per VAT rate of a receipt — net derived from the gross. */
function linesOf(t: ExpenseClaimTransfer): Omit<BillLine, 'position'>[] {
  const lines: Omit<BillLine, 'position'>[] = [];
  const line = (description: string, net: number, rate: number | null) =>
    lines.push({ description: description.slice(0, 300), item_id: null, quantity: null, unit_code: null, unit_price_cents: null, net_cents: net, vat_rate: rate });
  for (const l of t.lines) {
    const what = `${l.date} ${l.description}`;
    if (l.vat_lines.length === 0) line(what, l.amount_cents, null);
    else for (const v of l.vat_lines) line(l.vat_lines.length > 1 ? `${what} (${v.rate_bp / 100} %)` : what, Math.round((v.gross_cents * 10_000) / (10_000 + v.rate_bp)), v.rate_bp / 100);
  }
  return lines;
}

function billOfClaim(db: Database.Database, number: string): number | null {
  const row = db.prepare('SELECT id FROM bills WHERE expense_claim = ?').get(number) as { id: number } | undefined;
  return row?.id ?? null;
}

export async function importExpenseClaim(
  db: Database.Database,
  platform: PlatformHooks,
  number: string,
  actor: string,
  today = todayIso(),
): Promise<{ bill: BillRow; created: boolean }> {
  if (!platform.expenseClaimsConfigured || !platform.fetchExpenseClaim || !platform.expenseClaimHandedOver) {
    throw new DomainError(501, 'No time tracking is configured — set TIME_TRACKING_URL to pay expense claims');
  }
  const existing = billOfClaim(db, number);
  if (existing !== null) return { bill: getBill(db, existing, today), created: false };

  let raw: unknown;
  try {
    raw = await platform.fetchExpenseClaim(number);
  } catch (err) {
    peerError(err);
  }
  const t = readTransfer(raw, number);
  const reference = handoverReference(number);
  if (t.handed_over_ref !== null && t.handed_over_ref !== reference) {
    throw new DomainError(409, `Expense claim ${number} is already being paid as ${t.handed_over_ref}`);
  }
  try {
    await platform.expenseClaimHandedOver({ number, reference, actor });
  } catch (err) {
    peerError(err);
  }

  const id = db.transaction((): number => {
    // A second import racing this one found nothing above; the unique index
    // on expense_claim would refuse it, so look again inside the transaction.
    const raced = billOfClaim(db, number);
    if (raced !== null) return raced;
    const iban = normalizeIban(t.payee.iban);
    const known = db.prepare('SELECT id FROM creditors WHERE iban = ? ORDER BY id LIMIT 1').get(iban) as { id: number } | undefined;
    const creditorId =
      known?.id ??
      createCreditor(db, {
        name: t.payee.holder,
        iban,
        bic: t.payee.bic ? normalizeBic(t.payee.bic) : null,
        note: `Employee — expense claims from MOD-11 (${t.employee.name})`,
      });
    const billId = createBill(db, {
      creditorId,
      reference: number,
      remittance: sepaText(`Spesen ${number} ${t.title}`, MAX_REMITTANCE),
      amountCents: t.totals.total_cents,
      issueDate: t.approved_at.slice(0, 10),
      // Owed since it was approved: the next payment run takes it.
      dueDate: today,
      note: `${t.title} — expense claim of ${t.employee.name}, approved by ${t.approved_by}; imported by ${actor}`.slice(0, 500),
      lines: linesOf(t),
    });
    db.prepare('UPDATE bills SET expense_claim = ? WHERE id = ?').run(number, billId);
    return billId;
  })();
  return { bill: getBill(db, id, today), created: true };
}

/**
 * Tell MOD-11 about every paid expense bill it has not yet confirmed. Called
 * after a bill is paid and whenever the expense claims are opened, so a
 * report lost to an outage is not lost for good.
 */
export async function reportExpensePayments(db: Database.Database, platform: PlatformHooks, actor: string): Promise<{ reported: string[]; failed: string[] }> {
  const out = { reported: [] as string[], failed: [] as string[] };
  if (!platform.expenseClaimsConfigured || !platform.expenseClaimPaid) return out;
  const rows = db
    .prepare(
      `SELECT b.id, b.expense_claim, r.message_id FROM bills b
         LEFT JOIN payment_run_items i ON i.bill_id = b.id AND i.active = 1
         LEFT JOIN payment_runs r ON r.id = i.run_id
       WHERE b.expense_claim IS NOT NULL AND b.paid_at IS NOT NULL AND b.expense_reported_at IS NULL
       ORDER BY b.id`,
    )
    .all() as { id: number; expense_claim: string; message_id: string | null }[];
  for (const row of rows) {
    try {
      await platform.expenseClaimPaid({
        number: row.expense_claim,
        bill: handoverReference(row.expense_claim),
        reference: row.message_id ? `payment run ${row.message_id}` : `bill ${row.id}, paid outside a payment run`,
        actor,
      });
      db.prepare('UPDATE bills SET expense_reported_at = ? WHERE id = ?').run(nowIso(), row.id);
      out.reported.push(row.expense_claim);
    } catch (err) {
      console.warn(`[mod-04] telling MOD-11 that ${row.expense_claim} is paid failed:`, err);
      out.failed.push(row.expense_claim);
    }
  }
  return out;
}

/** The panel: what MOD-11 has waiting, and the expense bills here. */
export async function expenseClaimsOverview(db: Database.Database, platform: PlatformHooks, actor: string, today = todayIso()) {
  if (!platform.expenseClaimsConfigured || !platform.listExpenseClaims) {
    return { configured: false, waiting: [], bills: [], unreachable: null as string | null, unreported: [] as string[] };
  }
  const report = await reportExpensePayments(db, platform, actor);
  let waiting: unknown[] = [];
  let unreachable: string | null = null;
  try {
    const answer = (await platform.listExpenseClaims()) as { claims?: unknown[] };
    waiting = Array.isArray(answer?.claims) ? answer.claims : [];
  } catch (err) {
    unreachable = err instanceof Error ? err.message : String(err);
  }
  const ids = db.prepare('SELECT id FROM bills WHERE expense_claim IS NOT NULL ORDER BY id DESC').all() as { id: number }[];
  return { configured: true, waiting, bills: ids.map((r) => getBill(db, r.id, today)), unreachable, unreported: report.failed };
}
