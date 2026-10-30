import type Database from 'better-sqlite3';
import type { BillMatch, BillMatchCheck, BillMatchRelease, MatchVerdict } from '../shared/types.js';
import { DomainError } from './invoices.js';
import { OfferFetchError, type InvoicedLine, type PlatformHooks } from './platform.js';

/**
 * The three-way match, the paying side: a bill naming a MOD-06 purchase order
 * is paid only when MOD-06 says what was ordered and received covers it.
 *
 * - **MOD-06 decides.** It knows what was ordered, at which price, and what
 *   arrived. This module sends the net amount invoiced against the PO so far —
 *   this bill and the ones before it, not cancelled — so a second partial
 *   invoice is judged with the first, and a later bill never blames an
 *   earlier one.
 * - **Every answer is kept** (`bill_match_checks`), append-only. A failed
 *   call is kept too but decides nothing: the last real answer stands, so an
 *   outage of MOD-06 neither pays a held bill nor holds a matched one.
 * - **Held bills are refused by the payment run** (`createPaymentRun`), the
 *   one place money leaves. A manager may release a held verdict with a
 *   reason (`bill_match_releases`); the release covers that verdict only.
 * - **Line by line**, when the bill has the supplier's lines: they go along
 *   with the lines of the earlier bills on the PO, and MOD-06 matches each
 *   to a PO line. A line it counts as an issue — more than arrived or was
 *   ordered, above the PO price, a sizeable line not on the PO — holds the
 *   bill even when the amount matched: the same money can be the wrong goods.
 * - **Opt-in.** Without PROCUREMENT_URL nothing is asked and nothing held;
 *   the purchase order number is then a reference like any other.
 */

interface CheckRow extends BillMatchCheck {
  bill_id: number;
}

/** What has been invoiced against the bill's PO so far, net, up to this bill. */
export function invoicedSoFar(db: Database.Database, billId: number): number {
  const bill = db.prepare('SELECT po_number FROM bills WHERE id = ?').get(billId) as { po_number: string | null } | undefined;
  if (!bill?.po_number) return 0;
  return (
    db
      .prepare('SELECT COALESCE(SUM(net_cents), 0) AS n FROM bills WHERE po_number = ? AND cancelled_at IS NULL AND id <= ?')
      .get(bill.po_number, billId) as { n: number }
  ).n;
}

/**
 * The lines invoiced against the bill's PO so far — this bill's and the ones
 * before it, not cancelled, like `invoicedSoFar`. Empty when this bill has
 * none: then only the amount is matched.
 */
export function invoicedLinesSoFar(db: Database.Database, billId: number): InvoicedLine[] {
  const bill = db.prepare('SELECT po_number FROM bills WHERE id = ?').get(billId) as { po_number: string | null } | undefined;
  if (!bill?.po_number) return [];
  const own = db.prepare('SELECT COUNT(*) AS n FROM bill_lines WHERE bill_id = ?').get(billId) as { n: number };
  if (own.n === 0) return [];
  return db
    .prepare(
      `SELECT l.item_id, l.description, l.quantity, l.net_cents FROM bill_lines l JOIN bills b ON b.id = l.bill_id
        WHERE b.po_number = ? AND b.cancelled_at IS NULL AND b.id <= ? ORDER BY b.id, l.position`,
    )
    .all(bill.po_number, billId) as InvoicedLine[];
}

function checksOf(db: Database.Database, billId: number): CheckRow[] {
  const rows = db.prepare('SELECT * FROM bill_match_checks WHERE bill_id = ? ORDER BY id').all(billId) as (Omit<CheckRow, 'lines'> & { lines: string })[];
  return rows.map((r) => ({ ...r, lines: JSON.parse(r.lines) as CheckRow['lines'] }));
}

