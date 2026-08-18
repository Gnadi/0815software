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
import { listOrders } from './store.js';
import type { OrderRow } from '../shared/types.js';

/**
 * What MOD-07 tells a shell about itself.
 *
 * Unlike MOD-01 and MOD-09 — the other two modules whose end users are not
 * staff — this one does carry lists. Its shoppers are the shop's own customers
 * and its orders are already visible to whoever runs the shop through its admin
 * screens, so putting them on a staff board discloses nothing that staff cannot
 * already see. There is no per-user access rule here for a shell to bypass.
 *
 * It is still not embeddable: the storefront's session belongs to a shopper,
 * and a staff shell has no such principal to assert.
 */

export const MODULE_ID = 'mod-07-storefront';

/**
 * The context this module can narrow by.
 *
 * `party` is absent: a shopper is an email address on an order, not a PS-11
 * party, so there is no shared id to filter on.
 */
const SUPPORTED: ContextFilter[] = ['from', 'to'];

const LIST_LIMIT = 8;

function orderItem(order: OrderRow): SummaryItem {
  return {
    id: order.ref,
    title: `${order.ref} · ${order.customer_name}`,
    subtitle: `${order.item_count} items · ${fmtEur(order.gross_cents)}`,
    badge: order.payment_status === 'paid' ? order.status.toUpperCase() : 'UNPAID',
    tone: order.payment_status === 'paid' ? 'good' : 'warn',
    at: order.created_at,
    href: `/admin/orders/${order.id}`,
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

  let orders = listOrders(db);
  if (context.from !== undefined) orders = orders.filter((o) => o.created_at.slice(0, 10) >= context.from!);
  if (context.to !== undefined) orders = orders.filter((o) => o.created_at.slice(0, 10) <= context.to!);

  const live = orders.filter((o) => o.status !== 'cancelled');
  const unpaid = live.filter((o) => o.payment_status === 'unpaid');
  const toShip = live.filter((o) => o.status === 'placed' || o.status === 'confirmed');
  // Cancelled orders are excluded: revenue is what the shop actually took.
  const revenue = live.filter((o) => o.payment_status === 'paid').reduce((acc, o) => acc + o.gross_cents, 0);

  return {
    summary_version: SUMMARY_VERSION,
    module: MODULE_ID,
    generated_at: now().toISOString(),
    tiles: [
      {
        key: 'orders',
        label: 'Orders',
        value: String(live.length),
        unit: null,
        tone: 'neutral',
        href: '/admin/orders',
      },
      {
        key: 'revenue',
        label: 'Paid revenue',
        value: fmtEur(revenue),
        unit: null,
        tone: 'good',
        href: '/admin/orders',
      },
      {
        key: 'unpaid',
        label: 'Unpaid',
        value: String(unpaid.length),
        unit: 'orders',
        tone: unpaid.length > 0 ? 'bad' : 'good',
        href: '/admin/orders',
      },
      {
        key: 'to_ship',
        label: 'To ship',
        value: String(toShip.length),
        unit: 'orders',
        tone: toShip.length > 0 ? 'warn' : 'good',
        href: '/admin/orders',
      },
    ],
    lists: [
      {
        key: 'recent_orders',
        label: 'Latest orders',
        items: orders.slice(0, LIST_LIMIT).map(orderItem),
        href: '/admin/orders',
      },
    ],
    context: { supported: SUPPORTED, applied },
  };
}
