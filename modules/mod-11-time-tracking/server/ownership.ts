import type Database from 'better-sqlite3';
import { DomainError } from './tracking.js';
import type { AccessLevel } from '@0815software/platform-clients';

/**
 * Whose time a person may record — the one per-record rule in this module.
 *
 * `server/access.ts` answers "may this person write here at all"; it cannot
 * answer "may they write THIS row", because that depends on the row. So the
 * rule lives here, as one function every entry route calls, rather than as a
 * check scattered through the routes:
 *
 * - `manage` records, corrects and submits anyone's time — the office that
 *   approves the week also fixes it.
 * - `edit` records only its OWN time: the employee whose email is the signed-in
 *   identity (PS-01's email, compared case-insensitively). Someone with no
 *   employee record is told so rather than handed somebody else's sheet.
 * - `view` never reaches here; the policy has already refused the write.
 *
 * Standalone, the only login is the local admin, who manages — so nothing
 * changes for a single-user install.
 */

/** The employee this identity is, or null when no employee carries that email. */
export function employeeOf(db: Database.Database, actor: string): number | null {
  const row = db
    .prepare('SELECT id FROM employees WHERE email IS NOT NULL AND lower(email) = lower(?) ORDER BY id LIMIT 1')
    .get(actor) as { id: number } | undefined;
  return row?.id ?? null;
}

/** Refuse unless `actor` at `access` may record time for `employeeId`. */
export function assertMayRecordFor(
  db: Database.Database,
  actor: string,
  access: AccessLevel,
  employeeId: number,
): void {
  if (access === 'manage') return;
  const own = employeeOf(db, actor);
  if (own === null) {
    throw new DomainError(403, `No employee record carries ${actor} — ask a manager to add your email to it`);
  }
  if (own !== employeeId) throw new DomainError(403, 'You can only record your own time');
}
