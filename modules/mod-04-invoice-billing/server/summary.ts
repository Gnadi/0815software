import type Database from 'better-sqlite3';
import { fmtEur } from '../shared/money.js';
import {
  appliedFilters,
  SUMMARY_VERSION,
  type ContextFilter,
  type ModuleSummary,
  type SummaryContext,
  type SummaryItem,
  type SummaryTone,
} from '../shared/summary.js';
import { listInvoices, todayIso } from './invoices.js';
import type { InvoiceRow } from '../shared/types.js';

/**
 * What MOD-04 tells a shell about itself.
 *
 * Everything MOD-04-specific stays here, as `transfer-import.ts` keeps the
 * import's internals here: the consumer gets figures, short lists and paths,
 * and nothing about invoice ids, payment rows or how the ledger is stored. The
 * numbers come from `listInvoices` — the same function the module's own screens
 * read — so a widget cannot disagree with the module.
 */

export const MODULE_ID = 'mod-04-invoice-billing';

/** The context this module can narrow by. `party` needs a PS-11 link (db.ts). */
const SUPPORTED: ContextFilter[] = ['party', 'from', 'to'];

/** How many rows a list widget carries. A board shows excerpts, not tables. */
const LIST_LIMIT = 8;

/** An invoice's own date for context purposes: when issued, else when drafted. */
function invoiceDate(row: InvoiceRow): string {
  return (row.issue_date ?? row.created_at).slice(0, 10);
}

/**
 * Local customer ids for a PS-11 party. A party can map to more than one local
 * customer — the same company entered twice, then both rows resolved to one
 * party — so this is a set. Empty means the shell asked about a customer this
 * module has never billed, which renders as an empty widget rather than an
 * unfiltered one.
 */
function customerIdsForParty(db: Database.Database, partyId: number): Set<number> {
  const rows = db.prepare('SELECT id FROM customers WHERE party_id = ?').all(partyId) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

function tone(row: InvoiceRow): SummaryTone {
  if (row.overdue) return 'bad';
  if (row.status === 'paid') return 'good';
  if (row.status === 'sent') return 'warn';
  return 'neutral';
}

function toItem(row: InvoiceRow): SummaryItem {
  return {
    id: row.number ?? `draft-${row.id}`,
    title: `${row.number ?? 'DRAFT'} · ${row.customer_name}`,
    subtitle: fmtEur(row.gross_cents),
    badge: row.overdue ? 'OVERDUE' : row.status.toUpperCase(),
    tone: tone(row),
    at: row.due_date ?? row.issue_date ?? row.created_at,
    href: `/invoices/${row.id}`,
  };
}

export interface SummaryOptions {
  /** Injectable date "YYYY-MM-DD", so overdue is deterministic in tests. */
  today?: string;
  /** Injectable wall clock for `generated_at`. */
  now?: () => Date;
}

export function moduleSummary(
  db: Database.Database,
  context: SummaryContext = {},
  options: SummaryOptions = {},
): ModuleSummary {
  const today = options.today ?? todayIso();
  const now = options.now ?? (() => new Date());

  // What this response was narrowed by. A filter counts as applied when it
  // RAN, not when it matched — empty-because-filtered is a true answer, and
  // what this echo prevents is a filter the shell sent, this module ignored,
  // and the board then labelled as narrowed.
  const applied = appliedFilters(context, SUPPORTED);

  let rows = listInvoices(db, {}, today);
  if (context.party !== undefined) {
    const ids = customerIdsForParty(db, context.party);
    rows = rows.filter((r) => ids.has(r.customer_id));
  }
  if (context.from !== undefined) rows = rows.filter((r) => invoiceDate(r) >= context.from!);
  if (context.to !== undefined) rows = rows.filter((r) => invoiceDate(r) <= context.to!);

  const live = rows.filter((r) => r.status !== 'cancelled');
  const drafts = rows.filter((r) => r.status === 'draft');
  const overdue = live.filter((r) => r.overdue);
  const paid = live.filter((r) => r.status === 'paid');

  // What the customer still owes: gross minus what has been paid, over every
  // issued invoice that is not cancelled. Drafts are excluded — nobody owes
  // money on an invoice that has not been sent.
  const issued = live.filter((r) => r.status !== 'draft');
  const outstanding = issued.reduce((acc, r) => acc + (r.gross_cents - r.paid_cents), 0);
  const overdueValue = overdue.reduce((acc, r) => acc + (r.gross_cents - r.paid_cents), 0);

  const byDueDate = [...overdue].sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'));

  return {
    summary_version: SUMMARY_VERSION,
    module: MODULE_ID,
    generated_at: now().toISOString(),
    tiles: [
      {
        key: 'outstanding',
        label: 'Outstanding',
        value: fmtEur(outstanding),
        unit: null,
        tone: outstanding > 0 ? 'warn' : 'good',
        href: '/invoices?status=sent',
      },
      {
        key: 'overdue',
        label: 'Overdue',
        value: String(overdue.length),
        unit: 'invoices',
        tone: overdue.length > 0 ? 'bad' : 'good',
        href: '/invoices?status=overdue',
      },
      {
        key: 'overdue_value',
        label: 'Overdue value',
        value: fmtEur(overdueValue),
        unit: null,
        tone: overdueValue > 0 ? 'bad' : 'neutral',
        href: '/invoices?status=overdue',
      },
      {
        key: 'paid',
        label: 'Settled',
        value: String(paid.length),
        unit: 'invoices',
        tone: 'good',
        href: '/invoices?status=paid',
      },
      {
        key: 'drafts',
        label: 'Drafts',
        value: String(drafts.length),
        unit: 'unsent',
        tone: 'neutral',
        href: '/invoices?status=draft',
      },
    ],
    lists: [
      {
        key: 'overdue_invoices',
        label: 'Overdue, oldest first',
        items: byDueDate.slice(0, LIST_LIMIT).map(toItem),
        href: '/invoices?status=overdue',
      },
      {
        key: 'draft_invoices',
        label: 'Drafts awaiting send',
        items: drafts.slice(0, LIST_LIMIT).map(toItem),
        href: '/invoices?status=draft',
      },
    ],
    context: { supported: SUPPORTED, applied },
  };
}
