export {
  fmtEur,
  fmtHm,
  fmtHoursDot,
  weekStartOf,
  weekEndOf,
  addDays,
} from '../shared/time';

/** "2026-07-19" from an ISO timestamp or date. */
export function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

/** Human status label for a timesheet status. */
export function statusLabel(status: string): string {
  return status.toUpperCase();
}
