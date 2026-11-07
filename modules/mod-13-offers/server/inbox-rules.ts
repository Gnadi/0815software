import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import type { InboxItem } from '../shared/summary.js';
import type { People } from './people.js';
import { consume } from './watch.js';

/**
 * What waits for a salesperson in offers, and whom a customer's answer
 * concerns (docs/NOTIFICATIONS-PLAN.md, MOD-13). "Their" offer is the one
 * they SENT — the `sent` event names them; nobody owns a draft yet.
 *
 *  - Waits: their sent offers that expire within three days without an
 *    answer.
 *  - Notified: an acceptance, now; a rejection, in the digest; an offer of
 *    theirs three days from expiring, in the digest.
 */

const DAY = 86_400_000;

function senderOf(db: Database.Database, offerId: number): string | null {
  const row = db
    .prepare("SELECT actor FROM offer_events WHERE offer_id = ? AND event = 'sent' ORDER BY id DESC LIMIT 1")
    .get(offerId) as { actor: string } | undefined;
  return row?.actor.toLowerCase() ?? null;
}

interface OpenOffer {
  id: number;
  number: string;
  title: string;
  valid_until: string;
  customer: string;
}

function expiringWithin(db: Database.Database, nowMs: number, days: number): OpenOffer[] {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const until = new Date(nowMs + days * DAY).toISOString().slice(0, 10);
  return db
    .prepare(
      `SELECT o.id, o.number, o.title, o.valid_until, c.name AS customer FROM offers o JOIN customers c ON c.id = o.customer_id
        WHERE o.status = 'sent' AND o.valid_until >= ? AND o.valid_until <= ? ORDER BY o.valid_until`,
    )
    .all(today, until) as OpenOffer[];
}

export function collectInbox(db: Database.Database, person: string, _level: AccessLevel, nowMs = Date.now()): { count: number; items: InboxItem[] } {
  const items = expiringWithin(db, nowMs, 3)
    .filter((o) => senderOf(db, o.id) === person)
    .map<InboxItem>((o) => ({
      id: o.number,
      kind: 'expiring',
      title: 'An offer of yours expires soon without an answer',
      detail: `${o.number} · ${o.customer} · ${o.title} · valid until ${o.valid_until}`,
      tone: 'warn',
      at: o.valid_until,
      href: `/offers/${o.id}`,
    }));
  return { count: items.length, items };
}

export function watchOffers(db: Database.Database, people: People, nowMs: number): void {
  consume<{ id: number; offer_id: number; event: string; actor: string; note: string | null }>(db, 'offer_events', 'offer_events', (ev) => {
    if (ev.event !== 'accepted' && ev.event !== 'rejected') return;
    const o = db
      .prepare('SELECT o.number, o.title, c.name AS customer FROM offers o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?')
      .get(ev.offer_id) as { number: string; title: string; customer: string };
    const accepted = ev.event === 'accepted';
    people.notify({
      kind: accepted ? 'offer-accepted' : 'offer-rejected',
      category: 'replies',
      urgency: accepted ? 'now' : 'digest',
      recipients: [senderOf(db, ev.offer_id)],
      actor: ev.actor,
      title: accepted ? 'A customer accepted your offer' : 'A customer declined your offer',
      detail: `${o.number} · ${o.customer} · ${o.title}${ev.note ? ` · ${ev.note}` : ''}`,
      href: `/offers/${ev.offer_id}`,
      key: `${ev.event}:${ev.id}`,
    });
  });

  for (const o of expiringWithin(db, nowMs, 3)) {
    people.notify({
      kind: 'offer-expiring',
      category: 'deadlines',
      urgency: 'digest',
      recipients: [senderOf(db, o.id)],
      title: 'An offer of yours expires soon without an answer',
      detail: `${o.number} · ${o.customer} · ${o.title} · valid until ${o.valid_until}`,
      href: `/offers/${o.id}`,
      key: `expiring:${o.id}:${o.valid_until}`,
    });
  }
}
