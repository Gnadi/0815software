/**
 * Public holidays and working days for Germany and Austria.
 *
 * THE core of this module. Leave is counted in working days, so every balance,
 * every request and every report rests on this file being right — and "right"
 * here is a legal question with a different answer in each Bundesland.
 *
 * Holidays are COMPUTED, never stored. A table of dates is a table that is
 * wrong the year nobody remembers to extend it, and the failure is silent:
 * requests spanning an unlisted holiday quietly cost a day too many, and
 * nobody notices until an employee counts. The rules below are stable law, so
 * computing them is both cheaper and more durable than maintaining data.
 *
 * Everything is date-only. Dates are "YYYY-MM-DD" strings and arithmetic goes
 * through UTC, so no deployment's timezone can shift a holiday onto the day
 * before — the bug that makes a December stack disagree with a June one.
 */

/** German federal states, plus Austria as a whole. */
export const REGIONS = [
  'DE-BW', 'DE-BY', 'DE-BE', 'DE-BB', 'DE-HB', 'DE-HH', 'DE-HE', 'DE-MV',
  'DE-NI', 'DE-NW', 'DE-RP', 'DE-SL', 'DE-SN', 'DE-ST', 'DE-SH', 'DE-TH',
  'AT',
] as const;
export type Region = (typeof REGIONS)[number];

export const REGION_LABELS: Record<Region, string> = {
  'DE-BW': 'Baden-Württemberg',
  'DE-BY': 'Bayern',
  'DE-BE': 'Berlin',
  'DE-BB': 'Brandenburg',
  'DE-HB': 'Bremen',
  'DE-HH': 'Hamburg',
  'DE-HE': 'Hessen',
  'DE-MV': 'Mecklenburg-Vorpommern',
  'DE-NI': 'Niedersachsen',
  'DE-NW': 'Nordrhein-Westfalen',
  'DE-RP': 'Rheinland-Pfalz',
  'DE-SL': 'Saarland',
  'DE-SN': 'Sachsen',
  'DE-ST': 'Sachsen-Anhalt',
  'DE-SH': 'Schleswig-Holstein',
  'DE-TH': 'Thüringen',
  AT: 'Österreich',
};

export function isRegion(value: unknown): value is Region {
  return typeof value === 'string' && (REGIONS as readonly string[]).includes(value);
}

// ── Date helpers (UTC throughout) ──────────────────────────────────────

/** "YYYY-MM-DD" → a UTC midnight Date. */
export function parseDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

/** A UTC Date → "YYYY-MM-DD". */
export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** "YYYY-MM-DD", and a real day — 2026-02-30 is neither. */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  return formatDate(parseDate(value)) === value;
}

