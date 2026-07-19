/**
 * Time & money math — THE core correctness property of this module.
 *
 * Duration is stored as an integer number of MINUTES, never as a float
 * number of hours. Hours only ever exist at the rendering edge (a
 * timesheet reads "1.75 h", payroll reads "1.75"), exactly the way money
 * lives as integer cents. Every billable amount is DERIVED from minutes
 * and the project's hourly rate by the one function below, shared by the
 * server (API + CSV export), the client (live previews) and the tests —
 * so the numbers on screen, in the API and in an export can never
 * disagree, and nothing can drift.
 *
 * Rounding rule for money (documented and tested):
 *
 *   billable_cents = round(minutes × rate_cents ÷ 60)
 *
 * The division happens on the integer product `minutes × rate_cents`, so
 * money is computed from EXACT minutes — never from the 2-decimal
 * "decimal hours" used for display/payroll. That avoids double rounding:
 * a 7-minute entry at €90/h nets round(7 × 9000 ÷ 60) = round(1050) =
 * 1050 cents, not round(0.12 h × €90) off a truncated hours figure.
 * round() is half-away-from-zero on non-negative inputs (Math.round).
 */

/** Minutes in a day — the hard cap on a single (employee, date) total. */
export const MAX_MINUTES_PER_DAY = 24 * 60;

/** Billable amount in integer cents for a duration at an hourly rate. */
export function billableCents(minutes: number, rateCents: number): number {
  return Math.round((minutes * rateCents) / 60);
}

/** Exact decimal hours as a number (minutes / 60). Formatting is separate. */
export function hoursOf(minutes: number): number {
  return minutes / 60;
}

/** "1.75" — decimal hours rounded to 2 places, dot decimal. */
export function fmtHoursDot(minutes: number): string {
  return (minutes / 60).toFixed(2);
}

/** "1,75" — decimal hours rounded to 2 places, comma decimal (de-AT). */
export function fmtHoursComma(minutes: number): string {
  return (minutes / 60).toFixed(2).replace('.', ',');
}

/** "1:45" — hours and minutes, the human daily-grid format. */
export function fmtHm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}:${String(m).padStart(2, '0')}`;
}

/** "1.234,56 €" from integer cents — deterministic de-AT formatting. */
export function fmtEur(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  const abs = Math.abs(cents);
  const euros = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const rest = String(abs % 100).padStart(2, '0');
  return `${sign}${euros},${rest} €`;
}

const DAY_MS = 86_400_000;

/**
 * Monday (ISO week start) of the week containing `date`, as "YYYY-MM-DD".
 * Weeks run Monday..Sunday; a timesheet is keyed by this Monday.
 */
export function weekStartOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay(); // 0=Sun … 6=Sat
  const offset = (dow + 6) % 7; // days since Monday
  return new Date(d.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
}

/** date + n days, both "YYYY-MM-DD" (UTC, DST-free arithmetic). */
export function addDays(date: string, days: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** The Sunday that closes the week starting at `weekStart`. */
export function weekEndOf(weekStart: string): string {
  return addDays(weekStart, 6);
}
