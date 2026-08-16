import { describe, expect, it } from 'vitest';
import {
  addDays,
  easterSunday,
  holidays,
  isCalendarDate,
  isWorkingDay,
  leaveDays,
  REGIONS,
  workingDaysBetween,
  type Region,
} from '../shared/calendar.js';

/**
 * The working-day calendar — the file every balance in this module rests on.
 *
 * Holidays are computed rather than tabulated, so these tests are the only
 * thing standing between an algorithm and a lot of people's leave. They check
 * against dates that are independently verifiable rather than against the
 * implementation's own output.
 */

describe('Easter, which five holidays hang off', () => {
  // Published Easter Sundays. An off-by-one here is an off-by-one in
  // Karfreitag, Ostermontag, Christi Himmelfahrt, Pfingstmontag and
  // Fronleichnam simultaneously.
  it.each([
    [2020, '2020-04-12'],
    [2021, '2021-04-04'],
    [2022, '2022-04-17'],
    [2023, '2023-04-09'],
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
    [2028, '2028-04-16'],
    [2029, '2029-04-01'],
    [2030, '2030-04-21'],
    [2038, '2038-04-25'],
  ])('%i falls on %s', (year, expected) => {
    expect(easterSunday(year)).toBe(expected);
  });

  it('always lands on a Sunday, across two centuries', () => {
    for (let year = 1900; year <= 2100; year += 1) {
      const easter = easterSunday(year);
      expect(new Date(`${easter}T00:00:00Z`).getUTCDay(), easter).toBe(0);
    }
  });
});

describe('German public holidays', () => {
  it('gives every state the nine nationwide days', () => {
    const nationwide2026 = [
      '2026-01-01', // Neujahr
      '2026-04-03', // Karfreitag (Easter 2026-04-05 − 2)
      '2026-04-06', // Ostermontag
      '2026-05-01', // Tag der Arbeit
      '2026-05-14', // Christi Himmelfahrt (+39)
      '2026-05-25', // Pfingstmontag (+50)
      '2026-10-03', // Tag der Deutschen Einheit
      '2026-12-25',
      '2026-12-26',
    ];
    for (const region of REGIONS.filter((r) => r.startsWith('DE-'))) {
      const dates = holidays(2026, region).map((h) => h.date);
      for (const date of nationwide2026) expect(dates, `${region} ${date}`).toContain(date);
    }
  });

  it('gives Bayern its Catholic holidays and Berlin none of them', () => {
    const by = holidays(2026, 'DE-BY').map((h) => h.date);
    const be = holidays(2026, 'DE-BE').map((h) => h.date);
    expect(by).toContain('2026-01-06'); // Heilige Drei Könige
    expect(by).toContain('2026-06-04'); // Fronleichnam (+60)
    expect(by).toContain('2026-11-01'); // Allerheiligen
    expect(be).not.toContain('2026-01-06');
    expect(be).not.toContain('2026-06-04');
    expect(be).not.toContain('2026-11-01');
  });

  it('gives Berlin the Frauentag and Thüringen the Weltkindertag', () => {
    expect(holidays(2026, 'DE-BE').map((h) => h.date)).toContain('2026-03-08');
    expect(holidays(2026, 'DE-BY').map((h) => h.date)).not.toContain('2026-03-08');
    expect(holidays(2026, 'DE-TH').map((h) => h.date)).toContain('2026-09-20');
  });

  it('gives Reformationstag to the northern and eastern states only', () => {
    for (const region of ['DE-BB', 'DE-HB', 'DE-HH', 'DE-MV', 'DE-NI', 'DE-SN', 'DE-ST', 'DE-SH', 'DE-TH'] as Region[]) {
      expect(holidays(2026, region).map((h) => h.date), region).toContain('2026-10-31');
    }
    for (const region of ['DE-BW', 'DE-BY', 'DE-BE', 'DE-HE', 'DE-NW', 'DE-RP', 'DE-SL'] as Region[]) {
      expect(holidays(2026, region).map((h) => h.date), region).not.toContain('2026-10-31');
    }
  });

  // The one holiday defined by a weekday rule rather than a date or an Easter
  // offset, and therefore the one most likely to be wrong.
  it('puts Buß- und Bettag on the Wednesday before 23 November, in Sachsen only', () => {
    const expected: [number, string][] = [
      [2024, '2024-11-20'],
      [2025, '2025-11-19'],
      [2026, '2026-11-18'],
      [2027, '2027-11-17'],
      [2028, '2028-11-22'],
    ];
    for (const [year, date] of expected) {
      expect(holidays(year, 'DE-SN').map((h) => h.date), String(year)).toContain(date);
      expect(new Date(`${date}T00:00:00Z`).getUTCDay(), date).toBe(3);
      expect(holidays(year, 'DE-BY').map((h) => h.date), String(year)).not.toContain(date);
    }
  });

  it('never lists a date twice, in any state or year', () => {
    for (const region of REGIONS) {
      for (let year = 2024; year <= 2035; year += 1) {
        const dates = holidays(year, region).map((h) => h.date);
        expect(new Set(dates).size, `${region} ${year}`).toBe(dates.length);
      }
    }
  });
});

