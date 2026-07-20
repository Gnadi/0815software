/**
 * Status workflow configuration — THE one place the allowed transitions
 * live. The domain layer (server/tickets.ts) enforces `canTransition`
 * on every status change (illegal → 422); the client renders the legal
 * next steps from `GET /api/config`. Nothing else in the codebase knows
 * the workflow — edit this file to change it.
 *
 *   new       just arrived, not yet triaged
 *   open      an agent is working it
 *   pending   waiting on the requester (or a third party)
 *   resolved  a fix/answer was delivered; the resolution clock stops here
 *   closed    archived; terminal apart from a reopen
 *
 * A requester follow-up on a resolved (or closed) ticket reopens it back
 * to `open` automatically — that reopen is itself an appended
 * status_change event (see server/tickets.ts), which is why `resolved`
 * and `closed` both allow a transition to `open`.
 */
import { STATUSES, type Status } from '../shared/types.js';

export const TRANSITIONS: Record<Status, Status[]> = {
  new: ['open', 'pending', 'resolved'],
  open: ['pending', 'resolved'],
  pending: ['open', 'resolved'],
  resolved: ['open', 'closed'],
  closed: ['open'],
};

/** The status every ticket starts in the instant it is created. */
export const INITIAL_STATUS: Status = 'new';

export function allowedTransitions(from: Status): Status[] {
  return TRANSITIONS[from];
}

export function canTransition(from: Status, to: Status): boolean {
  return TRANSITIONS[from].includes(to);
}

// ── Config self-check (runs once at import) ───────────────────────────
// A misconfigured workflow should fail loudly at startup, not silently
// at transition time.
{
  const known = new Set<string>(STATUSES);
  for (const from of STATUSES) {
    for (const to of TRANSITIONS[from]) {
      if (!known.has(to)) {
        throw new Error(`status-config: transition ${from} → ${to} names an unknown status`);
      }
      if (to === from) {
        throw new Error(`status-config: ${from} lists itself as a transition target`);
      }
    }
  }
}
