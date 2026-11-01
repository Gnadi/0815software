import { describe, expect, it } from 'vitest';
import { instantOf, mileageCents, nightsSpanned, perDiemLines, splitPeriods, tripPeriods, twelfths } from '../shared/expenses.js';

/**
 * The arithmetic of Austrian travel expenses (shared/expenses.ts), against
 * the text of the law:
 *
 *   § 26 Z 4 lit. b EStG — "Das Tagesgeld für Inlandsdienstreisen darf bis zu
 *     30 Euro pro Tag betragen. Dauert eine Dienstreise länger als drei
 *     Stunden, so kann für jede angefangene Stunde ein Zwölftel gerechnet
 *     werden. Das volle Tagesgeld steht für 24 Stunden zu. Erfolgt eine
 *     Abrechnung des Tagesgeldes nach Kalendertagen, steht das Tagesgeld für
 *     den Kalendertag zu."
 *   § 10 Abs. 3–5 RGV — 0,50 € (Pkw), 0,25 € (Motorrad), 0,25 € (Fahrrad),
 *     0,15 € per passenger, per kilometre.
 *
 * The rates are passed in, as the server passes the ones in force.
 */

const TZ = 'Europe/Vienna';
const AT = { domestic_day_cents: 3000, meal_reduction_cents: 1500, foreign_day_cents: null };
const sum = (lines: { amount_cents: number }[]) => lines.reduce((a, l) => a + l.amount_cents, 0);
const domestic = (minutes: number) => [{ minutes, abroad: false }];

describe('Tagesgeld: a twelfth per hour begun, after three hours', () => {
  it('three hours exactly earn nothing; a minute more earns four twelfths', () => {
    expect(twelfths(180)).toBe(0);
    expect(twelfths(181)).toBe(4);
    expect(sum(perDiemLines(domestic(181), AT))).toBe(1000);
  });

  it('eleven hours are 27,50 €; twelve and more are the full 30 €', () => {
    expect(sum(perDiemLines(domestic(660), AT))).toBe(2750);
    expect(sum(perDiemLines(domestic(661), AT))).toBe(3000);
    expect(sum(perDiemLines(domestic(1440), AT))).toBe(3000);
  });

  it('by 24-hour blocks: 25 hours are one day (the last hour is under three), 28 hours a day and four twelfths', () => {
    const start = instantOf('2026-05-11T08:00', TZ);
    expect(splitPeriods(start, start + 25 * 3600_000, '24h', TZ).map((p) => p.minutes)).toEqual([1440, 60]);
    expect(sum(perDiemLines(splitPeriods(start, start + 25 * 3600_000, '24h', TZ), AT))).toBe(3000);
    expect(sum(perDiemLines(splitPeriods(start, start + 28 * 3600_000, '24h', TZ), AT))).toBe(4000);
  });

  it('by calendar day: the same 18 hours from 16:00 are two days, 8 and 10 hours', () => {
    const trip = { start: '2026-05-11T16:00', end: '2026-05-12T10:00', abroad: false };
    expect(sum(perDiemLines(tripPeriods(trip, '24h', TZ), AT))).toBe(3000);
    const calendar = tripPeriods(trip, 'calendar', TZ);
    expect(calendar.map((p) => p.minutes)).toEqual([480, 600]);
    expect(sum(perDiemLines(calendar, AT))).toBe(2000 + 2500);
  });

  it('counts the hours that passed: the night the clocks go forward is an hour shorter', () => {
    // 29 March 2026, 02:00 → 03:00 in Vienna: 20:00 to 08:00 is eleven hours.
    const trip = { start: '2026-03-28T20:00', end: '2026-03-29T08:00', abroad: false };
    expect(tripPeriods(trip, '24h', TZ)).toEqual([{ minutes: 660, abroad: false }]);
    expect(sum(perDiemLines(tripPeriods(trip, '24h', TZ), AT))).toBe(2750);
    // By calendar day: four hours, then seven.
    expect(tripPeriods(trip, 'calendar', TZ).map((p) => p.minutes)).toEqual([240, 420]);
    // And back in October: 20:00 to 08:00 is thirteen hours.
    expect(tripPeriods({ start: '2026-10-24T20:00', end: '2026-10-25T08:00', abroad: false }, '24h', TZ)).toEqual([{ minutes: 780, abroad: false }]);
  });
});