describe('Austrian public holidays', () => {
  it('lists the thirteen days the Arbeitsruhegesetz names', () => {
    const dates = holidays(2026, 'AT').map((h) => h.date);
    expect(dates).toHaveLength(13);
    for (const date of [
      '2026-01-01',
      '2026-01-06',
      '2026-04-06', // Ostermontag
      '2026-05-01',
      '2026-05-14', // Christi Himmelfahrt
      '2026-05-25', // Pfingstmontag
      '2026-06-04', // Fronleichnam
      '2026-08-15',
      '2026-10-26', // Nationalfeiertag
      '2026-11-01',
      '2026-12-08',
      '2026-12-25',
      '2026-12-26',
    ]) {
      expect(dates).toContain(date);
    }
  });

  // Not an oversight: Karfreitag stopped being a public holiday in 2019, and
  // the "persönlicher Feiertag" that replaced it is leave an employee books,
  // not a day the calendar closes.
  it('does NOT include Karfreitag', () => {
    expect(holidays(2026, 'AT').map((h) => h.date)).not.toContain('2026-04-03');
    expect(holidays(2026, 'DE-BY').map((h) => h.date)).toContain('2026-04-03');
  });

  it('has no Tag der Deutschen Einheit', () => {
    expect(holidays(2026, 'AT').map((h) => h.date)).not.toContain('2026-10-03');
  });
});

describe('working days', () => {
  it('excludes weekends', () => {
    expect(isWorkingDay('2026-07-20', 'DE-BE')).toBe(true); // Monday
    expect(isWorkingDay('2026-07-25', 'DE-BE')).toBe(false); // Saturday
    expect(isWorkingDay('2026-07-26', 'DE-BE')).toBe(false); // Sunday
  });

  it('excludes holidays, and only where they apply', () => {
    expect(isWorkingDay('2026-11-01', 'DE-BY')).toBe(false); // Allerheiligen — Sunday anyway
    expect(isWorkingDay('2026-06-04', 'DE-BY')).toBe(false); // Fronleichnam, a Thursday
    expect(isWorkingDay('2026-06-04', 'DE-BE')).toBe(true); // ordinary Thursday in Berlin
  });

  it('counts a plain Monday-to-Friday week as five days', () => {
    expect(workingDaysBetween('2026-07-20', '2026-07-24', 'DE-BE')).toHaveLength(5);
  });

  it('drops the holiday out of a week that contains one', () => {
    // Week of Fronleichnam 2026-06-04 (Thursday): four working days in Bayern,
    // five in Berlin. Same week, same request, different cost.
    expect(workingDaysBetween('2026-06-01', '2026-06-05', 'DE-BY')).toHaveLength(4);
    expect(workingDaysBetween('2026-06-01', '2026-06-05', 'DE-BE')).toHaveLength(5);
  });

  it('handles a span that crosses new year', () => {
    // 2026-12-28 (Mon) … 2027-01-01 (Fri). The 25th/26th are behind us; the
    // 1st is Neujahr. So Mon–Thu are working days: four.
    expect(workingDaysBetween('2026-12-28', '2027-01-01', 'DE-BE')).toEqual([
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
    ]);
  });

  it('returns nothing for an inverted span rather than looping forever', () => {
    expect(workingDaysBetween('2026-07-24', '2026-07-20', 'DE-BE')).toEqual([]);
  });
});

describe('what a request costs', () => {
  it('is the number of working days it covers', () => {
    expect(leaveDays('2026-07-20', '2026-07-24', 'DE-BE')).toBe(5);
    expect(leaveDays('2026-07-20', '2026-07-20', 'DE-BE')).toBe(1);
  });

  it('costs nothing for a span made entirely of weekend', () => {
    expect(leaveDays('2026-07-25', '2026-07-26', 'DE-BE')).toBe(0);
  });

  it('takes half a day off each half-day edge', () => {
    expect(leaveDays('2026-07-20', '2026-07-24', 'DE-BE', { halfStart: true })).toBe(4.5);
    expect(leaveDays('2026-07-20', '2026-07-24', 'DE-BE', { halfEnd: true })).toBe(4.5);
    expect(leaveDays('2026-07-20', '2026-07-24', 'DE-BE', { halfStart: true, halfEnd: true })).toBe(4);
  });

  // A single day marked half at both ends is one half day, not zero — the
  // arithmetic that would fall out of subtracting 0.5 twice.
  it('treats a single half day as half a day, not none', () => {
    expect(leaveDays('2026-07-20', '2026-07-20', 'DE-BE', { halfStart: true })).toBe(0.5);
    expect(leaveDays('2026-07-20', '2026-07-20', 'DE-BE', { halfStart: true, halfEnd: true })).toBe(0.5);
  });

  it('charges a Bavarian less than a Berliner for the same week', () => {
    expect(leaveDays('2026-06-01', '2026-06-05', 'DE-BY')).toBe(4);
    expect(leaveDays('2026-06-01', '2026-06-05', 'DE-BE')).toBe(5);
  });
});

describe('date handling is timezone-proof', () => {
  // Everything goes through UTC. Local-time arithmetic would shift a holiday
  // onto the day before in any deployment east of Greenwich in winter — the
  // bug that makes a December stack disagree with a June one.
  it('adds days without drifting across a DST boundary', () => {
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29'); // European DST start
    expect(addDays('2026-10-24', 1)).toBe('2026-10-25'); // DST end
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29'); // leap year
  });

  it.each(['2026-02-30', '2026-13-01', '2026-7-20', '20260720', 'tomorrow', ''])(
    'rejects %o as a calendar date',
    (value) => {
      expect(isCalendarDate(value)).toBe(false);
    },
  );

  it('accepts a real leap day and rejects one that is not', () => {
    expect(isCalendarDate('2028-02-29')).toBe(true);
    expect(isCalendarDate('2026-02-29')).toBe(false);
  });
});
