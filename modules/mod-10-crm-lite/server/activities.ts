import type Database from 'better-sqlite3';
import type { Activity, ActivityType, FollowUp } from '../shared/types.js';
import { DomainError, nowIso, requireRow } from './domain.js';
import { today } from './contacts.js';

const ACTIVITY_SELECT = `
  SELECT a.*, k.name AS contact_name, d.title AS deal_title
  FROM activities a
  LEFT JOIN contacts k ON k.id = a.contact_id
  LEFT JOIN deals d ON d.id = a.deal_id
`;

export interface ActivityInput {
  type: ActivityType;
  subject: string;
  body: string | null;
  contactId: number | null;
  dealId: number | null;
  dueDate: string | null;
  createdAt?: string;
}

export function getActivity(db: Database.Database, id: number): Activity {
  return requireRow(
    db.prepare(`${ACTIVITY_SELECT} WHERE a.id = ?`).get(id) as Activity | undefined,
    'Activity',
  );
}

/** Newest first — the order the timeline renders in. */
export function activitiesForDeal(db: Database.Database, dealId: number): Activity[] {
  return db
    .prepare(`${ACTIVITY_SELECT} WHERE a.deal_id = ? ORDER BY a.created_at DESC, a.id DESC`)
    .all(dealId) as Activity[];
}

export function activitiesForContact(db: Database.Database, contactId: number): Activity[] {
  return db
    .prepare(`${ACTIVITY_SELECT} WHERE a.contact_id = ? ORDER BY a.created_at DESC, a.id DESC`)
    .all(contactId) as Activity[];
}

export function listActivities(db: Database.Database): Activity[] {
  return db.prepare(`${ACTIVITY_SELECT} ORDER BY a.created_at DESC, a.id DESC`).all() as Activity[];
}

/**
 * Open follow-ups: activities with a due date that are not yet done,
 * soonest due first. `overdue` is derived (due_date < today), never
 * stored, so it is always correct relative to the current date.
 */
export function listFollowUps(db: Database.Database, opts: { includeDone?: boolean } = {}): FollowUp[] {
  const rows = db
    .prepare(
      `${ACTIVITY_SELECT}
       WHERE a.due_date IS NOT NULL ${opts.includeDone ? '' : 'AND a.done = 0'}
       ORDER BY a.due_date ASC, a.id ASC`,
    )
    .all() as Activity[];
  const t = today();
  return rows.map((a) => ({ ...a, overdue: a.done === 0 && a.due_date !== null && a.due_date < t }));
}

/**
 * Append an activity to the log. At least one of contact/deal must be
 * given (enforced here and by a DB CHECK). Once written the row is
 * immutable except for the follow-up done toggle.
 */
export function createActivity(db: Database.Database, input: ActivityInput): number {
  if (input.contactId === null && input.dealId === null) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'link', message: 'An activity must be linked to a contact and/or a deal' },
    ]);
  }
  if (input.contactId !== null && !db.prepare('SELECT id FROM contacts WHERE id = ?').get(input.contactId)) {
    throw new DomainError(404, 'Contact not found');
  }
  if (input.dealId !== null && !db.prepare('SELECT id FROM deals WHERE id = ?').get(input.dealId)) {
    throw new DomainError(404, 'Deal not found');
  }
  const info = db
    .prepare(
      `INSERT INTO activities (type, subject, body, contact_id, deal_id, due_date, done, done_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
    )
    .run(
      input.type,
      input.subject,
      input.body,
      input.contactId,
      input.dealId,
      input.dueDate,
      input.createdAt ?? nowIso(),
    );
  return Number(info.lastInsertRowid);
}

/**
 * Toggle a follow-up's done flag — the one mutation the append-only log
 * allows, and it is recorded: marking done stamps done_at, un-marking
 * clears it. Toggling an activity that has no due date is a 409 (it is
 * not a follow-up).
 */
export function setFollowUpDone(db: Database.Database, id: number, done: boolean, at?: string): void {
  const activity = getActivity(db, id);
  if (activity.due_date === null) {
    throw new DomainError(409, 'This activity is not a follow-up (no due date) and cannot be marked done');
  }
  db.prepare('UPDATE activities SET done = ?, done_at = ? WHERE id = ?').run(
    done ? 1 : 0,
    done ? (at ?? nowIso()) : null,
    id,
  );
}
