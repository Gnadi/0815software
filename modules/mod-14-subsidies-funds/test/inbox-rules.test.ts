import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import type { People, PersonEvent } from '../server/people.js';

let db: Database.Database;
let sent: PersonEvent[];
const people: People = { enabled: true, notify: (e) => void sent.push(e), flush: async () => {} };
const T = '2026-11-09T09:00:00Z';
const NOW = Date.parse(T);
import { collectInbox, watchSubsidies } from '../server/inbox-rules.js';

/** MOD-14's notification rules: deadlines, 14 and 3 days ahead and once they have passed. */

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO programs (id, name, funding_body, category, funding_rate, max_grant_cents, created_at) VALUES (1, 'Digital', 'FFG', 'digital', 50, 1000000, ?)").run(T);
  db.prepare(
    "INSERT INTO applications (id, ref, program_id, title, status, eligible_costs_cents, requested_amount_cents, approved_amount_cents, created_at) VALUES (1, 'FA-1', 1, 'Shop', 'approved', 100000, 50000, 50000, ?)",
  ).run(T);
  db.prepare("INSERT INTO application_events (application_id, type, to_status, actor, created_at) VALUES (1, 'created', 'draft', 'ada@acme.test', ?)").run(T);
  sent = [];
});

const obligation = (due: string) =>
  db.prepare("INSERT INTO obligations (application_id, title, due_date, done, created_at) VALUES (1, 'Proof of use', ?, 0, ?)").run(due, T);

describe('MOD-14', () => {
  it('a deadline within three days goes to the person responsible; a passed one to the managers too, now', () => {
    obligation('2026-11-11');
    obligation('2026-11-01');
    watchSubsidies(db, people, NOW);
    expect(sent.map((e) => [e.kind, e.urgency, e.recipients, e.holders ?? null])).toEqual([
      ['deadline-passed', 'now', ['ada@acme.test'], 'manage'],
      ['deadline-near', 'digest', ['ada@acme.test'], null],
    ]);
  });

  it('the person responsible sees both; another manager only the overdue one', () => {
    obligation('2026-11-11');
    obligation('2026-11-01');
    expect(collectInbox(db, 'ada@acme.test', 'view', NOW).count).toBe(2);
    expect(collectInbox(db, 'boss@acme.test', 'manage', NOW).count).toBe(1);
    expect(collectInbox(db, 'bob@acme.test', 'edit', NOW).count).toBe(0);
  });
});
