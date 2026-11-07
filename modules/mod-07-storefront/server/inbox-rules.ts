import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import type { InboxItem } from '../shared/summary.js';
import type { People } from './people.js';
import { consume } from './watch.js';

/**
 * A shop order is someone's to confirm and ship (docs/NOTIFICATIONS-PLAN.md,
 * MOD-07). The shop signs its staff in itself, so who that is cannot come
 * from PS-01: it is `ORDER_NOTIFY_RECIPIENTS`, the addresses the operator
 * names.
 *
 *  - Waits for them: orders placed and not yet confirmed.
 *  - Notified: every new order, now — also at night, which the business
 *    asked for (an order is a customer waiting), so through quiet hours.
 */

export function collectInbox(db: Database.Database, person: string, _level: AccessLevel, recipients: readonly string[]): { count: number; items: InboxItem[] } {
  if (!recipients.includes(person)) return { count: 0, items: [] };
  const rows = db
    .prepare("SELECT id, ref, customer_name, created_at FROM orders WHERE status = 'placed' ORDER BY created_at")
    .all() as { id: number; ref: string; customer_name: string; created_at: string }[];
  const items = rows.map<InboxItem>((o) => ({
    id: o.ref,
    kind: 'to-confirm',
    title: 'A shop order waits to be confirmed',
    detail: `${o.ref} · ${o.customer_name}`,
    tone: 'neutral',
    at: o.created_at,
    href: `/admin/orders/${o.id}`,
  }));
  return { count: items.length, items };
}

export function watchShop(db: Database.Database, people: People, recipients: readonly string[]): void {
  consume<{ id: number; order_id: number; status: string }>(db, 'order_events', 'order_events', (ev) => {
    if (ev.status !== 'placed') return;
    const o = db
      .prepare('SELECT o.ref, o.customer_name, (SELECT SUM(quantity) FROM order_lines WHERE order_id = o.id) AS items FROM orders o WHERE o.id = ?')
      .get(ev.order_id) as { ref: string; customer_name: string; items: number | null };
    people.notify({
      kind: 'shop-order',
      category: 'assignments',
      urgency: 'now',
      oncall: true,
      recipients: [...recipients],
      title: 'A new shop order',
      detail: `${o.ref} · ${o.customer_name} · ${o.items ?? 0} item(s)`,
      href: `/admin/orders/${ev.order_id}`,
      key: `order:${ev.id}`,
    });
  });
}
