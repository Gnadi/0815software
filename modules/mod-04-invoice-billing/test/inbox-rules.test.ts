import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import type { People, PersonEvent } from '../server/people.js';

let db: Database.Database;
let sent: PersonEvent[];
const people: People = { enabled: true, notify: (e) => void sent.push(e), flush: async () => {} };
const T = '2026-11-09T09:00:00Z';
const NOW = Date.parse(T);
import { collectInbox, watchInvoicing } from '../server/inbox-rules.js';

/** MOD-04's notification rules: incoming invoices due, payment runs for a second pair of eyes. */

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO creditors (id, name, iban, created_at) VALUES (1, 'Papier AG', 'AT611904300234573201', ?)").run(T);
  sent = [];
  watchInvoicing(db, people, NOW);
});

describe('MOD-04', () => {
  it('an incoming invoice due tomorrow is told once to the desk, and waits in the inbox', () => {
    db.prepare("INSERT INTO bills (creditor_id, reference, amount_cents, due_date, created_at) VALUES (1, 'R-77', 12000, '2026-11-10', ?)").run(T);
    watchInvoicing(db, people, NOW);
    watchInvoicing(db, people, NOW + 60_000);
    const due = sent.filter((e) => e.kind === 'bill-due');
    expect(new Set(due.map((e) => e.key)).size).toBe(1);
    expect(due[0]).toMatchObject({ holders: 'edit', urgency: 'digest' });
    expect(collectInbox(db, 'ada@acme.test', 'edit', '2026-11-09').items.map((i) => i.kind)).toEqual(['due']);
    expect(collectInbox(db, 'ada@acme.test', 'view', '2026-11-09').count).toBe(0);
  });

  it('a payment run waits for someone OTHER than who prepared it', () => {
    db.prepare(
      "INSERT INTO payment_runs (message_id, execution_date, debtor_name, debtor_iban, created_by, created_at) VALUES ('RUN-1', '2026-11-10', 'Acme', 'AT611904300234573201', 'ada@acme.test', ?)",
    ).run(T);
    watchInvoicing(db, people, NOW);
    expect(sent.find((e) => e.kind === 'payment-run')).toMatchObject({ holders: 'manage', actor: 'ada@acme.test' });
    expect(collectInbox(db, 'boss@acme.test', 'manage', '2026-11-09').items.map((i) => i.id)).toEqual(['run-1']);
    expect(collectInbox(db, 'ada@acme.test', 'manage', '2026-11-09').items).toEqual([]);
  });
});
