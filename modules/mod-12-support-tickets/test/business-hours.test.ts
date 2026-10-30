import { describe, expect, it } from 'vitest';
import { dueAt, elapsedMs, localDate, zonedInstant, type Calendar } from '../server/business-hours.js';
import { evaluateSla, DEFAULT_POLICY } from '../server/sla-config.js';
import type { SlaPolicy } from '../shared/types.js';

/**
 * The SLA clock (server/business-hours.ts): business hours of the office's
 * time zone, weekends and holidays skipped, the clock change handled, pauses
 * cut out. Fixed instants, so the suite does not depend on the day it runs.
 *
 * Vienna: CET (UTC+1) in winter, CEST (UTC+2) in summer; in 2026 the clocks
 * go back on Sunday 25 October.
 */

const at = (iso: string) => Date.parse(iso);
const iso = (ms: number) => new Date(ms).toISOString().replace('.000Z', 'Z');
const HOUR = 3_600_000;
const office: Calendar = {
  timezone: 'Europe/Vienna',
  week: [0, 1, 2, 3, 4, 5, 6].map((d) => (d < 5 ? [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }] : [])),
  holidays: new Set(['2026-12-25']),
};

describe('local time', () => {
  it('turns office wall-clock times into instants on both sides of the clock change', () => {
    expect(iso(zonedInstant('2026-10-23', '08:00', 'Europe/Vienna'))).toBe('2026-10-23T06:00:00Z'); // CEST
    expect(iso(zonedInstant('2026-10-26', '08:00', 'Europe/Vienna'))).toBe('2026-10-26T07:00:00Z'); // CET
    expect(iso(zonedInstant('2026-10-23', '24:00', 'Europe/Vienna'))).toBe('2026-10-23T22:00:00Z');
    expect(localDate(at('2026-10-22T22:30:00Z'), 'Europe/Vienna')).toBe('2026-10-23');
  });
});

describe('due in business hours', () => {
  it('a Friday-afternoon ticket is due on Monday, the weekend not counted', () => {
    // Friday 23 Oct, 16:00 Vienna (14:00Z). 4 business hours: 1 on Friday, 3 on Monday (8–11).
    expect(iso(dueAt(at('2026-10-23T14:00:00Z'), 240, office))).toBe('2026-10-26T10:00:00Z');
  });

  it('the lunch break does not count', () => {
    // Monday 26 Oct 11:00 Vienna (10:00Z) + 2h: 11–12, then 13–14.
    expect(iso(dueAt(at('2026-10-26T10:00:00Z'), 120, office))).toBe('2026-10-26T13:00:00Z');
  });

  it('a ticket that arrives at night starts counting when the office opens', () => {
    expect(iso(dueAt(at('2026-10-26T20:00:00Z'), 30, office))).toBe('2026-10-27T07:30:00Z');
  });

  it('a holiday is skipped like a Sunday', () => {
    // Thursday 24 Dec 16:00 CET + 2h: 1h on the 24th; the 25th is a holiday, then the weekend; 1h on Monday the 28th.
    expect(iso(dueAt(at('2026-12-24T15:00:00Z'), 120, office))).toBe('2026-12-28T08:00:00Z');
  });

  it('the night of the clock change has its real length, around the clock too', () => {
    // 24h around the clock from Saturday 08:00 CEST: the 25th has 25 hours, but 24h is 24h.
    expect(iso(dueAt(at('2026-10-24T06:00:00Z'), 24 * 60, null))).toBe('2026-10-25T06:00:00Z');
  });
});

describe('pauses', () => {
  it('cut the time out — and only the business part of a pause matters', () => {
    const from = at('2026-10-26T07:00:00Z'); // Monday 08:00
    // Waiting on the requester 09:00–10:00 Vienna: due moves an hour later.
    expect(iso(dueAt(from, 120, office, [[at('2026-10-26T08:00:00Z'), at('2026-10-26T09:00:00Z')]]))).toBe('2026-10-26T10:00:00Z');
    expect(elapsedMs(from, at('2026-10-26T10:00:00Z'), office, [[at('2026-10-26T08:00:00Z'), at('2026-10-26T09:00:00Z')]])).toBe(2 * HOUR);
    // A pause overnight changes nothing.
    expect(dueAt(from, 120, office, [[at('2026-10-26T18:00:00Z'), at('2026-10-27T05:00:00Z')]])).toBe(dueAt(from, 120, office));
  });
});

describe('the verdict with a policy', () => {
  const policy: SlaPolicy = {
    ...DEFAULT_POLICY,
    week: office.week,
    holidays: [{ date: '2026-12-25', name: 'Christtag' }],
    targets: { ...DEFAULT_POLICY.targets, normal: { first_response_minutes: 240, resolution_minutes: 960, business_hours: true } },
    pause_on_pending: true,
  };
  const created = at('2026-10-23T14:00:00Z'); // Friday 16:00

  it('over the weekend nothing is breached, and the minutes left stand still', () => {
    const sat = evaluateSla({ createdMs: created, priority: 'normal', firstResponseMs: null, resolvedMs: null, nowMs: at('2026-10-24T12:00:00Z'), policy });
    expect(sat.first_response).toMatchObject({ state: 'pending', due_at: '2026-10-26T10:00:00Z', business_hours: true, remaining_minutes: 180 });
    const sun = evaluateSla({ createdMs: created, priority: 'normal', firstResponseMs: null, resolvedMs: null, nowMs: at('2026-10-25T12:00:00Z'), policy });
    expect(sun.first_response.remaining_minutes).toBe(180);
  });

  it('waiting on the requester stops the resolution clock, not the first response', () => {
    const waiting: [number, number | null][] = [[at('2026-10-26T08:00:00Z'), null]];
    const now = at('2026-10-28T08:00:00Z');
    const sla = evaluateSla({ createdMs: created, priority: 'normal', firstResponseMs: null, resolvedMs: null, nowMs: now, policy, pending: waiting });
    expect(sla.first_response.state).toBe('breached');
    expect(sla.resolution.state).toBe('paused');
    // 16h of business time: 1h Friday + Monday 08:00–09:00 Vienna ran; 14h left from now (Wed 09:00).
    expect(sla.resolution.remaining_minutes).toBe(14 * 60);
    // Without the setting, the same ticket has been running all along.
    const plain = evaluateSla({ createdMs: created, priority: 'normal', firstResponseMs: null, resolvedMs: null, nowMs: now, policy: { ...policy, pause_on_pending: false }, pending: waiting });
    // 1h Friday + 8h Monday + 7h Tuesday: due Tuesday 16:00 Vienna, long past.
    expect(plain.resolution).toMatchObject({ state: 'breached', due_at: '2026-10-27T15:00:00Z' });
    expect(sla.resolution.due_at).toBe('2026-10-29T15:00:00Z'); // were the requester to answer now: 14h on, Thursday 16:00
  });
});
