export { fmtEur } from '../shared/money';

/** "2026-07-09 09:25" from an ISO timestamp. */
export function fmtDateTime(iso: string): string {
  return iso.replace('T', ' ').replace(/(:\d{2})?Z$/, '').slice(0, 16);
}

/** "2026-07-09" from an ISO timestamp or date. */
export function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * Signed relative distance in days from now to a YYYY-MM-DD date, e.g.
 * "in 12d", "today", "5d ago". Used to render deadline distances.
 */
export function fmtDaysUntil(date: string, now: number = Date.now()): string {
  const due = Date.parse(`${date}T23:59:59Z`);
  const deltaDay = Math.round((due - now) / 86_400_000);
  if (deltaDay === 0) return 'today';
  return deltaDay > 0 ? `in ${deltaDay}d` : `${Math.abs(deltaDay)}d ago`;
}

/** Parse a euros text field ("1.234,56" or "1234.56") into integer cents. */
export function eurosToCents(text: string): number | null {
  const cleaned = text.trim().replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (cleaned === '' || !/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}

/** Plain "1234.56" euros string from integer cents, for editable inputs. */
export function centsToInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

const OBLIGATION_LABELS: Record<string, string> = {
  done: 'DONE',
  overdue: 'OVERDUE',
  at_risk: 'AT RISK',
  upcoming: 'UPCOMING',
};

export function stateLabel(state: string): string {
  return OBLIGATION_LABELS[state] ?? state.toUpperCase();
}
