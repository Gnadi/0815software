import { beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../server/db.js';
import { addComment, assignTicket, createTicket } from '../server/tickets.js';
import { collectInbox, watchTickets } from '../server/inbox-rules.js';
import type { People, PersonEvent } from '../server/people.js';

/** MOD-12's notification rules (docs/NOTIFICATIONS-PLAN.md): who hears what, and what waits for whom. */

let db: Database.Database;
let sent: PersonEvent[];
const people: People = { enabled: true, notify: (e) => void sent.push(e), flush: async () => {} };
const NOW = Date.parse('2026-11-09T10:00:00Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();

beforeEach(() => {
  db = openDb(':memory:');
  db.prepare("INSERT INTO agents (name, email, created_at) VALUES ('Ada', 'ada@acme.test', ?), ('Bob', 'bob@acme.test', ?)").run(at(-100), at(-100));
  sent = [];
  watchTickets(db, people, NOW); // first read: starts at the end of the log
});

const ticket = (minutesAgo: number, priority: 'urgent' | 'normal' = 'normal') =>
  createTicket(db, { requesterName: 'Kim', requesterEmail: 'kim@customer.test', subject: 'Printer on fire', body: '…', priority, channel: 'web', actor: 'kim@customer.test', actorType: 'requester', at: at(-minutesAgo) });

describe('MOD-12 notifications', () => {
  it('a new ticket nobody holds goes to everyone who may edit, in the digest', () => {
    const ref = ticket(1);
    watchTickets(db, people, NOW);
    expect(sent).toEqual([expect.objectContaining({ kind: 'ticket-new', holders: 'edit', urgency: 'digest', detail: `${ref} · Printer on fire` })]);
  });

  it('an assignment reaches the assignee now — and not the agent who assigned it to themselves', () => {
    const ref = ticket(1);
    assignTicket(db, ref, 1, 'bob@acme.test', at(0));
    assignTicket(db, ref, 2, 'bob@acme.test', at(0));
    watchTickets(db, people, NOW);
    const assigned = sent.filter((e) => e.kind === 'ticket-assigned');
    expect(assigned.map((e) => [e.recipients, e.actor, e.urgency])).toEqual([
      [['ada@acme.test'], 'bob@acme.test', 'now'],
      [['bob@acme.test'], 'bob@acme.test', 'now'], // dropped later by people.ts: the actor is never told
    ]);
  });

  it('a requester’s reply reaches the assignee now', () => {
    const ref = ticket(5);
    assignTicket(db, ref, 1, 'bob@acme.test', at(-1));
    watchTickets(db, people, NOW);
    sent = [];
    addComment(db, ref, { body: 'still burning', visibility: 'public', actor: 'kim@customer.test', actorType: 'requester', at: at(0) });
    watchTickets(db, people, NOW);
    expect(sent.find((e) => e.kind === 'ticket-reply')).toMatchObject({ recipients: ['ada@acme.test'], urgency: 'now', category: 'replies' });
  });

  it('an SLA about to break is told once, on call; a broken one again, once', () => {
    const ref = ticket(25, 'urgent'); // urgent: first response in 30 minutes
    assignTicket(db, ref, 1, 'bob@acme.test', at(-20));
    watchTickets(db, people, NOW);
    const risk = sent.filter((e) => e.kind === 'sla-at-risk');
    expect(risk.length).toBeGreaterThan(0);
    expect(risk[0]).toMatchObject({ recipients: ['ada@acme.test'], oncall: true, urgency: 'now' });
    // Same key on the next pass: PS-03 keeps it to one notification.
    const keys = new Set(risk.map((e) => e.key));
    sent = [];
    watchTickets(db, people, NOW + 60_000);
    expect(sent.filter((e) => e.kind === 'sla-at-risk').every((e) => keys.has(e.key))).toBe(true);
    sent = [];
    watchTickets(db, people, NOW + 10 * 60_000);
    expect(sent.some((e) => e.kind === 'sla-breached')).toBe(true);
  });
});

describe('MOD-12 inbox', () => {
  it('an agent sees their open tickets; someone who may edit also sees the untaken ones; a viewer only their own', () => {
    const mine = ticket(10);
    const free = ticket(5);
    assignTicket(db, mine, 1, 'bob@acme.test', at(-1));
    expect(collectInbox(db, 'ada@acme.test', 'edit', NOW).items.map((i) => [i.id, i.kind])).toEqual([
      [mine, 'assigned'],
      [free, 'unassigned'],
    ]);
    expect(collectInbox(db, 'ada@acme.test', 'view', NOW).items.map((i) => i.id)).toEqual([mine]);
    expect(collectInbox(db, 'nobody@acme.test', 'view', NOW).count).toBe(0);
  });
});
