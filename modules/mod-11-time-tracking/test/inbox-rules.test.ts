import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import { collectInbox, watchTime } from '../server/inbox-rules.js';
import type { People, PersonEvent } from '../server/people.js';

/** MOD-11's notification rules (docs/NOTIFICATIONS-PLAN.md): deciders hear of requests, people of decisions. */

let db: Database.Database;
let sent: PersonEvent[];
const people: People = { enabled: true, notify: (e) => void sent.push(e), flush: async () => {} };
const T = '2026-11-09T09:00:00Z';

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO employees (id, name, email, created_at) VALUES (1, 'Ada', 'ada@acme.test', ?), (2, 'Boss', 'boss@acme.test', ?)").run(T, T);
  sent = [];
  watchTime(db, people);
});

function leave(status = 'requested'): number {
  const id = Number(
    db
      .prepare("INSERT INTO leave_requests (employee_id, type, start_date, end_date, status, created_by, created_at) VALUES (1, 'vacation', '2026-12-22', '2026-12-31', ?, 'ada@acme.test', ?)")
      .run(status, T).lastInsertRowid,
  );
  db.prepare("INSERT INTO leave_events (request_id, type, actor, at) VALUES (?, 'requested', 'ada@acme.test', ?)").run(id, T);
  return id;
}

describe('MOD-11 notifications', () => {
  it('a leave request goes to the deciders in the digest; the decision to the person, now', () => {
    const id = leave();
    watchTime(db, people);
    expect(sent[0]).toMatchObject({ kind: 'leave-requested', holders: 'manage', urgency: 'digest', actor: 'ada@acme.test', category: 'approvals' });
    db.prepare("INSERT INTO leave_events (request_id, type, actor, note, at) VALUES (?, 'approved', 'boss@acme.test', 'enjoy', ?)").run(id, T);
    watchTime(db, people);
    expect(sent[1]).toMatchObject({ kind: 'leave-approved', recipients: ['ada@acme.test'], urgency: 'now', category: 'outcomes' });
    expect(sent[1]!.detail).toContain('enjoy');
  });

  it('a timesheet sent back and a reminder each reach the person once', () => {
    db.prepare("INSERT INTO timesheet_events (employee_id, week_start, action, from_status, to_status, actor, created_at) VALUES (1, '2026-11-02', 'reject', 'submitted', 'draft', 'boss@acme.test', ?)").run(T);
    db.prepare("INSERT INTO reminders_sent (kind, employee_id, ref, to_address, channel, sent_at) VALUES ('timer_running', 1, 't1', 'ada@acme.test', 'mail', ?)").run(T);
    watchTime(db, people);
    expect(sent.map((e) => [e.kind, e.recipients, e.urgency])).toEqual([
      ['week-reject', ['ada@acme.test'], 'now'],
      ['timer-running', ['ada@acme.test'], 'now'],
    ]);
    watchTime(db, people);
    expect(sent).toHaveLength(2);
  });
});

describe('MOD-11 inbox', () => {
  it('a decider sees others’ requests, never their own; someone without manage sees none', () => {
    leave();
    expect(collectInbox(db, 'boss@acme.test', 'manage').items.map((i) => i.kind)).toEqual(['approval']);
    expect(collectInbox(db, 'ada@acme.test', 'manage').items).toEqual([]);
    expect(collectInbox(db, 'boss@acme.test', 'edit').items).toEqual([]);
  });
});
