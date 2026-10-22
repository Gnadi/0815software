export {
  fmtEur,
  fmtHm,
  fmtHoursDot,
  fmtSignedHm,
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

/**
 * Hours typed by a person — "38,5", "38.5" or "38:30" — as whole minutes, or
 * null when it is not a number of hours. Signed, for corrections ("-2:15").
 */
export function parseHours(text: string): number | null {
  const t = text.trim();
  const hm = /^(-?)(\d+):([0-5]\d)$/.exec(t);
  if (hm) return (hm[1] ? -1 : 1) * (Number(hm[2]) * 60 + Number(hm[3]));
  if (!/^-?\d+(?:[.,]\d+)?$/.test(t)) return null;
  return Math.round(Number(t.replace(',', '.')) * 60);
}
