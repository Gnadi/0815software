/** "2026-07-09" from an ISO timestamp or date. */
export function fmtDate(iso: string): string {
  return iso.slice(0, 10);
}

/** "2026-07-09 09:25" from an ISO timestamp. */
export function fmtDateTime(iso: string): string {
  return iso.replace('T', ' ').replace(/(:\d{2})?Z$/, '').slice(0, 16);
}

/**
 * A day count as a human writes it: 12, 12.5 — never 12.50 and never
 * 12.499999999999998. The server stores tenths of a day as integers precisely
 * so this can be a formatting concern and not an arithmetic one.
 */
export function fmtDays(days: number): string {
  return Number.isInteger(days) ? String(days) : days.toFixed(1);
}

/** "3 Aug – 14 Aug 2026", collapsing a single day to "3 Aug 2026". */
export function fmtRange(from: string, to: string): string {
  const [fy, fm, fd] = from.split('-') as [string, string, string];
  const [ty, tm, td] = to.split('-') as [string, string, string];
  const month = (m: string): string =>
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m) - 1] ?? m;
  const start = `${Number(fd)} ${month(fm)}`;
  const end = `${Number(td)} ${month(tm)} ${ty}`;
  if (from === to) return end;
  return fy === ty ? `${start} – ${end}` : `${start} ${fy} – ${end}`;
}

/** The German weekday initial row a calendar grid is read against. */
export const WEEKDAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

/** "MARCH 2026" for a month header. */
export function fmtMonth(year: number, monthIndex: number): string {
  const names = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];
  return `${names[monthIndex]} ${year}`;
}
