/**
 * SLA policy — THE one place service-level targets live, plus the pure
 * functions that turn those targets into a breach verdict.
 *
 * Each priority has two targets, in MINUTES from the ticket's creation:
 *   first_response  how quickly an agent must post the first PUBLIC reply
 *   resolution      how quickly the ticket must reach `resolved`
 *
 * DERIVED, NEVER STORED. A ticket carries no "breached" flag. Given a
 * ticket's created_at, its current priority, the two derived actuals
 * (first agent reply time, first time it entered resolved) and the
 * wall-clock "now", `evaluateSla` computes the verdict fresh on every
 * read. Inject `now` (see server/tickets.ts and the tests) — nothing
 * here reads the real clock, which is what makes breach logic testable
 * against fixed inputs.
 *
 * WALL-CLOCK ONLY. Targets are elapsed real time; "business hours" /
 * calendars / pause-on-pending are explicitly OUT OF SCOPE (see README).
 * A ticket that changes priority is measured against its NEW priority's
 * targets, still counted from the original created_at.
 */
import type { Priority, Sla, SlaLeg, SlaState } from '../shared/types.js';

export interface SlaPolicy {
  firstResponseMinutes: number;
  resolutionMinutes: number;
}

export const SLA_POLICIES: Record<Priority, SlaPolicy> = {
  urgent: { firstResponseMinutes: 30, resolutionMinutes: 240 },
  high: { firstResponseMinutes: 60, resolutionMinutes: 480 },
  normal: { firstResponseMinutes: 240, resolutionMinutes: 1920 },
  low: { firstResponseMinutes: 480, resolutionMinutes: 3840 },
};

/**
 * A leg counts as "at risk" once it is within this many minutes of its
 * due time (and not yet met or breached). Powers the queue dashboard.
 */
export const AT_RISK_MINUTES = 60;

const MINUTE_MS = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Verdict for a single SLA leg.
 *   met       satisfied on time (actual ≤ due)
 *   breached  either satisfied late (actual > due), or still unsatisfied
 *             and now is past due
 *   at_risk   not yet satisfied, not yet past due, but within the
 *             at-risk window
 *   pending   not yet satisfied and comfortably before due
 */
export function evaluateLeg(
  dueMs: number,
  actualMs: number | null,
  nowMs: number,
  atRiskMs: number = AT_RISK_MINUTES * MINUTE_MS,
): SlaLeg {
  let state: SlaState;
  if (actualMs !== null) {
    state = actualMs <= dueMs ? 'met' : 'breached';
  } else if (nowMs > dueMs) {
    state = 'breached';
  } else if (nowMs >= dueMs - atRiskMs) {
    state = 'at_risk';
  } else {
    state = 'pending';
  }
  return {
    due_at: iso(dueMs),
    met_at: actualMs !== null ? iso(actualMs) : null,
    state,
    breached: state === 'breached',
  };
}

export interface SlaInputs {
  createdMs: number;
  priority: Priority;
  firstResponseMs: number | null;
  resolvedMs: number | null;
  nowMs: number;
}

/** Full SLA verdict for a ticket, both legs, from fixed inputs. */
export function evaluateSla(inputs: SlaInputs): Sla {
  const policy = SLA_POLICIES[inputs.priority];
  const frDue = inputs.createdMs + policy.firstResponseMinutes * MINUTE_MS;
  const resDue = inputs.createdMs + policy.resolutionMinutes * MINUTE_MS;
  return {
    priority: inputs.priority,
    first_response: evaluateLeg(frDue, inputs.firstResponseMs, inputs.nowMs),
    resolution: evaluateLeg(resDue, inputs.resolvedMs, inputs.nowMs),
  };
}
