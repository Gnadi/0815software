import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import { collectInbox, watchProcurement } from '../server/inbox-rules.js';
import { writeMatchSettings, readMatchSettings } from '../server/receiving.js';
import type { People, PersonEvent } from '../server/people.js';

/** MOD-06's notification rules: approvers hear of a PO — at once from the administrator's amount — the submitter of the outcome. */

let db: Database.Database;
let sent: PersonEvent[];
const people: People = { enabled: true, notify: (e) => void sent.push(e), flush: async () => {} };
const T = '2026-11-09T09:00:00Z';

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO suppliers (id, name, created_at) VALUES (1, 'Papier AG', ?)").run(T);
  sent = [];
  watchProcurement(db, people);
});

function submitted(totalCents: number, tiers: number[], by = 'ada@acme.test'): number {
  const id = Number(
    db.prepare("INSERT INTO purchase_orders (number, supplier_id, status, submission_no, created_at) VALUES (?, 1, 'submitted', 1, ?)").run(`PO-${Math.random()}`, T).lastInsertRowid,
  );
  db.prepare('INSERT INTO po_submissions (po_id, submission_no, total_cents, required_tiers, created_at, submitted_by) VALUES (?, 1, ?, ?, ?, ?)').run(
    id,
    totalCents,
    JSON.stringify(tiers),
    T,
    by,
  );
  return id;
}

describe('MOD-06 notifications', () => {
  it('a submission waits for the digest — until the administrator sets an amount from which it is told at once', () => {
    submitted(500_00, [1]);
    watchProcurement(db, people);
    expect(sent[0]).toMatchObject({ kind: 'po-submitted', holders: 'manage', urgency: 'digest', actor: 'ada@acme.test' });

    writeMatchSettings(db, { ...readMatchSettings(db), notify_now_from_cents: 5_000_00 }, 'admin@acme.test');
    submitted(4_999_99, [1, 2]);
    submitted(5_000_00, [1, 2]);
    watchProcurement(db, people);
    expect(sent.slice(1).map((e) => e.urgency)).toEqual(['digest', 'now']);
  });

  it('the submitter hears of a rejection, and of the LAST tier’s approval — not of each tier', () => {
    const id = submitted(20_000_00, [1, 2, 3]);
    watchProcurement(db, people);
    sent = [];
    const approve = (tier: number, decision = 'approved') =>
      db.prepare('INSERT INTO approvals (po_id, submission_no, tier, decision, approver, created_at) VALUES (?, 1, ?, ?, ?, ?)').run(id, tier, decision, 'boss@acme.test', T);
    approve(1);
    approve(2);
    watchProcurement(db, people);
    expect(sent).toEqual([]);
    approve(3);
    watchProcurement(db, people);
    expect(sent).toEqual([expect.objectContaining({ kind: 'po-approved', recipients: ['ada@acme.test'], urgency: 'now' })]);
  });
});

describe('MOD-06 inbox', () => {
  it('an approver sees what waits for the next tier, never their own submission', () => {
    submitted(500_00, [1]);
    submitted(500_00, [1], 'boss@acme.test');
    expect(collectInbox(db, 'boss@acme.test', 'manage').count).toBe(1);
    expect(collectInbox(db, 'boss@acme.test', 'edit').count).toBe(0);
  });
});
