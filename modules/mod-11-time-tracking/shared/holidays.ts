/**
 * Public holidays — the days nobody books leave for.
 *
 * Statutory, nationwide days only; what differs by Land/Bundesland (DE:
 * Heilige Drei Könige, Fronleichnam, Reformationstag … ; AT: the Landespatron)
 * and company days (24./31.12.) are the admin's extra days in Settings.
 *
 * - **AT** — Feiertagsruhegesetz 1957 § 7 (and ARG § 7 Abs. 2): 13 days. Good
 *   Friday is no longer a holiday since 2019.
 * - **DE** — the nine days that are holidays in every Land.
 *
 * Moveable feasts hang off Easter Sunday (anonymous Gregorian algorithm,
 * Meeus/Jones/Butcher). `test/holidays.test.ts` checks the result against
 * the published calendars, not against this file's own arithmetic.
 */

export type Country = 'AT' | 'DE';
export const COUNTRIES: readonly Country[] = ['AT', 'DE'];

export interface Holiday {
  date: string;
  name: string;
}

/** Easter Sunday of a Gregorian year, as YYYY-MM-DD. */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The statutory holidays of a country in a year, in date order. */
export function publicHolidays(year: number, country: Country): Holiday[] {
  const easter = easterSunday(year);
  const fixed = (mmdd: string, name: string): Holiday => ({ date: `${year}-${mmdd}`, name });
  const moveable = (offset: number, name: string): Holiday => ({ date: addDays(easter, offset), name });
  const days =
    country === 'AT'
      ? [
          fixed('01-01', 'Neujahr'),
          fixed('01-06', 'Heilige Drei Könige'),
          moveable(1, 'Ostermontag'),
          fixed('05-01', 'Staatsfeiertag'),
          moveable(39, 'Christi Himmelfahrt'),
          moveable(50, 'Pfingstmontag'),
          moveable(60, 'Fronleichnam'),
          fixed('08-15', 'Mariä Himmelfahrt'),
          fixed('10-26', 'Nationalfeiertag'),
          fixed('11-01', 'Allerheiligen'),
          fixed('12-08', 'Mariä Empfängnis'),
          fixed('12-25', 'Christtag'),
          fixed('12-26', 'Stefanitag'),
        ]
      : [
          fixed('01-01', 'Neujahr'),
          moveable(-2, 'Karfreitag'),
          moveable(1, 'Ostermontag'),
          fixed('05-01', 'Tag der Arbeit'),
          moveable(39, 'Christi Himmelfahrt'),
          moveable(50, 'Pfingstmontag'),
          fixed('10-03', 'Tag der Deutschen Einheit'),
          fixed('12-25', '1. Weihnachtstag'),
          fixed('12-26', '2. Weihnachtstag'),
        ];
  return days.sort((x, y) => x.date.localeCompare(y.date));
}

/** ISO weekday, Monday = 1 … Sunday = 7. */
export function isoWeekday(date: string): number {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}
