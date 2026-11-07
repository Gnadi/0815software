import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import type { InboxItem } from '../shared/summary.js';
import type { People } from './people.js';
import { consume } from './watch.js';
import { mayAct } from './inbox.js';
import { listTickets } from './tickets.js';
import type { TicketRow } from '../shared/types.js';

/**
 * What waits for an agent here, and whom which ticket event concerns
 * (docs/NOTIFICATIONS-PLAN.md, MOD-12).
 *
 *  - Waits for an agent: the tickets assigned to them that are open on their
 *    side (new or open — `pending` waits on the requester), the ones whose
 *    SLA is at risk or broken marked so. Anyone who may edit also sees the
 *    tickets nobody has taken yet.
 *  - Notified: an assignment (to the assignee, now), a requester's reply on
 *    an assigned ticket (to the assignee, now), a new ticket nobody holds
 *    (to everyone who may edit, in the digest), and an SLA that is about to
 *    break or broke (to the assignee, now and through quiet hours — the
 *    stand-by case). Who the "team lead" is was left open by the business,
 *    so nobody above the assignee is told yet.
 */

const ACTIVE = new Set(['new', 'open']);

function agentEmail(db: Database.Database, id: number | null): string | null {
  if (id === null) return null;
  return ((db.prepare('SELECT email FROM agents WHERE id = ?').get(id) as { email: string } | undefined)?.email ?? null)?.toLowerCase() ?? null;
}

function slaOf(row: TicketRow): { tone: InboxItem['tone']; due: string | null } {
  const legs = [row.sla.first_response, row.sla.resolution];
  if (legs.some((l) => l.state === 'breached' && l.met_at === null)) return { tone: 'bad', due: legs.find((l) => l.met_at === null)?.due_at ?? null };
  const risk = legs.find((l) => l.state === 'at_risk');
  if (risk) return { tone: 'warn', due: risk.due_at };
  return { tone: 'neutral', due: legs.find((l) => l.met_at === null)?.due_at ?? null };
}

export function collectInbox(db: Database.Database, person: string, level: AccessLevel, nowMs = Date.now()): { count: number; items: InboxItem[] } {
  const agent = db.prepare('SELECT id FROM agents WHERE lower(email) = ?').get(person) as { id: number } | undefined;
  const rows = listTickets(db, {}, nowMs).filter((r) => ACTIVE.has(r.status));
  const mine = agent ? rows.filter((r) => r.assignee_id === agent.id) : [];
  const unclaimed = mayAct(level, 'edit') ? rows.filter((r) => r.assignee_id === null) : [];
  const items: InboxItem[] = [
    ...mine.map((r) => {
      const sla = slaOf(r);
      return {
        id: r.ref,
        kind: 'assigned',
        title: sla.tone === 'bad' ? 'A ticket of yours is past its SLA' : sla.tone === 'warn' ? 'A ticket of yours is about to break its SLA' : 'A ticket waits for you',
        detail: `${r.ref} · ${r.subject}`,
        tone: sla.tone,
        at: sla.due,
        href: `/tickets/${r.ref}`,
      };
    }),
    ...unclaimed.map((r) => ({
      id: r.ref,
      kind: 'unassigned',
      title: 'A ticket nobody has taken',
      detail: `${r.ref} · ${r.subject}`,
      tone: slaOf(r).tone,
      at: r.created_at,
      href: `/tickets/${r.ref}`,
    })),
  ];
  return { count: items.length, items };
}

interface EventRow {
  id: number;
  ticket_id: number;
  type: string;
  actor: string;
  actor_type: string;
  visibility: string | null;
  payload: string;
}

/** One pass: new log rows, then the SLA clocks. */
export function watchTickets(db: Database.Database, people: People, nowMs: number): void {
  const ticketOf = (id: number) => db.prepare('SELECT ref, subject FROM tickets WHERE id = ?').get(id) as { ref: string; subject: string };
  const rowByRef = (ref: string) => listTickets(db, { search: ref }, nowMs).find((r) => r.ref === ref);

  consume<EventRow>(db, 'ticket_events', 'ticket_events', (ev) => {
    const t = ticketOf(ev.ticket_id);
    const payload = JSON.parse(ev.payload) as { assignee_id?: number | null };
    if (ev.type === 'assignment' && payload.assignee_id) {
      people.notify({
        kind: 'ticket-assigned',
        category: 'assignments',
        urgency: 'now',
        recipients: [agentEmail(db, payload.assignee_id)],
        actor: ev.actor,
        title: 'A ticket was assigned to you',
        detail: `${t.ref} · ${t.subject}`,
        href: `/tickets/${t.ref}`,
        key: `assigned:${ev.id}`,
      });
    } else if (ev.type === 'comment' && ev.actor_type === 'requester') {
      const row = rowByRef(t.ref);
      if (row?.assignee_id) {
        people.notify({
          kind: 'ticket-reply',
          category: 'replies',
          urgency: 'now',
          recipients: [agentEmail(db, row.assignee_id)],
          title: 'A customer replied on your ticket',
          detail: `${t.ref} · ${t.subject}`,
          href: `/tickets/${t.ref}`,
          key: `reply:${ev.id}`,
        });
      }
    } else if (ev.type === 'created') {
      const row = rowByRef(t.ref);
      if (row && row.assignee_id === null) {
        people.notify({
          kind: 'ticket-new',
          category: 'assignments',
          urgency: 'digest',
          holders: 'edit',
          title: 'A new ticket nobody has taken',
          detail: `${t.ref} · ${t.subject}`,
          href: `/tickets/${t.ref}`,
          key: `new:${ev.id}`,
        });
      }
    }
  });

  // The clocks: once per leg and due time, so a reopened ticket with a new
  // clock is told again, and a ticket that stays at risk is told once.
  for (const row of listTickets(db, {}, nowMs).filter((r) => ACTIVE.has(r.status) && r.assignee_id !== null)) {
    for (const [leg, sla] of [['first-response', row.sla.first_response], ['resolution', row.sla.resolution]] as const) {
      if (sla.met_at !== null) continue;
      if (sla.state !== 'at_risk' && sla.state !== 'breached') continue;
      const broken = sla.state === 'breached';
      people.notify({
        kind: broken ? 'sla-breached' : 'sla-at-risk',
        category: 'deadlines',
        urgency: 'now',
        oncall: true,
        recipients: [agentEmail(db, row.assignee_id)],
        title: broken ? 'A ticket of yours broke its SLA' : 'A ticket of yours is about to break its SLA',
        detail: `${row.ref} · ${row.subject} · ${leg.replace('-', ' ')} due ${sla.due_at}`,
        href: `/tickets/${row.ref}`,
        key: `${broken ? 'breached' : 'risk'}:${row.ref}:${leg}:${sla.due_at}`,
      });
    }
  }
}
