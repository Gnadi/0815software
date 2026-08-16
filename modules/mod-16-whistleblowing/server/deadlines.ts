import {
  ACKNOWLEDGE_DAYS,
  ACKNOWLEDGE_WARN_DAYS,
  FEEDBACK_MONTHS,
  FEEDBACK_WARN_DAYS,
  RETENTION_YEARS,
} from './case-config.js';
import type { Deadline, DeadlineState } from '../shared/types.js';

/**
 * The statutory clocks, derived — never stored.
 *
 * A stored due date is a due date that is wrong the moment somebody corrects
 * a receipt timestamp, and a stored breach flag is a flag that stays false
 * because the nightly job that was supposed to set it did not run. Both are
 * computed here from the case's own facts and an injected `now`, so there is
 * no state to go stale and a test can put the clock anywhere.
 *
 * Everything is an ISO-8601 instant in UTC with second precision, the same
 * shape the rest of the module writes.
 */

const DAY_MS = 86_400_000;

export function nowIso(ms: number = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function addDays(iso: string, days: number): string {
  return nowIso(Date.parse(iso) + days * DAY_MS);
}

/**
 * Add whole calendar months, clamping to the end of the target month.
 *
 * Not `+90 days`: the law says three months, and 30 November plus three
 * months is 28 February, not 1 March. Clamping is what every civil-law
 * Fristenberechnung does with a day that does not exist in the target month
 * (§ 188 Abs. 3 BGB), and it is the direction that favours the reporter —
 * the organisation gets no free extra day out of a short month.
 */
export function addMonths(iso: string, months: number): string {
  const date = new Date(Date.parse(iso));
  const day = date.getUTCDate();
  const target = new Date(date.getTime());
  target.setUTCDate(1);
  target.setUTCMonth(target.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return nowIso(target.getTime());
}

export function addYears(iso: string, years: number): string {
  return addMonths(iso, years * 12);
}

/** Whole days from `from` to `to`, rounded toward zero. Negative once past. */
function daysBetween(from: string, to: string): number {
  return Math.trunc((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

function stateOf(dueAt: string, metAt: string | null, now: string, warnDays: number): DeadlineState {
  // An obligation fulfilled after the date is `missed`, not `met`. The point
  // of keeping the distinction is that "we answered, just late" is exactly
  // what an audit wants to see, and a view that collapses it into `met` the
  // moment the reply lands would hide every late response the module ever
  // recorded.
  if (metAt !== null) return metAt <= dueAt ? 'met' : 'missed';
  if (now > dueAt) return 'missed';
  return daysBetween(now, dueAt) <= warnDays ? 'at_risk' : 'upcoming';
}

function deadline(dueAt: string, metAt: string | null, now: string, warnDays: number): Deadline {
  return {
    due_at: dueAt,
    met_at: metAt,
    state: stateOf(dueAt, metAt, now, warnDays),
    days_remaining: daysBetween(now, dueAt),
  };
}

/** § 17 Abs. 1 HinSchG — seven days from receipt to acknowledge. */
export function acknowledgeDeadline(receivedAt: string, acknowledgedAt: string | null, now: string): Deadline {
  return deadline(addDays(receivedAt, ACKNOWLEDGE_DAYS), acknowledgedAt, now, ACKNOWLEDGE_WARN_DAYS);
}

/**
 * § 17 Abs. 2 HinSchG — three months to give feedback.
 *
 * Measured from the acknowledgement, and when none was ever sent, from the
 * expiry of the seven-day window instead. That fallback is the whole point:
 * never acknowledging does not postpone the feedback obligation, it starts
 * it, so a case sitting untouched accrues BOTH failures rather than none.
 *
 * `feedbackGivenAt` is the first substantive thing the reporter can actually
 * read — a message to them, or the closure of the case. An internal note is
 * not feedback, however thorough.
 */
export function feedbackDeadline(
  receivedAt: string,
  acknowledgedAt: string | null,
  feedbackGivenAt: string | null,
  now: string,
): Deadline {
  const start = acknowledgedAt ?? addDays(receivedAt, ACKNOWLEDGE_DAYS);
  return deadline(addMonths(start, FEEDBACK_MONTHS), feedbackGivenAt, now, FEEDBACK_WARN_DAYS);
}

/**
 * § 11 Abs. 5 HinSchG — the date the documentation becomes due for erasure,
 * three years after the procedure was concluded. Null while the case is
 * still open: the clock starts at closure, not at receipt.
 */
export function eraseDueOn(closedAt: string | null): string | null {
  return closedAt === null ? null : addYears(closedAt, RETENTION_YEARS).slice(0, 10);
}
