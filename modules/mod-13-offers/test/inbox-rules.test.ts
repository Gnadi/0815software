import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import type { People, PersonEvent } from '../server/people.js';

let db: Database.Database;
let sent: PersonEvent[];
const people: People = { enabled: true, notify: (e) => void sent.push(e), flush: async () => {} };
const T = '2026-11-09T09:00:00Z';
const NOW = Date.parse(T);
import { collectInbox, watchOffers } from '../server/inbox-rules.js';

/** MOD-13's notification rules: the customer's answer, and an offer about to lapse — to whoever sent it. */

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO customers (id, name, created_at) VALUES (1, 'Kunde GmbH', ?)").run(T);
  db.prepare("INSERT INTO offers (id, number, customer_id, title, status, valid_until, sent_at, created_at) VALUES (1, 'AN-1', 1, 'Rollout', 'sent', '2026-11-11', ?, ?)").run(T, T);
  db.prepare("INSERT INTO offer_events (offer_id, event, actor, created_at) VALUES (1, 'sent', 'ada@acme.test', ?)").run(T);
  sent = [];
  watchOffers(db, people, NOW);
});

describe('MOD-13', () => {
  it('an acceptance reaches the sender now', () => {
    sent = [];
    db.prepare("INSERT INTO offer_events (offer_id, event, actor, created_at) VALUES (1, 'accepted', 'customer', ?)").run(T);
    watchOffers(db, people, NOW);
    expect(sent.find((e) => e.kind === 'offer-accepted')).toMatchObject({ recipients: ['ada@acme.test'], urgency: 'now' });
  });

  it('an offer two days from lapsing is in the sender’s digest and inbox', () => {
    expect(sent.find((e) => e.kind === 'offer-expiring')).toMatchObject({ recipients: ['ada@acme.test'], urgency: 'digest' });
    expect(collectInbox(db, 'ada@acme.test', 'view', NOW).items.map((i) => i.id)).toEqual(['AN-1']);
    expect(collectInbox(db, 'bob@acme.test', 'manage', NOW).count).toBe(0);
  });
});