/** Where the match stands — derived from the bill, its checks and releases. */
export function billMatch(db: Database.Database, bill: { id: number; po_number: string | null }): BillMatch {
  if (!bill.po_number) return { state: 'not_linked', check: null, last_error: null, release: null };
  const checks = checksOf(db, bill.id);
  const answers = checks.filter((c) => c.result !== 'error');
  const latest = answers.at(-1) ?? null;
  const lastError = checks.at(-1)?.result === 'error' ? checks.at(-1)! : null;
  const strip = (c: CheckRow | null): BillMatchCheck | null => {
    if (!c) return null;
    const { bill_id: _b, ...check } = c;
    return check;
  };
  if (!latest) return { state: 'not_checked', check: null, last_error: strip(lastError), release: null };
  const release =
    (db.prepare('SELECT check_id, reason, actor, at FROM bill_match_releases WHERE bill_id = ? AND check_id = ? ORDER BY id DESC LIMIT 1').get(bill.id, latest.id) as
      | BillMatchRelease
      | undefined) ?? null;
  const state = latest.result === 'matched' && latest.line_issues === 0 ? 'matched' : release ? 'released' : 'held';
  return { state, check: strip(latest), last_error: strip(lastError), release };
}

function record(db: Database.Database, billId: number, invoiced: number, actor: string, verdict: MatchVerdict | { result: 'unknown_po' | 'error'; message: string }): void {
  const v = verdict as Partial<MatchVerdict>;
  const lines = v.lines ?? [];
  db.prepare(
    `INSERT INTO bill_match_checks (bill_id, result, message, ordered_cents, received_cents, invoiced_cents, tolerance_cents, line_issues, lines, actor, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    billId,
    verdict.result,
    verdict.message,
    v.ordered_cents ?? null,
    v.received_cents ?? null,
    invoiced,
    v.tolerance_cents ?? null,
    // Counted here from the verdicts, so an answer that miscounts cannot release a line.
    lines.filter((l) => l.issue).length,
    JSON.stringify(lines),
    actor,
    new Date().toISOString(),
  );
}

/**
 * Ask MOD-06 about one bill and keep the answer. Best-effort: when MOD-06
 * cannot be reached the attempt is recorded and the last answer stands.
 * Does nothing for a bill without a PO, a paid or cancelled one, or when
 * MOD-06 is not configured.
 */
export async function checkBill(db: Database.Database, platform: PlatformHooks, billId: number, actor: string): Promise<void> {
  const bill = db.prepare('SELECT po_number, paid_at, cancelled_at FROM bills WHERE id = ?').get(billId) as
    | { po_number: string | null; paid_at: string | null; cancelled_at: string | null }
    | undefined;
  if (!bill?.po_number || bill.paid_at || bill.cancelled_at || !platform.procurementConfigured || !platform.matchInvoice) return;
  const invoiced = invoicedSoFar(db, billId);
  try {
    record(db, billId, invoiced, actor, await platform.matchInvoice(bill.po_number, invoiced, invoicedLinesSoFar(db, billId)));
  } catch (err) {
    if (err instanceof OfferFetchError && err.status === 404) {
      record(db, billId, invoiced, actor, { result: 'unknown_po', message: `MOD-06 has no purchase order ${bill.po_number}` });
    } else {
      record(db, billId, invoiced, actor, { result: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** Release a held verdict, with the reason. Only the verdict it answers. */
export function releaseMatch(db: Database.Database, billId: number, reason: string, actor: string): void {
  const bill = db.prepare('SELECT id, po_number FROM bills WHERE id = ?').get(billId) as { id: number; po_number: string | null } | undefined;
  if (!bill) throw new DomainError(404, 'Bill not found');
  const match = billMatch(db, bill);
  if (match.state !== 'held') {
    throw new DomainError(409, match.state === 'not_checked' ? 'There is no verdict to release yet — check the match first' : `Nothing to release: the match is ${match.state.replace('_', ' ')}`);
  }
  db.prepare('INSERT INTO bill_match_releases (bill_id, check_id, reason, actor, at) VALUES (?, ?, ?, ?, ?)').run(billId, match.check!.id, reason, actor, new Date().toISOString());
}
