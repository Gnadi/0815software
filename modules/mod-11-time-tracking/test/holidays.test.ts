import { describe, expect, it } from 'vitest';
import { easterSunday, publicHolidays } from '../shared/holidays.js';

/**
 * Checked against the published calendars, not against the algorithm:
 * Easter dates from the Physikalisch-Technische Bundesanstalt's table, the
 * Austrian list from Feiertagsruhegesetz § 7 (as printed by oesterreich.gv.at
 * for 2025 and 2026), the German nationwide days from the Länder holiday laws.
 */

describe('Easter Sunday', () => {
  it.each([
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
    [2028, '2028-04-16'],
    [2038, '2038-04-25'], // the latest possible date in this century
    [2285, '2285-03-22'], // the earliest possible date
  ])('%i → %s', (year, date) => {
    expect(easterSunday(year)).toBe(date);
  });
});

describe('Austria, Feiertagsruhegesetz § 7', () => {
  it('2026', () => {
    expect(publicHolidays(2026, 'AT')).toEqual([
      { date: '2026-01-01', name: 'Neujahr' },
      { date: '2026-01-06', name: 'Heilige Drei Könige' },
      { date: '2026-04-06', name: 'Ostermontag' },
      { date: '2026-05-01', name: 'Staatsfeiertag' },
      { date: '2026-05-14', name: 'Christi Himmelfahrt' },
      { date: '2026-05-25', name: 'Pfingstmontag' },
      { date: '2026-06-04', name: 'Fronleichnam' },
      { date: '2026-08-15', name: 'Mariä Himmelfahrt' },
      { date: '2026-10-26', name: 'Nationalfeiertag' },
      { date: '2026-11-01', name: 'Allerheiligen' },
      { date: '2026-12-08', name: 'Mariä Empfängnis' },
      { date: '2026-12-25', name: 'Christtag' },
      { date: '2026-12-26', name: 'Stefanitag' },
    ]);
  });

  it('2025: the moveable feasts, and no Good Friday', () => {
    const dates = publicHolidays(2025, 'AT').map((h) => h.date);
    expect(dates).toEqual(expect.arrayContaining(['2025-04-21', '2025-05-29', '2025-06-09', '2025-06-19']));
    expect(dates).not.toContain('2025-04-18');
    expect(dates).toHaveLength(13);
  });
});

describe('Germany, the nine nationwide days', () => {
  it('2026', () => {
    expect(publicHolidays(2026, 'DE').map((h) => h.date)).toEqual([
      '2026-01-01',
      '2026-04-03',
      '2026-04-06',
      '2026-05-01',
      '2026-05-14',
      '2026-05-25',
      '2026-10-03',
      '2026-12-25',
      '2026-12-26',
    ]);
  });

  it('2025', () => {
    expect(publicHolidays(2025, 'DE').map((h) => h.date)).toEqual([
      '2025-01-01', '2025-04-18', '2025-04-21', '2025-05-01', '2025-05-29', '2025-06-09', '2025-10-03', '2025-12-25', '2025-12-26',
    ]);
  });
});
