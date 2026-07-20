/**
 * Deadline policy — THE one place the at-risk window lives, plus the pure
 * functions that turn a due date + "now" into a verdict.
 *
 * DERIVED, NEVER STORED. Neither a program's application deadline nor a
 * reporting obligation carries an "overdue" flag. Given a due date (a
 * YYYY-MM-DD calendar day), the done flag, and the wall-clock "now", these
 * functions compute the state fresh on every read.
 *
 * INJECT "now". Nothing here reads the real clock — the caller passes
 * `nowMs` (see server/app.ts and the tests), which is what makes the
 * overdue/upcoming logic testable against fixed inputs in both directions.
 *
 * A due date is treated as the END of its calendar day (23:59:59Z): an
 * obligation due today is not overdue until today is over.
 */
import type { DeadlineState, ObligationState } from '../shared/types.js';

const DAY_MS = 86_400_000;

/**
 * A deadline is "at risk" once it is within this many days of falling due
 * (and not yet overdue). Powers the deadlines dashboard buckets.
 */
export const AT_RISK_DAYS = 30;

/** Epoch millis for the END of a YYYY-MM-DD calendar day (UTC). */
export function dueEndMs(dueDate: string): number {
  return Date.parse(`${dueDate}T23:59:59Z`);
}

/**
 * Verdict for a bare calendar deadline (a program's application deadline,
 * or an obligation that is not yet done):
 *   overdue   now is past the end of the due day
 *   at_risk   not overdue, but within `atRiskDays` of the due day
 *   upcoming  comfortably before the due day
 */
export function deadlineState(
  dueDate: string,
  nowMs: number,
  atRiskDays: number = AT_RISK_DAYS,
): DeadlineState {
  const end = dueEndMs(dueDate);
  if (nowMs > end) return 'overdue';
  if (nowMs >= end - atRiskDays * DAY_MS) return 'at_risk';
  return 'upcoming';
}

/**
 * Verdict for a reporting obligation. A fulfilled obligation is `done`
 * regardless of its date; otherwise it folds to the same overdue/at_risk/
 * upcoming verdict as any deadline.
 */
export function obligationState(
  dueDate: string,
  done: boolean,
  nowMs: number,
  atRiskDays: number = AT_RISK_DAYS,
): ObligationState {
  if (done) return 'done';
  return deadlineState(dueDate, nowMs, atRiskDays);
}
