import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import type { InboxItem } from '../shared/summary.js';
import type { People } from './people.js';
import { consume } from './watch.js';

/**
 * What waits for someone in the CRM, and whom a hand-over concerns
 * (docs/NOTIFICATIONS-PLAN.md, MOD-10).
 *
 *  - Waits: their open follow-ups due today or overdue (the owner is set when
 *    a follow-up is written — the writer, unless someone else was named).
 *  - Notified: a deal handed to them, now; the follow-ups due today, in the
 *    morning briefing — each once per follow-up and due date. Overdue ones
 *    only count on the badge: a reminder every day would be noise.
 */

interface FollowUp {
  id: number;
  subject: string;
  due_date: string;
  owner: string;
  deal_title: string | null;
  contact_name: string | null;
}

function openFollowUps(db: Database.Database, upTo: string): FollowUp[] {
  return db
    .prepare(
      `SELECT a.id, a.subject, a.due_date, lower(a.owner) AS owner, d.title AS deal_title, k.name AS contact_name
         FROM activities a LEFT JOIN deals d ON d.id = a.deal_id LEFT JOIN contacts k ON k.id = a.contact_id
        WHERE a.done = 0 AND a.due_date IS NOT NULL AND a.due_date <= ? AND a.owner IS NOT NULL
        ORDER BY a.due_date`,
    )
    .all(upTo) as FollowUp[];
}

const about = (f: FollowUp) => [f.subject, f.deal_title, f.contact_name].filter(Boolean).join(' · ');

export function collectInbox(db: Database.Database, person: string, _level: AccessLevel, nowMs = Date.now()): { count: number; items: InboxItem[] } {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const items = openFollowUps(db, today)
    .filter((f) => f.owner === person)
    .map<InboxItem>((f) => ({
      id: `followup-${f.id}`,
      kind: 'due',
      title: f.due_date < today ? 'A follow-up of yours is overdue' : 'A follow-up of yours is due today',
      detail: about(f),
      tone: f.due_date < today ? 'bad' : 'warn',
      at: f.due_date,
      href: '/followups',
    }));
  return { count: items.length, items };
}

export function watchCrm(db: Database.Database, people: People, nowMs: number): void {
  consume<{ id: number; deal_id: number; owner: string | null; actor: string }>(db, 'deal_assignments', 'deal_assignments', (a) => {
    if (!a.owner) return;
    const d = db
      .prepare('SELECT d.title, c.name AS company FROM deals d JOIN companies c ON c.id = d.company_id WHERE d.id = ?')
      .get(a.deal_id) as { title: string; company: string } | undefined;
    if (!d) return;
    people.notify({
      kind: 'deal-assigned',
      category: 'assignments',
      urgency: 'now',
      recipients: [a.owner],
      actor: a.actor,
      title: 'A deal was handed to you',
      detail: `${d.title} · ${d.company}`,
      href: `/deals/${a.deal_id}`,
      key: `deal:${a.id}`,
    });
  });

  const today = new Date(nowMs).toISOString().slice(0, 10);
  for (const f of openFollowUps(db, today).filter((x) => x.due_date === today)) {
    people.notify({
      kind: 'followup-due',
      category: 'deadlines',
      urgency: 'digest',
      recipients: [f.owner],
      title: 'A follow-up of yours is due today',
      detail: about(f),
      href: '/followups',
      key: `followup:${f.id}:${f.due_date}`,
    });
  }
}
