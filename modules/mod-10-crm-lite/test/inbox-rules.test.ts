import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import type { People, PersonEvent } from '../server/people.js';

let db: Database.Database;
let sent: PersonEvent[];
const people: People = { enabled: true, notify: (e) => void sent.push(e), flush: async () => {} };
const T = '2026-11-09T09:00:00Z';
const NOW = Date.parse(T);
import { collectInbox, watchCrm } from '../server/inbox-rules.js';
import { assignDeal, dealOwner } from '../server/deals.js';

/** MOD-10's notification rules: a deal handed over, follow-ups due. */

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO companies (id, name, created_at) VALUES (1, 'Kunde GmbH', ?)").run(T);
  db.prepare("INSERT INTO deals (id, title, company_id, stage, created_at) VALUES (1, 'Rollout', 1, 'lead', ?)").run(T);
  sent = [];
  watchCrm(db, people, NOW);
});

describe('MOD-10', () => {
  it('a deal handed to someone tells them now; the owner is derived from the hand-overs', () => {
    assignDeal(db, 1, 'ada@acme.test', 'boss@acme.test', T);
    expect(dealOwner(db, 1)).toBe('ada@acme.test');
    expect(() => assignDeal(db, 1, 'ada@acme.test', 'boss@acme.test', T)).toThrow();
    watchCrm(db, people, NOW);
    expect(sent).toEqual([expect.objectContaining({ kind: 'deal-assigned', recipients: ['ada@acme.test'], actor: 'boss@acme.test', urgency: 'now' })]);
  });

  it('a follow-up due today is in the morning briefing once, and waits; an overdue one only waits', () => {
    const add = (due: string) =>
      db.prepare("INSERT INTO activities (type, subject, deal_id, due_date, done, created_at, owner) VALUES ('call', 'Call back', 1, ?, 0, ?, 'ada@acme.test')").run(due, T);
    add('2026-11-09');
    add('2026-11-05');
    watchCrm(db, people, NOW);
    expect(sent.map((e) => e.kind)).toEqual(['followup-due']);
    expect(collectInbox(db, 'ada@acme.test', 'view', NOW).items.map((i) => i.tone)).toEqual(['bad', 'warn']);
    expect(collectInbox(db, 'bob@acme.test', 'view', NOW).count).toBe(0);
  });
});
