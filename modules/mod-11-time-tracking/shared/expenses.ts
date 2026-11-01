/**
 * Travel expenses under Austrian law — the arithmetic, shared by the server
 * (which is the authority) and the app (which previews it offline).
 *
 * Every amount here is DERIVED from what was recorded (times, kilometres,
 * meals) and from the rate in force on the day; nothing computed is stored.
 * The rates are the office's, versioned by date (server/expenses.ts), and
 * ship with the statutory ones:
 *
 *   § 26 Z 4 lit. b EStG — Tagesgeld (domestic) up to 30 € a day; a trip of
 *     more than three hours earns a twelfth for every hour begun; the full
 *     amount for 24 hours (or per calendar day, if so accounted).
 *   § 26 Z 4 lit. c EStG — Nächtigungsgeld up to 17 € a night, breakfast
 *     included, unless higher costs are shown by a receipt.
 *   § 26 Z 4 lit. d/e EStG — abroad, the Auslandsreisesätze of federal
 *     employees (Gebührenstufe 3): a day and a night rate per country.
 *   § 26 Z 4 lit. a EStG with § 10 Abs. 3–5 RGV — Kilometergeld 0,50 € per
 *     km by car, 0,25 € by motorbike and by bicycle, 0,15 € per passenger.
 *
 * A paid lunch or dinner on a domestic trip reduces that period's Tagesgeld
 * by a fixed amount (15 € since 2025, never below nothing) — the Lohnsteuer-
 * richtlinien, as secondary sources state them; the amount is a rate like the
 * others, so the office can correct it.
 */

export const EXPENSE_CATEGORIES = ['travel', 'accommodation', 'meals', 'fuel', 'parking', 'taxi', 'office', 'hospitality', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export const VEHICLES = ['car', 'motorbike', 'bicycle'] as const;
export type Vehicle = (typeof VEHICLES)[number];

/** The rates the office keeps, each versioned by date (server/expenses.ts). */
export const RATE_KINDS = [
  'per_diem_domestic',
  'night_domestic',
  'meal_reduction_domestic',
  'mileage_car',
  'mileage_motorbike',
  'mileage_bicycle',
  'mileage_passenger',
  // Per country, as the Auslandsreisesätze list them.
  'per_diem_abroad',
  'night_abroad',
] as const;
export type RateKind = (typeof RATE_KINDS)[number];
export const COUNTRY_RATE_KINDS: readonly RateKind[] = ['per_diem_abroad', 'night_abroad'];

export const RATE_LABELS: Record<RateKind, string> = {
  per_diem_domestic: 'Per diem, Austria (Tagesgeld)',
  night_domestic: 'Night allowance, Austria (Nächtigungsgeld)',
  meal_reduction_domestic: 'Reduction per paid lunch or dinner',
  mileage_car: 'Mileage, car (Kilometergeld)',
  mileage_motorbike: 'Mileage, motorbike or moped',
  mileage_bicycle: 'Mileage, bicycle',
  mileage_passenger: 'Passenger supplement, car',
  per_diem_abroad: 'Per diem abroad',
  night_abroad: 'Night allowance abroad',
};

export const PER_DIEM_MODES = ['24h', 'calendar'] as const;
export type PerDiemMode = (typeof PER_DIEM_MODES)[number];

/** A trip of three hours or less earns no Tagesgeld (§ 26 Z 4 lit. b EStG). */
export const MIN_MINUTES = 180;

/** Twelfths of the daily rate a period earns: one per hour begun, past three hours, at most twelve. */
export function twelfths(minutes: number): number {
  if (minutes <= MIN_MINUTES) return 0;
  return Math.min(12, Math.ceil(minutes / 60));
}

export interface Period {
  /** Minutes away in this period. */
  minutes: number;
  /** Abroad: the country's rate applies. */
  abroad: boolean;
}

export interface PerDiemLine {
  index: number;
  minutes: number;
  abroad: boolean;
  twelfths: number;
  /** The daily rate that applied. */
  rate_cents: number;
  /** Paid lunches and dinners counted against it. */
  meals: number;
  reduction_cents: number;
  amount_cents: number;
}

/** The daily rates a trip's periods are priced with, in cents. */
export interface DayRates {
  /** Tagesgeld for a domestic period. */
  domestic_day_cents: number;
  /** What one paid lunch or dinner takes off a domestic period. */
  meal_reduction_cents: number;
  /** Tagesgeld for a period abroad: the country's rate; null for a domestic trip. */
  foreign_day_cents: number | null;
}

/**
 * Tagesgeld per period. `meals[i]` is the number of paid lunches and dinners
 * in period i (two at most count); abroad they do not reduce the amount here
 * (the foreign rules differ and are the office's to apply).
 */
export function perDiemLines(periods: readonly Period[], rates: DayRates, meals: readonly number[] = []): PerDiemLine[] {
  return periods.map((p, index) => {
    const rate = p.abroad ? (rates.foreign_day_cents ?? 0) : rates.domestic_day_cents;
    const t = twelfths(p.minutes);
    const gross = Math.round((rate * t) / 12);
    const mealCount = p.abroad ? 0 : Math.max(0, Math.min(2, Math.trunc(meals[index] ?? 0)));
    const reduction = Math.min(gross, mealCount * rates.meal_reduction_cents);
    return { index, minutes: p.minutes, abroad: p.abroad, twelfths: t, rate_cents: rate, meals: mealCount, reduction_cents: reduction, amount_cents: gross - reduction };
  });
}

/** Kilometergeld: kilometres in tenths, so 12,3 km is exact. */
export function mileageCents(kmTenths: number, vehicle: Vehicle, passengers: number, rates: { vehicle_cents: number; passenger_cents: number }): number {
  const own = Math.round((kmTenths * rates.vehicle_cents) / 10);
  // The passenger supplement is a car's (§ 10 Abs. 4 RGV).
  const extra = vehicle === 'car' ? Math.round((kmTenths * rates.passenger_cents * Math.max(0, passengers)) / 10) : 0;
  return own + extra;
}

/** The rate kind a vehicle is paid by. */
export function mileageKind(vehicle: Vehicle): RateKind {
  return vehicle === 'car' ? 'mileage_car' : vehicle === 'motorbike' ? 'mileage_motorbike' : 'mileage_bicycle';
}

/** Nights a trip spans: the local dates from departure to return, less one. */
export function nightsSpanned(startLocal: string, endLocal: string): number {
  const day = (s: string) => Date.UTC(Number(s.slice(0, 4)), Number(s.slice(5, 7)) - 1, Number(s.slice(8, 10)));
  return Math.max(0, Math.round((day(endLocal) - day(startLocal)) / 86_400_000));
}

// ── Time zones, without a library ─────────────────────────────────────

/** The wall-clock parts of an instant where the office is. */
export function zonedParts(ms: number, tz: string): { y: number; m: number; d: number; h: number; mi: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), mi: Number(parts.minute) };
}

