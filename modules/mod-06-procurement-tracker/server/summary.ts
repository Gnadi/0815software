import type Database from 'better-sqlite3';
import { fmtEur } from '../shared/money.js';
import {
  appliedFilters,
  SUMMARY_VERSION,
  type ContextFilter,
  type ModuleSummary,
  type SummaryContext,
  type SummaryItem,
} from '../shared/summary.js';
import { listPos } from './purchase-orders.js';
import { listRfqs } from './rfqs.js';
import type { PoRow, RfqRow } from '../shared/types.js';

/**
 * What MOD-06 tells a shell about itself.
 *
 * Everything MOD-06-specific stays here: the consumer gets figures, short lists
 * and paths, and nothing about approval tiers, submissions or how a quote
 * becomes an order.
 */

export const MODULE_ID = 'mod-06-procurement-tracker';

/**
 * The context this module can narrow by.
 *
 * `party` is deliberately absent: this module's counterparties are SUPPLIERS,
 * not customers, and they are not resolved against PS-11. Claiming the filter
 * and quietly ignoring it is exactly what `context.applied` prevents.
 */
const SUPPORTED: ContextFilter[] = ['from', 'to'];

const LIST_LIMIT = 8;

/** An order still moving through the approval chain. */
function awaitingApproval(po: PoRow): boolean {
  return po.status === 'submitted';
}

function poItem(po: PoRow): SummaryItem {
  return {
    id: po.number,
    title: `${po.number} · ${po.supplier_name}`,
    subtitle: fmtEur(po.total_cents),
    badge: po.status.toUpperCase(),
    tone: po.status === 'closed' ? 'good' : awaitingApproval(po) ? 'warn' : 'neutral',
    at: po.created_at,
    href: `/purchase-orders/${po.id}`,
  };
}

function rfqItem(rfq: RfqRow): SummaryItem {
  return {
    id: String(rfq.id),
    title: rfq.title,
    subtitle: `${rfq.quote_count} of ${rfq.invited_count} suppliers quoted`,
    badge: rfq.status.toUpperCase(),
    tone: rfq.status === 'awarded' ? 'good' : rfq.status === 'open' ? 'warn' : 'neutral',
    at: rfq.due_date ?? rfq.created_at,
    href: `/rfqs/${rfq.id}`,
  };
}

export interface SummaryOptions {
  /** Injectable wall clock for `generated_at`, so tests stay deterministic. */
  now?: () => Date;
}

export function moduleSummary(
  db: Database.Database,
  context: SummaryContext = {},
  options: SummaryOptions = {},
): ModuleSummary {
  const now = options.now ?? (() => new Date());
  const applied = appliedFilters(context, SUPPORTED);

  let pos = listPos(db);
  let rfqs = listRfqs(db);
  if (context.from !== undefined) {
    pos = pos.filter((po) => po.created_at.slice(0, 10) >= context.from!);
    rfqs = rfqs.filter((r) => r.created_at.slice(0, 10) >= context.from!);
  }
  if (context.to !== undefined) {
    pos = pos.filter((po) => po.created_at.slice(0, 10) <= context.to!);
    rfqs = rfqs.filter((r) => r.created_at.slice(0, 10) <= context.to!);
  }

  const pending = pos.filter(awaitingApproval);
  const openRfqs = rfqs.filter((r) => r.status === 'open' || r.status === 'quoted');
  const committed = pos
    .filter((po) => po.status === 'ordered' || po.status === 'closed')
    .reduce((acc, po) => acc + po.total_cents, 0);

  // Oldest first: an approval queue is a list of what has been waiting, and
  // newest-first would bury exactly the ones holding someone up.
  const byAge = [...pending].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const byDue = [...openRfqs].sort((a, b) => (a.due_date ?? '9999').localeCompare(b.due_date ?? '9999'));

  return {
    summary_version: SUMMARY_VERSION,
    module: MODULE_ID,
    generated_at: now().toISOString(),
    tiles: [
      {
        key: 'awaiting_approval',
        label: 'Orders to approve',
        value: String(pending.length),
        unit: 'submitted',
        tone: pending.length > 0 ? 'warn' : 'good',
        href: '/purchase-orders?status=submitted',
      },
      {
        key: 'open_rfqs',
        label: 'RFQs running',
        value: String(openRfqs.length),
        unit: 'open',
        tone: 'neutral',
        href: '/rfqs',
      },
      {
        key: 'committed',
        label: 'Committed spend',
        value: fmtEur(committed),
        unit: null,
        tone: 'neutral',
        href: '/purchase-orders',
      },
    ],
    lists: [
      {
        key: 'approval_queue',
        label: 'Waiting for approval',
        items: byAge.slice(0, LIST_LIMIT).map(poItem),
        href: '/purchase-orders?status=submitted',
      },
      {
        key: 'running_rfqs',
        label: 'RFQs in flight',
        items: byDue.slice(0, LIST_LIMIT).map(rfqItem),
        href: '/rfqs',
      },
    ],
    context: { supported: SUPPORTED, applied },
  };
}
