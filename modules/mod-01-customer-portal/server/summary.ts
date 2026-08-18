import type Database from 'better-sqlite3';
import {
  appliedFilters,
  SUMMARY_VERSION,
  type ContextFilter,
  type ModuleSummary,
  type SummaryContext,
} from '../shared/summary.js';
import { ORDER_STATUSES } from '../shared/types.js';

/**
 * What MOD-01 tells a shell about itself.
 *
 * **Counts only — deliberately no lists.**
 *
 * This module's defining correctness property is strict tenant isolation:
 * every query is scoped to the signed-in customer, and asking for anyone
 * else's order returns 404. A shell holding the stack's machine token has no
 * customer, so any list it could be handed would be a list assembled across
 * every customer at once — precisely the thing the rest of this module exists
 * to make impossible. Aggregate counts carry no one customer's data, so they
 * are what a board gets.
 *
 * It is also why this module is not embeddable: its users are portal customers,
 * not staff, so a staff shell has no principal to sign in as
 * (docs/PLATFORM-READINESS.md, item C1). The Workspace shows these figures and
 * links out.
 */

export const MODULE_ID = 'mod-01-customer-portal';

/**
 * The context this module can narrow by.
 *
 * `party` is absent: portal customers are this module's own accounts, not
 * PS-11 parties, so there is no shared id to filter on. Dates are honoured
 * against the order date.
 */
const SUPPORTED: ContextFilter[] = ['from', 'to'];

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

  const where: string[] = [];
  const params: string[] = [];
  if (context.from !== undefined) {
    where.push('substr(placed_at, 1, 10) >= ?');
    params.push(context.from);
  }
  if (context.to !== undefined) {
    where.push('substr(placed_at, 1, 10) <= ?');
    params.push(context.to);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const byStatus = db
    .prepare(`SELECT status, COUNT(*) AS n FROM orders ${clause} GROUP BY status`)
    .all(...params) as { status: string; n: number }[];
  const counts = new Map(byStatus.map((row) => [row.status, row.n]));
  const total = byStatus.reduce((acc, row) => acc + row.n, 0);

  const customers = (db.prepare('SELECT COUNT(*) AS n FROM customers').get() as { n: number }).n;
  const documents = (db.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n: number }).n;
  // Everything that has not reached a terminal state — what someone is still
  // waiting on.
  const inFlight = ORDER_STATUSES.filter((s) => s !== 'delivered' && s !== 'cancelled').reduce(
    (acc, status) => acc + (counts.get(status) ?? 0),
    0,
  );

  return {
    summary_version: SUMMARY_VERSION,
    module: MODULE_ID,
    generated_at: now().toISOString(),
    tiles: [
      {
        key: 'customers',
        label: 'Portal accounts',
        value: String(customers),
        unit: null,
        tone: 'neutral',
        href: '/',
      },
      {
        key: 'orders',
        label: 'Orders',
        value: String(total),
        unit: null,
        tone: 'neutral',
        href: '/',
      },
      {
        key: 'in_flight',
        label: 'Orders in flight',
        value: String(inFlight),
        unit: 'not delivered',
        tone: inFlight > 0 ? 'warn' : 'good',
        href: '/',
      },
      {
        key: 'documents',
        label: 'Documents shared',
        value: String(documents),
        unit: null,
        tone: 'neutral',
        href: '/',
      },
    ],
    lists: [],
    context: { supported: SUPPORTED, applied },
  };
}
