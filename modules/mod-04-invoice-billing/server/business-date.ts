/**
 * Business dates — the day an invoice is issued, falls due, is paid, cancelled
 * or dunned — are days in the seller's time zone, not in UTC. In UTC it is
 * still yesterday until 01:00 (CET) or 02:00 (CEST): an invoice issued at
 * 00:30 was dated the day before, and on New Year's night numbered in the old
 * year (review N1). Timestamps (`created_at`, `cancelled_at`) stay instants
 * in UTC; only the day one falls on is read in this zone.
 *
 * One zone per process, BUSINESS_TIMEZONE (server/config.ts), set before the
 * database is opened: the report views count overdue days in it too.
 */

export const DEFAULT_BUSINESS_TIMEZONE = 'Europe/Berlin';

const clocks = new Map<string, Intl.DateTimeFormat>();

/** The wall clock of `timeZone`. Throws a RangeError for a zone Intl does not know. */
function clockOf(timeZone: string): Intl.DateTimeFormat {
  let clock = clocks.get(timeZone);
  if (clock === undefined) {
    clock = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    clocks.set(timeZone, clock);
  }
  return clock;
}

/** Null when `timeZone` is an IANA zone this runtime knows, else why it is not. */
export function timeZoneProblem(timeZone: string): string | null {
  try {
    clockOf(timeZone);
    return null;
  } catch {
    return `"${timeZone}" is not an IANA time zone such as Europe/Berlin or Europe/Vienna`;
  }
}

let zone = DEFAULT_BUSINESS_TIMEZONE;

/** Set at start-up (server/index.ts); throws rather than fall back to UTC on a typo. */
export function setBusinessTimeZone(timeZone: string): void {
  const problem = timeZoneProblem(timeZone);
  if (problem !== null) throw new Error(`BUSINESS_TIMEZONE: ${problem}`);
  zone = timeZone;
}

export function businessTimeZone(): string {
  return zone;
}

/** Year … second as the wall clock of `timeZone` shows `instant`. */
function wallClock(timeZone: string, instant: Date): Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number> {
  const parts: Record<string, number> = {};
  for (const part of clockOf(timeZone).formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts as Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>;
}

/** "YYYY-MM-DD": the day `instant` falls on in the business time zone. */
export function businessDate(instant: Date = new Date(), timeZone: string = zone): string {
  const { year, month, day } = wallClock(timeZone, instant);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Minutes `timeZone` is ahead of UTC at `instant`: 60 in CET, 120 in CEST. */
export function utcOffsetMinutes(timeZone: string, instant: Date): number {
  const c = wallClock(timeZone, instant);
  const wall = Date.UTC(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  return Math.round((wall - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

const MINUTE = 60_000;
const WEEK = 7 * 24 * 60 * MINUTE;

/**
 * The instants in [from, to) at which `timeZone` changes its UTC offset, to
 * the minute, with the offset from then on. Sampled weekly and bisected:
 * zones change their offset months apart, never twice in a week.
 */
function offsetChanges(timeZone: string, from: number, to: number): { at: number; offset: number }[] {
  const changes: { at: number; offset: number }[] = [];
  let before = from;
  let offset = utcOffsetMinutes(timeZone, new Date(from));
  for (let t = from + WEEK; t < to + WEEK; t += WEEK) {
    const next = utcOffsetMinutes(timeZone, new Date(t));
    if (next !== offset) {
      let lo = before;
      let hi = t;
      while (hi - lo > MINUTE) {
        const mid = lo + Math.floor((hi - lo) / 2 / MINUTE) * MINUTE;
        if (utcOffsetMinutes(timeZone, new Date(mid)) === offset) lo = mid;
        else hi = mid;
      }
      changes.push({ at: hi, offset: next });
      offset = next;
    }
    before = t;
  }
  return changes;
}

const daySqlCache = new Map<string, string>();

/**
 * The business date of the SQL instant `now` as an SQLite expression, for the
 * report views: SQLite knows UTC and the local time of whichever process
 * reads the file, but no IANA zones. So the zone's offsets go into the view,
 * with the instants they change at, from the start of last year to thirty
 * years ahead — the views are rebuilt on every start, and the window moves
 * along. `now` is a parameter so a test can compare it with `businessDate`.
 */
export function businessDaySql(now = "'now'", timeZone: string = zone, year = new Date().getUTCFullYear()): string {
  const key = `${timeZone} ${year} ${now}`;
  const cached = daySqlCache.get(key);
  if (cached !== undefined) return cached;
  const from = Date.UTC(year - 1, 0, 1);
  const changes = offsetChanges(timeZone, from, Date.UTC(year + 30, 0, 1));
  const modifier = (minutes: number): string => `'${minutes < 0 ? '-' : '+'}${Math.abs(minutes)} minutes'`;
  let offset = utcOffsetMinutes(timeZone, new Date(from));
  let sql: string;
  if (changes.length === 0) {
    sql = offset === 0 ? `date(${now})` : `date(${now}, ${modifier(offset)})`;
  } else {
    const epoch = `CAST(strftime('%s', ${now}) AS INTEGER)`;
    const whens = changes.map((change) => {
      const when = `WHEN ${epoch} < ${change.at / 1000} THEN ${modifier(offset)}`;
      offset = change.offset;
      return when;
    });
    sql = `date(${now}, CASE ${whens.join(' ')} ELSE ${modifier(offset)} END)`;
  }
  daySqlCache.set(key, sql);
  return sql;
}
