import type Database from 'better-sqlite3';
import {
  appliedFilters,
  SUMMARY_VERSION,
  type ContextFilter,
  type ModuleSummary,
  type SummaryContext,
  type SummaryItem,
} from '../shared/summary.js';
import { stockOverview } from './ledger.js';
import { listPurchaseOrders } from './purchase-orders.js';
import type { PurchaseOrder, StockRow } from '../shared/types.js';

/**
 * What MOD-03 tells a shell about itself.
 *
 * Everything MOD-03-specific stays here: the consumer gets figures, short lists
 * and paths, and nothing about warehouses, movement types or how stock is
 * derived. The numbers come from `stockOverview` and `listPurchaseOrders` — the
 * same functions the module's own screens read — so a widget cannot disagree
 * with the module.
 */

export const MODULE_ID = 'mod-03-inventory-management';

/**
 * The context this module can narrow by.
 *
 * `party` is deliberately absent. This module's counterparties are SUPPLIERS,
 * and they are not resolved against PS-11, so it has no column to filter a
 * customer on. Claiming support and quietly ignoring the filter is exactly what
 * `context.applied` exists to prevent — a board narrowed to one customer would
 * show this module's stock for everyone and label it as narrowed.
 */
const SUPPORTED: ContextFilter[] = ['from', 'to'];

/** How many rows a list widget carries. A board shows excerpts, not tables. */
const LIST_LIMIT = 8;

function stockItem(row: StockRow): SummaryItem {
  return {
    id: row.sku,
    title: `${row.sku} · ${row.name}`,
    subtitle: `${row.total} ${row.unit} · reorder at ${row.reorder_point}`,
    badge: row.low ? 'LOW' : 'OK',
    tone: row.low ? 'bad' : 'good',
    at: null,
    href: `/products/${row.id}`,
  };
}

function poItem(po: PurchaseOrder): SummaryItem {
  return {
    id: po.po_number,
    title: `${po.po_number} · ${po.supplier_name}`,
    subtitle: null,
    badge: po.status.replace(/_/g, ' ').toUpperCase(),
    tone: po.status === 'received' ? 'good' : 'warn',
    at: po.created_at,
    href: `/purchase-orders/${po.id}`,
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

  // What this response was narrowed by. A filter counts as applied when it
  // RAN, not when it matched — empty-because-filtered is a true answer, and
  // what this echo prevents is a filter the shell sent, this module ignored,
  // and the board then labelled as narrowed.
  const applied = appliedFilters(context, SUPPORTED);

  const stock = stockOverview(db);
  let orders = listPurchaseOrders(db);

  // Stock is a level, not an event: it has no date to filter on, so a date
  // range narrows the purchase orders and leaves the stock figures alone.
  // `applied` still names the filter, because it did run — on the half of this
  // summary that has dates.
  if (context.from !== undefined) orders = orders.filter((po) => po.created_at.slice(0, 10) >= context.from!);
  if (context.to !== undefined) orders = orders.filter((po) => po.created_at.slice(0, 10) <= context.to!);

  const low = stock.filter((row) => row.low);
  const open = orders.filter((po) => po.status !== 'received');
  const awaiting = orders.filter((po) => po.status === 'ordered' || po.status === 'partially_received');

  return {
    summary_version: SUMMARY_VERSION,
    module: MODULE_ID,
    generated_at: now().toISOString(),
    tiles: [
      {
        key: 'low_stock',
        label: 'Below reorder point',
        value: String(low.length),
        unit: 'products',
        tone: low.length > 0 ? 'bad' : 'good',
        href: '/products?filter=low',
      },
      {
        key: 'products',
        label: 'Products',
        value: String(stock.length),
        unit: 'tracked',
        tone: 'neutral',
        href: '/products',
      },
      {
        key: 'open_orders',
        label: 'Purchase orders open',
        value: String(open.length),
        unit: 'not received',
        tone: open.length > 0 ? 'warn' : 'neutral',
        href: '/purchase-orders',
      },
      {
        key: 'awaiting_delivery',
        label: 'Awaiting delivery',
        value: String(awaiting.length),
        unit: 'ordered',
        tone: 'neutral',
        href: '/purchase-orders',
      },
    ],
    lists: [
      {
        key: 'low_stock_items',
        label: 'Reorder these',
        // Deepest shortfall first: the point of the widget is what to do next,
        // and a list sorted by SKU would bury the urgent ones.
        items: [...low]
          .sort((a, b) => a.total - a.reorder_point - (b.total - b.reorder_point))
          .slice(0, LIST_LIMIT)
          .map(stockItem),
        href: '/products?filter=low',
      },
      {
        key: 'open_purchase_orders',
        label: 'Purchase orders in flight',
        items: open.slice(0, LIST_LIMIT).map(poItem),
        href: '/purchase-orders',
      },
    ],
    context: { supported: SUPPORTED, applied },
  };
}
