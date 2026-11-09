import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import type { InboxItem } from '../shared/summary.js';
import type { People } from './people.js';

/**
 * What waits for one person in this module, and whom which event concerns
 * (docs/NOTIFICATIONS-PLAN.md). REPLACE with the module's own rules: the
 * approvals, assignments and deadlines that are someone's to act on, counted
 * from the rows (never a stored counter), and the log rows (`consume` from
 * ./watch.js) that should tell someone. Until then nothing waits and nobody
 * is told — the honest default for a module that has not decided yet.
 */

export function collectInbox(_db: Database.Database, _person: string, _level: AccessLevel): { count: number; items: InboxItem[] } {
  return { count: 0, items: [] };
}

export function watchModule(_db: Database.Database, _people: People): void {
  // Nothing to tell yet.
}