describe('a paid lunch or dinner reduces a domestic day by 15 €, never below nothing', () => {
  it('one meal of a full day leaves 15 €, two leave nothing', () => {
    expect(sum(perDiemLines(domestic(720), AT, [1]))).toBe(1500);
    expect(sum(perDiemLines(domestic(720), AT, [2]))).toBe(0);
    // A third meal is not a further reduction.
    expect(sum(perDiemLines(domestic(720), AT, [3]))).toBe(0);
  });

  it('a short day with a meal comes to nothing, not to less', () => {
    const [line] = perDiemLines(domestic(300), AT, [1]);
    expect(line).toMatchObject({ twelfths: 5, rate_cents: 3000, reduction_cents: 1250, amount_cents: 0 });
  });

  it('meals count per period', () => {
    const periods = [
      { minutes: 1440, abroad: false },
      { minutes: 600, abroad: false },
    ];
    expect(perDiemLines(periods, AT, [0, 1]).map((l) => l.amount_cents)).toEqual([3000, 1000]);
  });
});

describe('abroad: the country\'s rate for the time abroad', () => {
  it('between the border crossings at the foreign rate; the domestic time before and after added up', () => {
    // Germany, 35,30 € a day: 06:00 off, the border at 08:00 and back at 20:00, home at 22:00.
    const periods = tripPeriods({ start: '2026-06-01T06:00', end: '2026-06-01T22:00', border_out: '2026-06-01T08:00', border_in: '2026-06-01T20:00', abroad: true }, '24h', TZ);
    expect(periods).toEqual([
      { minutes: 240, abroad: false },
      { minutes: 720, abroad: true },
    ]);
    const lines = perDiemLines(periods, { ...AT, foreign_day_cents: 3530 });
    expect(lines.map((l) => l.amount_cents)).toEqual([1000, 3530]);
  });

  it('without border times the whole trip counts as abroad', () => {
    expect(tripPeriods({ start: '2026-06-01T06:00', end: '2026-06-01T22:00', abroad: true }, '24h', TZ)).toEqual([{ minutes: 960, abroad: true }]);
  });

  it('meals abroad do not reduce here — the foreign rules are the office\'s', () => {
    expect(sum(perDiemLines([{ minutes: 720, abroad: true }], { ...AT, foreign_day_cents: 3530 }, [2]))).toBe(3530);
  });
});

describe('Kilometergeld (§ 10 RGV)', () => {
  const rates = { vehicle_cents: 50, passenger_cents: 15 };
  it('by car, kilometres in tenths: 123,4 km are 61,70 €; two passengers add 37,02 €', () => {
    expect(mileageCents(1234, 'car', 0, rates)).toBe(6170);
    expect(mileageCents(1234, 'car', 2, rates)).toBe(6170 + 3702);
  });

  it('by motorbike or bicycle at their rate, and no passenger supplement', () => {
    expect(mileageCents(1000, 'motorbike', 0, { vehicle_cents: 25, passenger_cents: 15 })).toBe(2500);
    // 12,3 km × 0,25 € = 3,075 € → 3,08 €, rounded half up.
    expect(mileageCents(123, 'bicycle', 1, { vehicle_cents: 25, passenger_cents: 15 })).toBe(308);
  });
});

describe('nights spanned', () => {
  it('counts the local dates from departure to return, less one', () => {
    expect(nightsSpanned('2026-05-11T08:00', '2026-05-11T22:00')).toBe(0);
    expect(nightsSpanned('2026-05-11T08:00', '2026-05-13T10:00')).toBe(2);
    expect(nightsSpanned('2026-12-31T20:00', '2027-01-01T08:00')).toBe(1);
  });
});