export function addDays(iso: string, days: number): string {
  const date = parseDate(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

/** 0 = Sunday … 6 = Saturday, in UTC. */
export function weekday(iso: string): number {
  return parseDate(iso).getUTCDay();
}

export function isWeekend(iso: string): boolean {
  const day = weekday(iso);
  return day === 0 || day === 6;
}

// ── Easter, and everything that hangs off it ───────────────────────────

/**
 * Easter Sunday, by the anonymous Gregorian algorithm.
 *
 * Five of the holidays below are defined relative to it and three of those are
 * public holidays somewhere in every German state, so an off-by-one here is an
 * off-by-one in a lot of people's leave balances.
 */
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
  return formatDate(new Date(Date.UTC(year, month - 1, day)));
}

export interface Holiday {
  date: string;
  name: string;
  /** True when it applies in every region of its country. */
  nationwide: boolean;
}

/** The Wednesday before 23 November — Buß- und Bettag, a holiday in Sachsen. */
function bussUndBettag(year: number): string {
  // Walk back from the 22nd to the previous Wednesday (weekday 3).
  let date = formatDate(new Date(Date.UTC(year, 10, 22)));
  while (weekday(date) !== 3) date = addDays(date, -1);
  return date;
}

/**
 * German public holidays for a state.
 *
 * Holidays that apply only in PARTS of a state — Fronleichnam in some Saxon and
 * Thuringian municipalities, Mariä Himmelfahrt in Catholic Bavarian ones — are
 * deliberately left out. They depend on the municipality, not the state, and a
 * module that guessed would be wrong for most employees in those states.
 * Getting them right needs a per-employee municipality, which is an extension.
 */
function germanHolidays(year: number, state: Region): Holiday[] {
  const easter = easterSunday(year);
  const nation: Holiday[] = [
    { date: `${year}-01-01`, name: 'Neujahr', nationwide: true },
    { date: addDays(easter, -2), name: 'Karfreitag', nationwide: true },
    { date: addDays(easter, 1), name: 'Ostermontag', nationwide: true },
    { date: `${year}-05-01`, name: 'Tag der Arbeit', nationwide: true },
    { date: addDays(easter, 39), name: 'Christi Himmelfahrt', nationwide: true },
    { date: addDays(easter, 50), name: 'Pfingstmontag', nationwide: true },
    { date: `${year}-10-03`, name: 'Tag der Deutschen Einheit', nationwide: true },
    { date: `${year}-12-25`, name: '1. Weihnachtsfeiertag', nationwide: true },
    { date: `${year}-12-26`, name: '2. Weihnachtsfeiertag', nationwide: true },
  ];

  const regional: [Holiday, Region[]][] = [
    [{ date: `${year}-01-06`, name: 'Heilige Drei Könige', nationwide: false }, ['DE-BW', 'DE-BY', 'DE-ST']],
    [{ date: `${year}-03-08`, name: 'Internationaler Frauentag', nationwide: false }, ['DE-BE', 'DE-MV']],
    [
      { date: addDays(easter, 60), name: 'Fronleichnam', nationwide: false },
      ['DE-BW', 'DE-BY', 'DE-HE', 'DE-NW', 'DE-RP', 'DE-SL'],
    ],
    [{ date: `${year}-08-15`, name: 'Mariä Himmelfahrt', nationwide: false }, ['DE-SL']],
    [{ date: `${year}-09-20`, name: 'Weltkindertag', nationwide: false }, ['DE-TH']],
    [
      { date: `${year}-10-31`, name: 'Reformationstag', nationwide: false },
      ['DE-BB', 'DE-HB', 'DE-HH', 'DE-MV', 'DE-NI', 'DE-SN', 'DE-ST', 'DE-SH', 'DE-TH'],
    ],
    [
      { date: `${year}-11-01`, name: 'Allerheiligen', nationwide: false },
      ['DE-BW', 'DE-BY', 'DE-NW', 'DE-RP', 'DE-SL'],
    ],
    [{ date: bussUndBettag(year), name: 'Buß- und Bettag', nationwide: false }, ['DE-SN']],
  ];

  return [...nation, ...regional.filter(([, states]) => states.includes(state)).map(([holiday]) => holiday)];
}

/**
 * Austrian public holidays (Arbeitsruhegesetz).
 *
 * One national list: Austria's Landespatrone are not statutory rest days, so
 * unlike Germany there is nothing per-Bundesland to model.
 *
 * KARFREITAG IS NOT HERE, deliberately. It stopped being a public holiday for
 * members of the Protestant and Old Catholic churches in 2019; what replaced it
 * is a "persönlicher Feiertag" every employee may claim on a day of their
 * choosing — which is leave, not a holiday, and so belongs to a request rather
 * than to this calendar.
 */
function austrianHolidays(year: number): Holiday[] {
  const easter = easterSunday(year);
  return [
    { date: `${year}-01-01`, name: 'Neujahr', nationwide: true },
    { date: `${year}-01-06`, name: 'Heilige Drei Könige', nationwide: true },
    { date: addDays(easter, 1), name: 'Ostermontag', nationwide: true },
    { date: `${year}-05-01`, name: 'Staatsfeiertag', nationwide: true },
    { date: addDays(easter, 39), name: 'Christi Himmelfahrt', nationwide: true },
    { date: addDays(easter, 50), name: 'Pfingstmontag', nationwide: true },
    { date: addDays(easter, 60), name: 'Fronleichnam', nationwide: true },
    { date: `${year}-08-15`, name: 'Mariä Himmelfahrt', nationwide: true },
    { date: `${year}-10-26`, name: 'Nationalfeiertag', nationwide: true },
    { date: `${year}-11-01`, name: 'Allerheiligen', nationwide: true },
    { date: `${year}-12-08`, name: 'Mariä Empfängnis', nationwide: true },
    { date: `${year}-12-25`, name: 'Christtag', nationwide: true },
    { date: `${year}-12-26`, name: 'Stefanitag', nationwide: true },
  ];
}

/** Every public holiday in `region` during `year`, ascending. */
export function holidays(year: number, region: Region): Holiday[] {
  const list = region === 'AT' ? austrianHolidays(year) : germanHolidays(year, region);
  return [...list].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * A holiday lookup for a span of years.
 *
 * Built once per query rather than per day: a year's worth of leave asks about
 * ~250 days, and recomputing Easter for each of them is work nobody needs.
 */
export function holidayMap(fromYear: number, toYear: number, region: Region): Map<string, string> {
  const map = new Map<string, string>();
  for (let year = fromYear; year <= toYear; year += 1) {
    for (const holiday of holidays(year, region)) map.set(holiday.date, holiday.name);
  }
  return map;
}

// ── Working days ───────────────────────────────────────────────────────

/** Neither a weekend nor a public holiday in `region`. */
export function isWorkingDay(iso: string, region: Region, map?: Map<string, string>): boolean {
  if (isWeekend(iso)) return false;
  const holidayNames = map ?? holidayMap(Number(iso.slice(0, 4)), Number(iso.slice(0, 4)), region);
  return !holidayNames.has(iso);
}

/** Every working day in `[from, to]`, inclusive at both ends. */
export function workingDaysBetween(from: string, to: string, region: Region): string[] {
  if (from > to) return [];
  const map = holidayMap(Number(from.slice(0, 4)), Number(to.slice(0, 4)), region);
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (isWorkingDay(day, region, map)) days.push(day);
  }
  return days;
}

/**
 * How many leave days a span costs.
 *
 * Half days are only meaningful at the EDGES of a span — a half day in the
 * middle of a week off is not a thing anyone books — so `halfStart` and
 * `halfEnd` each subtract 0.5, and a single-day request that is half at both
 * ends is still half a day, not zero.
 */
export function leaveDays(
  from: string,
  to: string,
  region: Region,
  { halfStart = false, halfEnd = false } = {},
): number {
  const days = workingDaysBetween(from, to, region);
  if (days.length === 0) return 0;
  if (days.length === 1) return halfStart || halfEnd ? 0.5 : 1;
  return days.length - (halfStart ? 0.5 : 0) - (halfEnd ? 0.5 : 0);
}
