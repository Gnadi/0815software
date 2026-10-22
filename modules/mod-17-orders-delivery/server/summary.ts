import type Database from 'better-sqlite3';
import {
  appliedFilters,
  SUMMARY_VERSION,
  type ContextFilter,
  type ModuleSummary,
  type SummaryContext,
  type SummaryItem,
} from '../shared/summary.js';
import { listOrders } from './orders.js';
import type { OrderRow } from '../shared/types.js';
import { fmtEur } from '../shared/money.js';

/**
 * What MOD-17 tells a shell about itself (`shared/summary.ts`,
 * `docs/SHELL-CONTRACT.md`). The figures come from the same functions the
 * module's own screens read, so a widget cannot disagree with the module.
 */

export const MODULE_ID = 'mod-17-orders-delivery';

/**
 * The context this module can narrow by. Claim only what is really filtered:
 * a board narrowed to one customer must not show this module's figures for
 * everyone and label them as narrowed.
 */
const SUPPORTED: ContextFilter[] = ['from', 'to'];

const LIST_LIMIT = 8;

const BADGE: Record<OrderRow['status'], string> = {
  open: 'OPEN',
  partially_delivered: 'PARTLY DELIVERED',
  delivered: 'DELIVERED',
  cancelled: 'CANCELLED',
};

function item(row: OrderRow): SummaryItem {
  return {
    id: String(row.id),
    title: `${row.number} · ${row.customer_name}`,
    subtitle: fmtEur(row.totals.gross_cents),
    badge: BADGE[row.status],
    tone: row.status === 'partially_delivered' ? 'warn' : 'neutral',
    at: row.order_date,
    href: `/orders/${row.id}`,
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

  // Narrowed by the order date — the day the customer committed.
  let orders = listOrders(db);
  if (context.from !== undefined) orders = orders.filter((row) => row.order_date >= context.from!);
  if (context.to !== undefined) orders = orders.filter((row) => row.order_date <= context.to!);
  const toDeliver = orders.filter((row) => row.status === 'open' || row.status === 'partially_delivered');
  const { n: unbilled } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM delivery_notes dn JOIN orders o ON o.id = dn.order_id
        WHERE dn.invoiced_at IS NULL AND (? IS NULL OR o.order_date >= ?) AND (? IS NULL OR o.order_date <= ?)`,
    )
    .get(context.from ?? null, context.from ?? null, context.to ?? null, context.to ?? null) as { n: number };

  return {
    summary_version: SUMMARY_VERSION,
    module: MODULE_ID,
    generated_at: now().toISOString(),
    tiles: [
      { key: 'to_deliver', label: 'To deliver', value: String(toDeliver.length), unit: 'orders', tone: toDeliver.length > 0 ? 'warn' : 'good', href: '/orders' },
      { key: 'not_invoiced', label: 'Not invoiced', value: String(unbilled), unit: 'delivery notes', tone: unbilled > 0 ? 'warn' : 'good', href: '/orders' },
    ],
    lists: [{ key: 'to_deliver_list', label: 'Orders to deliver', items: toDeliver.slice(0, LIST_LIMIT).map(item), href: '/orders' }],
    context: { supported: SUPPORTED, applied },
  };
}
