import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import type { People, PersonEvent } from '../server/people.js';

let db: Database.Database;
let sent: PersonEvent[];
const people: People = { enabled: true, notify: (e) => void sent.push(e), flush: async () => {} };
const T = '2026-11-09T09:00:00Z';
const NOW = Date.parse(T);
import { collectInbox, watchShop } from '../server/inbox-rules.js';

/** MOD-07's notification rule: every new shop order, now and at any hour, to the named recipients. */

const STAFF = ['shop@acme.test'];

beforeEach(() => {
  db = openDb(':memory:');
  sent = [];
  watchShop(db, people, STAFF);
});

describe('MOD-07', () => {
  it('a placed order reaches the shop staff now, through quiet hours, and waits to be confirmed', () => {
    db.prepare("INSERT INTO orders (id, ref, status, customer_name, email, address, created_at) VALUES (1, 'SO-1', 'placed', 'Kim', 'kim@x.test', 'Street 1', ?)").run(T);
    db.prepare("INSERT INTO order_events (order_id, status, at) VALUES (1, 'placed', ?)").run(T);
    watchShop(db, people, STAFF);
    expect(sent).toEqual([expect.objectContaining({ kind: 'shop-order', recipients: STAFF, urgency: 'now', oncall: true })]);
    expect(collectInbox(db, 'shop@acme.test', 'view', STAFF).count).toBe(1);
    expect(collectInbox(db, 'someone@acme.test', 'manage', STAFF).count).toBe(0);
  });
});
