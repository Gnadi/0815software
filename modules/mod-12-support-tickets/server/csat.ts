import type Database from 'better-sqlite3';
import type { CsatRating, CsatStats, Status, TicketEvent } from '../shared/types.js';
import { DomainError } from './tickets.js';

/**
 * Satisfaction ratings (CSAT). Once a ticket is resolved, the requester can
 * rate it on their status page — 1 to 5, with an optional comment — once per
 * resolution: the rating is keyed to the status change that resolved it, so
 * a ticket reopened and resolved again can be rated again, and the first
 * rating of a resolution is never overwritten.
 *
 * The figures are derived from the ratings on every read: the average, the
 * distribution, and the CSAT percentage as the industry counts it — the
 * share of 4s and 5s.
 */

/** The resolution the requester may rate now, or null: not resolved, or rated already. */
export function rateableResolution(db: Database.Database, ticketId: number, events: readonly TicketEvent[], status: Status): number | null {
  if (status !== 'resolved' && status !== 'closed') return null;
  const resolution = [...events].reverse().find((e) => e.type === 'status_change' && e.payload.to === 'resolved');
  if (!resolution) return null;
  const rated = db.prepare('SELECT 1 FROM csat_ratings WHERE ticket_id = ? AND resolution_event_id = ?').get(ticketId, resolution.id);
  return rated ? null : resolution.id;
}

export function rateTicket(db: Database.Database, ticketId: number, resolutionEventId: number | null, input: Record<string, unknown>, at: string): void {
  const score = input.score;
  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
    throw new DomainError(422, 'Validation failed', [{ field: 'score', message: 'must be a whole number from 1 to 5' }]);
  }
  const comment = typeof input.comment === 'string' && input.comment.trim() !== '' ? input.comment.trim() : null;
  if (comment !== null && comment.length > 2000) throw new DomainError(422, 'Validation failed', [{ field: 'comment', message: 'at most 2000 characters' }]);
  if (resolutionEventId === null) throw new DomainError(409, 'This ticket cannot be rated now — it is not resolved, or it was rated already');
  // UNIQUE (resolution_event_id): two clicks racing record one rating.
  const info = db
    .prepare('INSERT OR IGNORE INTO csat_ratings (ticket_id, resolution_event_id, score, comment, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(ticketId, resolutionEventId, score, comment, at);
  if (info.changes === 0) throw new DomainError(409, 'This resolution was rated already');
}

export function ratingsOf(db: Database.Database, ticketId: number): CsatRating[] {
  return db
    .prepare('SELECT r.id, t.ref, r.score, r.comment, r.created_at FROM csat_ratings r JOIN tickets t ON t.id = r.ticket_id WHERE r.ticket_id = ? ORDER BY r.id')
    .all(ticketId) as CsatRating[];
}

export function csatStats(db: Database.Database, recent = 5): CsatStats {
  const rows = db.prepare('SELECT score, COUNT(*) AS n FROM csat_ratings GROUP BY score').all() as { score: number; n: number }[];
  const distribution: CsatStats['distribution'] = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  let count = 0;
  let sum = 0;
  for (const r of rows) {
    distribution[String(r.score) as keyof CsatStats['distribution']] = r.n;
    count += r.n;
    sum += r.score * r.n;
  }
  return {
    count,
    average: count > 0 ? Math.round((sum / count) * 100) / 100 : null,
    csat_percent: count > 0 ? Math.round(((distribution[4] + distribution[5]) / count) * 1000) / 10 : null,
    distribution,
    recent: db
      .prepare('SELECT r.id, t.ref, r.score, r.comment, r.created_at FROM csat_ratings r JOIN tickets t ON t.id = r.ticket_id ORDER BY r.created_at DESC, r.id DESC LIMIT ?')
      .all(recent) as CsatRating[],
  };
}
