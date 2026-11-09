import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import type { People, PersonEvent } from '../server/people.js';

let db: Database.Database;
let sent: PersonEvent[];
const people: People = { enabled: true, notify: (e) => void sent.push(e), flush: async () => {} };
const T = '2026-11-09T09:00:00Z';
const NOW = Date.parse(T);
import { collectInbox, watchInventory } from '../server/inbox-rules.js';

/** MOD-03's notification rules: an article falling below its reorder point, and a count that disagreed. */

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO warehouses (id, code, name) VALUES (1, 'MAIN', 'Main')").run();
  db.prepare("INSERT INTO products (id, sku, name, reorder_point) VALUES (1, 'PAPER-A4', 'Paper A4', 10)").run();
  db.prepare("INSERT INTO movements (product_id, warehouse_id, type, quantity, created_at) VALUES (1, 1, 'receipt', 50, ?)").run(T);
  sent = [];
  watchInventory(db, people);
});

const move = (type: string, quantity: number) =>
  db.prepare('INSERT INTO movements (product_id, warehouse_id, type, quantity, created_at) VALUES (1, 1, ?, ?, ?)').run(type, quantity, T);

describe('MOD-03', () => {
  it('tells the store, in the digest, on the movement that takes an article below its reorder point', () => {
    move('goods_issue', -30);
    watchInventory(db, people);
    expect(sent).toEqual([]); // 20 left, reorder at 10
    move('goods_issue', -15);
    watchInventory(db, people);
    expect(sent).toEqual([expect.objectContaining({ kind: 'low-stock', holders: 'edit', urgency: 'digest' })]);
    expect(collectInbox(db, 'ada@acme.test', 'edit').items.map((i) => i.id)).toEqual(['PAPER-A4']);
    expect(collectInbox(db, 'ada@acme.test', 'view').count).toBe(0);
  });

  it('a stock correction goes to the managers', () => {
    move('adjustment', -2);
    watchInventory(db, people);
    expect(sent[0]).toMatchObject({ kind: 'stock-corrected', holders: 'manage' });
  });
});
