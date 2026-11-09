import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import type { InboxItem } from '../shared/summary.js';
import type { People } from './people.js';
import { consume } from './watch.js';
import { mayAct } from './inbox.js';

/**
 * What waits for dispatch in orders and delivery, and whom a new order
 * concerns (docs/NOTIFICATIONS-PLAN.md, MOD-17).
 *
 *  - Waits for dispatch (`edit`): open orders with something still to
 *    deliver — what is left is derived, ordered minus delivered, per line.
 *  - Notified: a confirmed order (typed in, or arriving from an accepted
 *    offer), to everyone at `edit`, now.
 *
 * Not here, because this module does not record them: tours per driver and
 * failed or late deliveries. They come with a tour plan, not before.
 */

interface Open {
  id: number;
  number: string;
  customer_name: string;
  order_date: string;
  open_lines: number;
}

function toDeliver(db: Database.Database): Open[] {
  return db
    .prepare(
      `SELECT o.id, o.number, o.customer_name, o.order_date,
              SUM(CASE WHEN l.quantity > COALESCE(d.delivered, 0) THEN 1 ELSE 0 END) AS open_lines
         FROM orders o
         JOIN order_lines l ON l.order_id = o.id
         LEFT JOIN (SELECT order_line_id, SUM(quantity) AS delivered FROM delivery_note_lines GROUP BY order_line_id) d
                ON d.order_line_id = l.id
        WHERE o.status = 'open'
        GROUP BY o.id
       HAVING open_lines > 0
        ORDER BY o.order_date, o.id`,
    )
    .all() as Open[];
}

export function collectInbox(db: Database.Database, _person: string, level: AccessLevel): { count: number; items: InboxItem[] } {
  if (!mayAct(level, 'edit')) return { count: 0, items: [] };
  const items = toDeliver(db).map<InboxItem>((o) => ({
    id: o.number,
    kind: 'to-deliver',
    title: 'An order waits to be delivered',
    detail: `${o.number} · ${o.customer_name} · ${o.open_lines} line${o.open_lines === 1 ? '' : 's'} open`,
    tone: 'neutral',
    at: o.order_date,
    href: `/orders/${o.id}`,
  }));
  return { count: items.length, items };
}

export function watchOrders(db: Database.Database, people: People): void {
  consume<{ id: number; order_id: number; type: string; detail: string | null; actor: string }>(db, 'order_events', 'order_events', (ev) => {
    if (ev.type !== 'confirmed') return;
    const o = db.prepare('SELECT number, customer_name FROM orders WHERE id = ?').get(ev.order_id) as { number: string; customer_name: string };
    people.notify({
      kind: 'order-new',
      category: 'assignments',
      urgency: 'now',
      holders: 'edit',
      actor: ev.actor,
      title: 'A new order waits for dispatch',
      detail: `${o.number} · ${o.customer_name}${ev.detail ? ` · ${ev.detail}` : ''}`,
      href: `/orders/${ev.order_id}`,
      key: `order:${ev.id}`,
    });
  });
}
