import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import type { People, PersonEvent } from '../server/people.js';

let db: Database.Database;
let sent: PersonEvent[];
const people: People = { enabled: true, notify: (e) => void sent.push(e), flush: async () => {} };
const T = '2026-11-09T09:00:00Z';
const NOW = Date.parse(T);
import { collectInbox, watchOrders } from '../server/inbox-rules.js';

/** MOD-17's notification rules: a confirmed order reaches dispatch; what is left to deliver waits. */

beforeEach(() => {
  db = openDb(':memory:');
  sent = [];
  watchOrders(db, people);
});

describe('MOD-17', () => {
  it('a confirmed order goes to dispatch now, and waits until every line is delivered', () => {
    db.prepare("INSERT INTO orders (id, number, order_date, customer_name, created_at, created_by) VALUES (1, 'AU-1', '2026-11-09', 'Kunde GmbH', ?, 'ada@acme.test')").run(T);
    db.prepare("INSERT INTO order_lines (id, order_id, position, description, quantity, unit_price_cents, vat_rate) VALUES (1, 1, 1, 'Paper', 10, 500, 20)").run();
    db.prepare("INSERT INTO order_events (order_id, type, actor, at) VALUES (1, 'confirmed', 'ada@acme.test', ?)").run(T);
    watchOrders(db, people);
    expect(sent).toEqual([expect.objectContaining({ kind: 'order-new', holders: 'edit', urgency: 'now', actor: 'ada@acme.test' })]);
    expect(collectInbox(db, 'bob@acme.test', 'edit').items.map((i) => i.id)).toEqual(['AU-1']);
    db.prepare("INSERT INTO delivery_notes (id, number, order_id, delivered_on, created_at, created_by) VALUES (1, 'LS-1', 1, '2026-11-09', ?, 'bob@acme.test')").run(T);
    db.prepare('INSERT INTO delivery_note_lines (delivery_note_id, order_line_id, quantity) VALUES (1, 1, 10)').run();
    expect(collectInbox(db, 'bob@acme.test', 'edit').count).toBe(0);
  });
});