function offsetAt(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) - Math.floor(ms / 60_000) * 60_000;
}

/** `2026-03-29T02:30` in `tz` as an instant (a time skipped by DST moves forward). */
export function instantOf(local: string, tz: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Error(`"${local}" is not a local date and time (YYYY-MM-DDTHH:MM)`);
  const naive = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let guess = naive - offsetAt(naive, tz);
  guess = naive - offsetAt(guess, tz);
  return guess;
}

export function localDateOf(ms: number, tz: string): string {
  const p = zonedParts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function nextMidnight(ms: number, tz: string): number {
  const p = zonedParts(ms, tz);
  const next = new Date(Date.UTC(p.y, p.m - 1, p.d + 1));
  return instantOf(`${next.toISOString().slice(0, 10)}T00:00`, tz);
}

/** Split [start, end) into 24-hour blocks from the start, or into calendar days. */
export function splitPeriods(start: number, end: number, mode: PerDiemMode, tz: string, abroad = false): Period[] {
  const out: Period[] = [];
  let at = start;
  while (at < end && out.length < 400) {
    const stop = Math.min(end, mode === '24h' ? at + 24 * 3600_000 : nextMidnight(at, tz));
    out.push({ minutes: Math.round((stop - at) / 60_000), abroad });
    at = stop;
  }
  return out;
}

export interface TripTimes {
  start: string;
  end: string;
  /** Foreign trips: when the border was crossed out and back. Without them the whole trip counts as abroad. */
  border_out?: string | null;
  border_in?: string | null;
  abroad: boolean;
}

/**
 * The periods a trip earns Tagesgeld for. Abroad, the time between the border
 * crossings is split by itself at the foreign rate; the domestic time before
 * and after is added up and split as one domestic stretch.
 */
export function tripPeriods(trip: TripTimes, mode: PerDiemMode, tz: string): Period[] {
  const start = instantOf(trip.start, tz);
  const end = instantOf(trip.end, tz);
  if (!(end > start)) return [];
  if (!trip.abroad) return splitPeriods(start, end, mode, tz, false);
  if (!trip.border_out || !trip.border_in) return splitPeriods(start, end, mode, tz, true);
  const out = Math.max(start, instantOf(trip.border_out, tz));
  const back = Math.min(end, instantOf(trip.border_in, tz));
  if (!(back > out)) return splitPeriods(start, end, mode, tz, false);
  const abroadPeriods = splitPeriods(out, back, mode, tz, true);
  const domestic = out - start + (end - back);
  const domesticPeriods = domestic > 0 ? splitPeriods(0, domestic, '24h', tz, false) : [];
  return [...domesticPeriods, ...abroadPeriods];
}
