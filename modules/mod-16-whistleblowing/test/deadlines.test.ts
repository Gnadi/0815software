import { describe, expect, it } from 'vitest';
import {
  acknowledgeDeadline,
  addDays,
  addMonths,
  addYears,
  eraseDueOn,
  feedbackDeadline,
  nowIso,
} from '../server/deadlines.js';

/**
 * The statutory clocks.
 *
 * Every number here is a legal deadline, so the tests are written against
 * the rule rather than against the implementation: § 17 Abs. 1 HinSchG
 * (seven days to acknowledge), § 17 Abs. 2 (three months to give feedback,
 * measured from the acknowledgement or from the expiry of the seven days),
 * and § 11 Abs. 5 (erase three years after conclusion).
 */

describe('date arithmetic', () => {
  it('formats to whole seconds, the way the rest of the module writes', () => {
    expect(nowIso(Date.parse('2026-03-01T10:15:30.123Z'))).toBe('2026-03-01T10:15:30Z');
  });

  it('adds days across a month and a year boundary', () => {
    expect(addDays('2026-01-28T09:00:00Z', 7)).toBe('2026-02-04T09:00:00Z');
    expect(addDays('2026-12-30T09:00:00Z', 7)).toBe('2027-01-06T09:00:00Z');
  });

  it('adds days across the spring DST change without shifting the time', () => {
    // 29 March 2026 is the European clock change. Everything is UTC, so a
    // deadline set at 09:00 stays at 09:00 — the bug this guards against is
    // a local-time implementation quietly moving a legal deadline an hour.
    expect(addDays('2026-03-26T09:00:00Z', 7)).toBe('2026-04-02T09:00:00Z');
  });

  it('adds whole calendar months, not 30-day blocks', () => {
    expect(addMonths('2026-01-15T08:00:00Z', 3)).toBe('2026-04-15T08:00:00Z');
    expect(addMonths('2026-11-30T08:00:00Z', 3)).toBe('2027-02-28T08:00:00Z');
  });

  it('clamps to the end of a shorter target month', () => {
    // 31 November does not exist. § 188 Abs. 3 BGB clamps to the 30th, and
    // that direction favours the reporter — the organisation gets no extra
    // day out of a short month.
    expect(addMonths('2026-08-31T12:00:00Z', 3)).toBe('2026-11-30T12:00:00Z');
    expect(addMonths('2028-11-29T12:00:00Z', 3)).toBe('2029-02-28T12:00:00Z');
    // …and it does not skip a leap day when one exists.
    expect(addMonths('2027-11-29T12:00:00Z', 3)).toBe('2028-02-29T12:00:00Z');
  });

  it('adds years through the month path, so 29 February survives correctly', () => {
    expect(addYears('2028-02-29T00:00:00Z', 3)).toBe('2031-02-28T00:00:00Z');
    expect(addYears('2026-05-04T00:00:00Z', 3)).toBe('2029-05-04T00:00:00Z');
  });
});

describe('§ 17 Abs. 1 — acknowledge within seven days', () => {
  const received = '2026-05-04T08:00:00Z';

  it('falls due exactly seven days after receipt', () => {
    expect(acknowledgeDeadline(received, null, received).due_at).toBe('2026-05-11T08:00:00Z');
  });

  it('is upcoming while there is time, at risk in the last two days', () => {
    expect(acknowledgeDeadline(received, null, '2026-05-05T08:00:00Z').state).toBe('upcoming');
    expect(acknowledgeDeadline(received, null, '2026-05-09T08:00:00Z').state).toBe('at_risk');
  });

  it('is met when the acknowledgement lands inside the window', () => {
    const deadline = acknowledgeDeadline(received, '2026-05-06T09:00:00Z', '2026-06-01T00:00:00Z');
    expect(deadline.state).toBe('met');
    expect(deadline.met_at).toBe('2026-05-06T09:00:00Z');
  });

  it('stays MISSED when the acknowledgement lands late — "late" is not "done"', () => {
    // The distinction is the point: an audit asks whether the organisation
    // answered in time, and a view that flipped to `met` the moment the
    // reply landed would hide every late response ever recorded.
    expect(acknowledgeDeadline(received, '2026-05-20T09:00:00Z', '2026-06-01T00:00:00Z').state).toBe('missed');
  });

  it('is missed once the date passes with nothing done', () => {
    expect(acknowledgeDeadline(received, null, '2026-05-12T08:00:00Z').state).toBe('missed');
  });

  it('counts down, and past the date counts negative', () => {
    expect(acknowledgeDeadline(received, null, '2026-05-06T08:00:00Z').days_remaining).toBe(5);
    expect(acknowledgeDeadline(received, null, '2026-05-14T08:00:00Z').days_remaining).toBe(-3);
  });
});

describe('§ 17 Abs. 2 — feedback within three months', () => {
  const received = '2026-05-04T08:00:00Z';

  it('runs three months from the acknowledgement when there was one', () => {
    const deadline = feedbackDeadline(received, '2026-05-06T09:00:00Z', null, received);
    expect(deadline.due_at).toBe('2026-08-06T09:00:00Z');
  });

  it('runs from the expiry of the seven days when the case was never acknowledged', () => {
    // The fallback in Art. 9(1)(f) of the directive, and the whole reason it
    // exists: never acknowledging does not postpone the feedback obligation,
    // it starts it. A case sitting untouched accrues BOTH failures.
    const deadline = feedbackDeadline(received, null, null, received);
    expect(deadline.due_at).toBe('2026-08-11T08:00:00Z');
  });

  it('is not satisfied by an acknowledgement — that is receipt, not feedback', () => {
    // feedbackGivenAt is folded from the trail elsewhere; here the contract
    // is simply that an unfulfilled obligation past its date is missed.
    expect(feedbackDeadline(received, '2026-05-06T09:00:00Z', null, '2026-09-01T00:00:00Z').state).toBe('missed');
  });

  it('is met when substantive feedback reaches the reporter in time', () => {
    expect(feedbackDeadline(received, '2026-05-06T09:00:00Z', '2026-07-01T09:00:00Z', '2026-09-01T00:00:00Z').state).toBe(
      'met',
    );
  });

  it('warns a fortnight out', () => {
    expect(feedbackDeadline(received, '2026-05-06T09:00:00Z', null, '2026-07-20T09:00:00Z').state).toBe('upcoming');
    expect(feedbackDeadline(received, '2026-05-06T09:00:00Z', null, '2026-07-30T09:00:00Z').state).toBe('at_risk');
  });
});

describe('§ 11 Abs. 5 — three years of retention', () => {
  it('is null while the procedure is still running', () => {
    expect(eraseDueOn(null)).toBeNull();
  });

  it('runs three years from the conclusion, not from receipt', () => {
    expect(eraseDueOn('2026-06-15T10:00:00Z')).toBe('2029-06-15');
  });

  it('is a date, because retention is counted in days not seconds', () => {
    expect(eraseDueOn('2026-06-15T23:59:59Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
