/**
 * SLA policy — the built-in defaults, and the pure functions that turn a
 * policy into a breach verdict.
 *
 * Each priority has two targets, in MINUTES:
 *   first_response  how quickly an agent must post the first PUBLIC reply
 *   resolution      how quickly the ticket must reach `resolved`
 * counted either around the clock or in business hours (the policy's weekly
 * opening windows, its time zone and holidays — server/business-hours.ts).
 *
 * The defaults below hold until an administrator saves a policy in the UI
 * (server/policy.ts). Saved policies are versioned and a ticket keeps the
 * version it came in under, so a change applies to new tickets and does not
 * rewrite old verdicts.
 *
 * DERIVED, NEVER STORED. A ticket carries no "breached" flag. Given its
 * created_at, its current priority, the derived actuals (first agent reply,
 * first time it entered resolved), the stretches it waited on the requester
 * and the clock's "now", `evaluateSla` computes the verdict fresh on every
 * read. Nothing here reads the real clock, which is what makes breach logic
 * testable against fixed inputs.
 *
 * A ticket that changes priority is measured against its NEW priority's
 * targets, still counted from the original created_at.
 */
import type { Priority, Sla, SlaLeg, SlaPolicy, SlaState } from '../shared/types.js';
import { dueAt, elapsedMs, type Clock, type Interval } from './business-hours.js';

export interface SlaTargets {
  firstResponseMinutes: number;
  resolutionMinutes: number;
}

export const SLA_POLICIES: Record<Priority, SlaTargets> = {
  urgent: { firstResponseMinutes: 30, resolutionMinutes: 240 },
  high: { firstResponseMinutes: 60, resolutionMinutes: 480 },
  normal: { firstResponseMinutes: 240, resolutionMinutes: 1920 },
  low: { firstResponseMinutes: 480, resolutionMinutes: 3840 },
};

/**
 * A leg counts as "at risk" once at most this many clock minutes are left
 * (and it is not yet met or breached). Powers the queue dashboard.
 */
export const AT_RISK_MINUTES = 60;

/** Until someone saves a policy: the targets above, around the clock, no pause. */
export const DEFAULT_POLICY: SlaPolicy = {
  targets: Object.fromEntries(
    Object.entries(SLA_POLICIES).map(([p, t]) => [p, { first_response_minutes: t.firstResponseMinutes, resolution_minutes: t.resolutionMinutes, business_hours: false }]),
  ) as SlaPolicy['targets'],
  at_risk_minutes: AT_RISK_MINUTES,
  timezone: 'Europe/Vienna',
  // Business hours used once a priority is switched to them: Mon–Fri 8–17.
  week: [0, 1, 2, 3, 4, 5, 6].map((d) => (d < 5 ? [{ start: '08:00', end: '17:00' }] : [])),
  holidays: [],
  pause_on_pending: false,
};

const MINUTE_MS = 60_000;

function iso(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function clockOf(policy: SlaPolicy, businessHours: boolean): Clock {
  return businessHours ? { timezone: policy.timezone, week: policy.week, holidays: new Set(policy.holidays.map((h) => h.date)) } : null;
}

export interface LegInputs {
  createdMs: number;
  targetMinutes: number;
  actualMs: number | null;
  nowMs: number;
  clock: Clock;
  /** Stretches the clock stood still; an open one is passed ending at now. */
  pauses?: readonly Interval[];
  /** The clock is standing still right now. */
  pausedNow?: boolean;
  atRiskMinutes?: number;
}

/**
 * Verdict for a single SLA leg.
 *   met       satisfied on time (actual ≤ due)
 *   breached  either satisfied late (actual > due), or still unsatisfied
 *             and now is past due
 *   paused    not satisfied, not past due, and the clock stands still
 *   at_risk   not yet satisfied, not past due, at most the at-risk
 *             minutes of clock left
 *   pending   not yet satisfied and comfortably before due
 *
 * While paused, `due_at` is when it would fall due if the clock ran again now.
 */
export function evaluateLeg(inputs: LegInputs): SlaLeg {
  const pauses = inputs.pauses ?? [];
  const due = dueAt(inputs.createdMs, inputs.targetMinutes, inputs.clock, pauses);
  const atRiskMs = (inputs.atRiskMinutes ?? AT_RISK_MINUTES) * MINUTE_MS;
  let state: SlaState;
  let remaining: number | null = null;
  if (inputs.actualMs !== null) {
    state = inputs.actualMs <= due ? 'met' : 'breached';
  } else if (inputs.nowMs > due) {
    state = 'breached';
  } else {
    // Clock time from now to due: what is left, counted the way the target is.
    const left = elapsedMs(inputs.nowMs, due, inputs.clock, pauses);
    remaining = Math.max(0, Math.round(left / MINUTE_MS));
    state = inputs.pausedNow ? 'paused' : left <= atRiskMs ? 'at_risk' : 'pending';
  }
  return {
    due_at: iso(due),
    met_at: inputs.actualMs !== null ? iso(inputs.actualMs) : null,
    state,
    breached: state === 'breached',
    business_hours: inputs.clock !== null,
    remaining_minutes: remaining,
  };
}

export interface SlaInputs {
  createdMs: number;
  priority: Priority;
  firstResponseMs: number | null;
  resolvedMs: number | null;
  nowMs: number;
  /** Defaults to DEFAULT_POLICY — wall clock, the targets above. */
  policy?: SlaPolicy;
  policyVersion?: number | null;
  /** When the ticket waited on the requester: [entered pending, left it] — left null while it still waits. */
  pending?: readonly (readonly [number, number | null])[];
}

/** Full SLA verdict for a ticket, both legs, from fixed inputs. */
export function evaluateSla(inputs: SlaInputs): Sla {
  const policy = inputs.policy ?? DEFAULT_POLICY;
  const target = policy.targets[inputs.priority];
  const clock = clockOf(policy, target.business_hours);
  // The pause stops the RESOLUTION clock only: a ticket set to pending before
  // anyone answered it publicly still owes that first answer.
  const pending = policy.pause_on_pending ? (inputs.pending ?? []) : [];
  const pauses = pending.map(([a, b]) => [a, b ?? inputs.nowMs] as const);
  const pausedNow = pending.some(([, b]) => b === null);
  return {
    priority: inputs.priority,
    first_response: evaluateLeg({ createdMs: inputs.createdMs, targetMinutes: target.first_response_minutes, actualMs: inputs.firstResponseMs, nowMs: inputs.nowMs, clock, atRiskMinutes: policy.at_risk_minutes }),
    resolution: evaluateLeg({ createdMs: inputs.createdMs, targetMinutes: target.resolution_minutes, actualMs: inputs.resolvedMs, nowMs: inputs.nowMs, clock, pauses, pausedNow, atRiskMinutes: policy.at_risk_minutes }),
    policy_version: inputs.policyVersion ?? null,
  };
}
