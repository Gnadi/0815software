import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import type { InboxItem } from '../shared/summary.js';
import type { People } from './people.js';
import { consume } from './watch.js';
import { mayAct } from './inbox.js';
import { stockOverview } from './ledger.js';

/**
 * What waits for purchasing and the store in inventory, and when they hear
 * of it (docs/NOTIFICATIONS-PLAN.md, MOD-03).
 *
 *  - Waits (`edit`): articles below their reorder point — the same `low`
 *    the stock list derives.
 *  - Notified, in the digest: an article falling below its reorder point,
 *    told on the movement that took it there; and a stock correction
 *    (`adjustment`) — a count that disagreed with the books — to the
 *    `manage` holders.
 */

export function collectInbox(db: Database.Database, _person: string, level: AccessLevel): { count: number; items: InboxItem[] } {
  if (!mayAct(level, 'edit')) return { count: 0, items: [] };
  const items = stockOverview(db)
    .filter((row) => row.low)
    .map<InboxItem>((row) => ({
      id: row.sku,
      kind: 'low-stock',
      title: 'An article is below its reorder point',
      detail: `${row.sku} · ${row.name} · ${row.available} ${row.unit} left, reorder at ${row.reorder_point}`,
      tone: row.available <= 0 ? 'bad' : 'warn',
      at: null,
      href: `/products/${row.id}`,
    }));
  return { count: items.length, items };
}

export function watchInventory(db: Database.Database, people: People): void {
  const touched = new Set<number>();
  consume<{ id: number; product_id: number; type: string; quantity: number; actor?: string }>(db, 'movements', 'movements', (m) => {
    touched.add(m.product_id);
    if (m.type === 'adjustment') {
      const p = db.prepare('SELECT sku, name, unit FROM products WHERE id = ?').get(m.product_id) as { sku: string; name: string; unit: string };
      people.notify({
        kind: 'stock-corrected',
        category: 'alerts',
        urgency: 'digest',
        holders: 'manage',
        title: 'Stock was corrected after a count',
        detail: `${p.sku} · ${p.name} · ${m.quantity > 0 ? '+' : ''}${m.quantity} ${p.unit}`,
        href: `/products/${m.product_id}`,
        key: `adjust:${m.id}`,
      });
    }
  });
  if (touched.size === 0) return;
  for (const row of stockOverview(db).filter((r) => r.low && touched.has(r.id))) {
    const last = (db.prepare('SELECT MAX(id) AS id FROM movements WHERE product_id = ?').get(row.id) as { id: number }).id;
    people.notify({
      kind: 'low-stock',
      category: 'alerts',
      urgency: 'digest',
      holders: 'edit',
      title: 'An article fell below its reorder point',
      detail: `${row.sku} · ${row.name} · ${row.available} ${row.unit} left, reorder at ${row.reorder_point}`,
      href: `/products/${row.id}`,
      key: `low:${row.id}:${last}`,
    });
  }
}
