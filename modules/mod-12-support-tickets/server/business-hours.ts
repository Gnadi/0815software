import type { BusinessWindow } from '../shared/types.js';

/**
 * The SLA clock: which stretches of time count towards a target. Around the
 * clock, everything counts; in business hours, only the opening windows of
 * each local weekday, minus holidays. Either way, pauses (a ticket waiting on
 * the requester, when the policy says so) are cut out.
 *
 * Pure functions of instants and a calendar — no stored state, no real clock.
 * Local times are turned into instants with Intl and the IANA zone, so a
 * window on the day the clocks change is as long as it really is.
 */

export type Interval = readonly [number, number];

export interface Calendar {
  timezone: string;
  /** Monday first. */
  week: BusinessWindow[][];
  holidays: ReadonlySet<string>;
}

/** `null` counts around the clock. */
export type Clock = Calendar | null;

const MINUTE = 60_000;
/** Ten years of days: a calendar with no window at all must not loop forever. */
const MAX_DAYS = 3660;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(tz, f);
  }
  return f;
}

function parts(ms: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), mi: Number(p.minute), s: Number(p.second) };
}

/** How far the zone is ahead of UTC at an instant, in ms. */
function offset(ms: number, tz: string): number {
  const p = parts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** The calendar date at an instant, where the office is. */
export function localDate(ms: number, tz: string): string {
  const p = parts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Monday 0 … Sunday 6. */
function weekdayIndex(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

/** The instant a local wall-clock time names. `24:00` is the next midnight. */
export function zonedInstant(date: string, time: string, tz: string): number {
  if (time === '24:00') return zonedInstant(addDays(date, 1), '00:00', tz);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, h, mi);
  // Two passes: the offset at the guess may differ from the offset at the
  // answer when the guess lands across a clock change.
  const first = wall - offset(wall, tz);
  const second = wall - offset(first, tz);
  return second;
}

/** Opening windows of one local day as instants (none on a holiday). */
function windowsOf(date: string, calendar: Calendar): Interval[] {
  if (calendar.holidays.has(date)) return [];
  return (calendar.week[weekdayIndex(date)] ?? []).map((w) => [zonedInstant(date, w.start, calendar.timezone), zonedInstant(date, w.end, calendar.timezone)] as const);
}

/** Cut the pauses out of one stretch. Pauses are sorted and do not overlap. */
function* minus(segment: Interval, pauses: readonly Interval[]): Generator<Interval> {
  let [s] = segment;
  const e = segment[1];
  for (const [ps, pe] of pauses) {
    if (pe <= s) continue;
    if (ps >= e) break;
    if (ps > s) yield [s, ps];
    s = Math.max(s, pe);
    if (s >= e) return;
  }
  if (s < e) yield [s, e];
}

/** The stretches the clock runs in, from `from` on, in order. */
function* running(from: number, clock: Clock, pauses: readonly Interval[]): Generator<Interval> {
  if (clock === null) {
    yield* minus([from, Number.MAX_SAFE_INTEGER], pauses);
    return;
  }
  let date = addDays(localDate(from, clock.timezone), -1); // a window may start the evening before
  for (let i = 0; i < MAX_DAYS; i++, date = addDays(date, 1)) {
    for (const [ws, we] of windowsOf(date, clock)) {
      const s = Math.max(ws, from);
      if (we > s) yield* minus([s, we], pauses);
    }
  }
}

/** Merge and sort pause intervals. */
export function normalisePauses(pauses: readonly Interval[]): Interval[] {
  const sorted = [...pauses].filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The instant at which `minutes` of running clock have passed since `from`. */
export function dueAt(from: number, minutes: number, clock: Clock, pauses: readonly Interval[] = []): number {
  let left = minutes * MINUTE;
  for (const [s, e] of running(from, clock, normalisePauses(pauses))) {
    if (e - s >= left) return s + left;
    left -= e - s;
  }
  // Only a calendar with no opening at all gets here; validation refuses one.
  return from + minutes * MINUTE;
}

/** Running-clock milliseconds between two instants. */
export function elapsedMs(from: number, to: number, clock: Clock, pauses: readonly Interval[] = []): number {
  let total = 0;
  if (to <= from) return 0;
  for (const [s, e] of running(from, clock, normalisePauses(pauses))) {
    if (s >= to) break;
    total += Math.min(e, to) - s;
  }
  return total;
}
