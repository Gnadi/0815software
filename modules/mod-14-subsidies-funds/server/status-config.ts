/**
 * Application status workflow — THE one place the allowed transitions
 * live. The domain layer (server/applications.ts) enforces `canTransition`
 * on every status change (illegal → 422); the client renders the legal
 * next steps from `GET /api/config`. Nothing else in the codebase knows
 * the workflow — edit this file to change it.
 *
 * This is OUR (the applicant's) view of an application's life:
 *
 *   draft         we are preparing it; editable
 *   submitted     we handed it to the funding body; frozen
 *   under_review  the body is assessing it
 *   approved      granted — an approved_amount is recorded here; from this
 *                 point tranches can be disbursed and reports fall due
 *   rejected      declined (terminal)
 *   withdrawn     we pulled it (terminal)
 *
 * The forward path is draft → submitted → under_review → approved. We may
 * withdraw at any point before a decision. There is deliberately NO way
 * back to draft: once submitted, the timeline only moves forward, so the
 * append-only event stream reads as a true history.
 */
import { APPLICATION_STATUSES, type ApplicationStatus } from '../shared/types.js';

export const TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  draft: ['submitted', 'withdrawn'],
  submitted: ['under_review', 'withdrawn'],
  under_review: ['approved', 'rejected', 'withdrawn'],
  approved: [],
  rejected: [],
  withdrawn: [],
};

/** The status every application starts in the instant it is created. */
export const INITIAL_STATUS: ApplicationStatus = 'draft';

export function allowedTransitions(from: ApplicationStatus): ApplicationStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

// ── Config self-check (runs once at import) ───────────────────────────
// A misconfigured workflow should fail loudly at startup, not silently at
// transition time.
{
  const known = new Set<string>(APPLICATION_STATUSES);
  for (const from of APPLICATION_STATUSES) {
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
