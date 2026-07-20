/** "2026-07-09" from an ISO timestamp or date. */
export function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

/** "in 12 days" / "today" / "5 days ago" for the onboarding view. */
export function fmtRelativeDays(days: number): string {
  if (days === 0) return 'today';
  if (days > 0) return days === 1 ? 'in 1 day' : `in ${days} days`;
  return days === -1 ? '1 day ago' : `${-days} days ago`;
}
