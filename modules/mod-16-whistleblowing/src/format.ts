/** "2026-07-09" from an ISO timestamp or date. */
export function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

/** "2026-07-09 09:25" from an ISO timestamp. */
export function fmtDateTime(iso: string): string {
  return iso.replace('T', ' ').replace(/(:\d{2})?Z$/, '').slice(0, 16);
}

/**
 * A deadline distance in the words a compliance officer uses: "4 days left",
 * "3 days late", "due today". Never a bare negative number — somebody reading
 * "−3" at a glance reads it as "3".
 */
export function fmtDeadline(daysRemaining: number): string {
  if (daysRemaining === 0) return 'due today';
  if (daysRemaining > 0) return `${daysRemaining} day${daysRemaining === 1 ? '' : 's'} left`;
  const late = Math.abs(daysRemaining);
  return `${late} day${late === 1 ? '' : 's'} late`;
}

const STATE_LABELS: Record<string, string> = {
  met: 'MET',
  missed: 'MISSED',
  at_risk: 'AT RISK',
  upcoming: 'UPCOMING',
};

export function stateLabel(state: string): string {
  return STATE_LABELS[state] ?? state.toUpperCase();
}

/** `received` → `RECEIVED`, `partly_substantiated` → `PARTLY SUBSTANTIATED`. */
export function humanize(value: string): string {
  return value.replace(/_/g, ' ').toUpperCase();
}
