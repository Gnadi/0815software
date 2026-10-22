import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { dailyTarget } from '../server/schedules.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import type { FlexDay, WorkSchedule } from '../shared/types.js';

/**
 * Flexitime and overtime (server/flextime.ts): the balance is derived from the
 * time recorded against each day's target; absences cover the target, comp
 * time does not; overtime is the balance above the cap; only the office books
 * what the days cannot say.
 *
 * Fixed dates in 2030, which the seed never touches: 4–8 and 11–15 March hold
 * no holiday in Austria; Easter Monday is 22 April 2030.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 'test-secret', ttlHours: 1, secureCookie: false };
let db: Database.Database;
let app: Express;
let anna: number;
let project: number;

const as = (access: AccessLevel, actor: string) => `${COOKIE_NAME}=${createToken(auth, actor, Date.now(), access)}`;
const ANNA = as('edit', 'anna@0815software.example');
const BOB = as('edit', 'bob@0815software.example');
const ADMIN = as('manage', 'admin');

const schedule = (values: Record<string, unknown>, employeeId = anna) =>
  request(app).post(`/api/employees/${employeeId}/schedules`).set('Cookie', ADMIN).send(values);
const work = (date: string, minutes: number) =>
  request(app).post('/api/entries').set('Cookie', ADMIN).send({ employee_id: anna, project_id: project, entry_date: date, minutes }).expect(201);
const book = (values: Record<string, unknown>, cookie = ADMIN) => request(app).post(`/api/employees/${anna}/flex-entries`).set('Cookie', cookie).send(values);
const account = async (asOf: string, cookie = ADMIN) =>
  (await request(app).get(`/api/flex/account?employee_id=${anna}&as_of=${asOf}`).set('Cookie', cookie).expect(200)).body;
const days = async (month: string, cookie = ADMIN): Promise<FlexDay[]> =>
  (await request(app).get(`/api/flex/days?employee_id=${anna}&month=${month}`).set('Cookie', cookie).expect(200)).body.days;
const leave = async (values: Record<string, unknown>) => {
  const created = (await request(app).post('/api/leave/requests').set('Cookie', ADMIN).send({ employee_id: anna, ...values }).expect(201)).body;
  if (created.status === 'requested') await request(app).post(`/api/leave/requests/${created.id}/approve`).set('Cookie', ADMIN).send({}).expect(200);
};

beforeEach(async () => {
  db = openDb(':memory:');
  seed(db);
  db.exec('DELETE FROM leave_events; DELETE FROM leave_requests; DELETE FROM leave_entitlements; DELETE FROM flex_entries; DELETE FROM work_schedules;');
  anna = (db.prepare("SELECT id FROM employees WHERE email = 'anna@0815software.example'").get() as { id: number }).id;
  project = (db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get() as { id: number }).id;
  app = createApp({ db, auth });
  // 40 h, Monday to Friday, from Monday 4 March 2030.
  await schedule({ valid_from: '2030-03-04', weekly_minutes: 2400, work_days: '12345' }).expect(201);
});

describe('the daily target', () => {
  const s = (weekly: number, workDays: string): WorkSchedule => ({
    id: 1, employee_id: 1, valid_from: '2030-01-01', weekly_minutes: weekly, work_days: workDays, note: null, actor: 'a', created_at: '',
  });

  it('spreads the week over the work days, and the week adds up exactly', () => {
    expect([1, 2, 3, 4, 5, 6, 7].map((d) => dailyTarget(s(2310, '12345'), d))).toEqual([462, 462, 462, 462, 462, 0, 0]);
    const odd = [1, 2, 3, 4].map((d) => dailyTarget(s(2250, '1234'), d));
    expect(odd).toEqual([563, 563, 562, 562]);
    expect(odd.reduce((a, b) => a + b)).toBe(2250);
    expect(dailyTarget(s(1200, '135'), 2)).toBe(0);
    expect(dailyTarget(null, 1)).toBe(0);
  });
});

describe('the balance — derived from the days', () => {
  it('is worked minus due over every tracked day', async () => {
    await work('2030-03-04', 540);
    await work('2030-03-05', 480);
    await work('2030-03-06', 420);
    await work('2030-03-07', 480);
    // Saturday's work counts too: the day asks for nothing.
    await work('2030-03-09', 120);
    const acc = await account('2030-03-10');
    expect(acc).toMatchObject({ start: '2030-03-04', balance: 1920 + 120 - 2400 });
    expect(acc.months).toEqual([{ month: '2030-03', due: 2400, worked: 2040, diff: -360, booked: 0, paid_out: 0, balance_end: -360 }]);
    // Days before the account starts are not counted.
    await work('2030-03-01', 600);
    expect((await account('2030-03-10')).balance).toBe(-360);
  });

  it('a holiday asks for nothing', async () => {
    const april = await days('2030-04');
    const easterMonday = april.find((d) => d.date === '2030-04-22')!;
    expect(easterMonday).toMatchObject({ holiday: 'Ostermontag', target: 0, due: 0, diff: 0 });
    expect(april.find((d) => d.date === '2030-04-23')).toMatchObject({ target: 480, due: 480, diff: -480 });
  });

  it('absences cover the target — comp time does not, it is paid from the balance', async () => {
    await request(app).post(`/api/employees/${anna}/entitlements`).set('Cookie', ADMIN).send({ year: 2030, days: 25 }).expect(201);
    await leave({ type: 'vacation', start_date: '2030-03-12' });
    await leave({ type: 'sick', start_date: '2030-03-14', half_day: true });
    await leave({ type: 'comp_time', start_date: '2030-03-15' });
    await work('2030-03-11', 480);
    await work('2030-03-13', 480);
    await work('2030-03-14', 240);
    const week = (await days('2030-03')).filter((d) => d.date >= '2030-03-11' && d.date <= '2030-03-15');
    expect(week.map((d) => [d.absence, d.credited, d.due, d.diff])).toEqual([
      [null, 0, 480, 0],
      ['vacation', 480, 0, 0],
      [null, 0, 480, 0],
      ['sick', 240, 240, 0],
      ['comp_time', 0, 480, -480],
    ]);
    // A colleague sees an absence, not that it was sickness.
    const seenByBob = (await days('2030-03', BOB)).find((d) => d.date === '2030-03-14')!;
    expect(seenByBob.absence).toBe('absent');
  });

  it('a new schedule changes the days from its date on, not before', async () => {
    await work('2030-03-04', 480);
    const before = (await account('2030-03-31')).months[0];
    // Part-time from April: 20 h on Monday to Wednesday.
    await schedule({ valid_from: '2030-04-01', weekly_minutes: 1200, work_days: '123' }).expect(201);
    const after = await account('2030-04-07');
    expect(after.months[0]).toEqual(before);
    expect(after.months[1]).toMatchObject({ month: '2030-04', due: 1200 });
  });

  it('flags days above the daily maximum from the settings', async () => {
    await work('2030-03-04', 660);
    const flagged = (await days('2030-03')).filter((d) => d.over_max).map((d) => d.date);
    expect(flagged).toEqual(['2030-03-04']);
    const settings = (await request(app).get('/api/leave/settings').set('Cookie', ADMIN)).body.settings;
    await request(app).put('/api/leave/settings').set('Cookie', ADMIN).send({ ...settings, daily_max_minutes: 720 }).expect(200);
    expect((await days('2030-03')).some((d) => d.over_max)).toBe(false);
  });
});

describe('overtime and the ledger', () => {
  it('overtime is the balance above the cap; a payout takes it out of the account', async () => {
    const settings = (await request(app).get('/api/leave/settings').set('Cookie', ADMIN)).body.settings;
    await request(app).put('/api/leave/settings').set('Cookie', ADMIN).send({ ...settings, flex_cap_minutes: 600 }).expect(200);
    // Brought in when the account started: 15 h, a full week worked as asked.
    await book({ kind: 'opening', minutes: 900, effective_date: '2030-03-04' }).expect(201);
    for (const d of ['04', '05', '06', '07', '08']) await work(`2030-03-${d}`, 480);
    expect(await account('2030-03-08')).toMatchObject({ balance: 900, cap: 600, over_cap: 300 });

    // Paying out more than is in the account is refused; the overtime is not.
    await book({ kind: 'payout', minutes: 901, effective_date: '2030-03-08' }).expect(409);
    const paid = (await book({ kind: 'payout', minutes: 300, effective_date: '2030-03-08', note: 'March payroll' }).expect(201)).body;
    expect(paid).toMatchObject({ kind: 'payout', minutes: -300, actor: 'admin' });
    const acc = await account('2030-03-08');
    expect(acc).toMatchObject({ balance: 600, over_cap: 0 });
    expect(acc.months[0]).toMatchObject({ booked: 900, paid_out: 300, balance_end: 600 });
    // Before its date, the payout has not happened.
    expect((await account('2030-03-07')).balance).toBe(900);
  });

  it('the floor flags a balance too far below zero', async () => {
    await book({ kind: 'adjustment', minutes: -1500, effective_date: '2030-03-04', note: 'Correction after audit' }).expect(201);
    expect(await account('2030-03-04')).toMatchObject({ balance: -1500 - 480, floor: -1200, under_floor: 780 });
  });

  it('only the office books, a correction says why, and there must be an account', async () => {
    await book({ kind: 'opening', minutes: 60 }, ANNA).expect(403);
    await schedule({ valid_from: '2030-05-01', weekly_minutes: 2400, work_days: '12345' }, anna).set('Cookie', ANNA).expect(403);
    await book({ kind: 'adjustment', minutes: 60 }).expect(422);
    await book({ kind: 'payout', minutes: -60 }).expect(422);
    await book({ kind: 'bonus', minutes: 60 }).expect(422);
    const bob = (db.prepare("SELECT id FROM employees WHERE email = 'bob@0815software.example'").get() as { id: number }).id;
    await request(app).post(`/api/employees/${bob}/flex-entries`).set('Cookie', ADMIN).send({ kind: 'opening', minutes: 60 }).expect(409);
    // Nothing is edited or deleted: there is no route for it.
    await request(app).delete(`/api/employees/${anna}/flex-entries`).set('Cookie', ADMIN).expect(404);
  });

  it('a person reads their own account without naming themselves', async () => {
    await work('2030-03-04', 500);
    const own = (await request(app).get('/api/flex/account?as_of=2030-03-04').set('Cookie', ANNA).expect(200)).body;
    expect(own).toMatchObject({ employee_id: anna, balance: 20 });
  });
});

describe('the month for payroll', () => {
  it('one line per person with an account, hours as decimals, names neutralised', async () => {
    await request(app).put(`/api/employees/${anna}`).set('Cookie', ADMIN).send({ name: '=HYPERLINK("x")', email: 'anna@0815software.example' }).expect(200);
    // A month already over: March 2026, 22 work days and no holiday in Austria.
    await schedule({ valid_from: '2026-03-02', weekly_minutes: 2400, work_days: '12345' }).expect(201);
    await work('2026-03-02', 510);
    await book({ kind: 'payout', minutes: 30, effective_date: '2026-03-02' }).expect(201);
    const csv = (await request(app).get('/api/export/flex.csv?month=2026-03').set('Cookie', ADMIN).expect(200)).text;
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('employee,email,month,due_hours,worked_hours,difference_hours,paid_out_hours,balance_hours,over_cap_hours');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe(`"'=HYPERLINK(""x"")",anna@0815software.example,2026-03,176.00,8.50,-167.50,0.50,-168.00,0.00`);
    // A month nobody's account has reached yet is empty, not an error.
    expect((await request(app).get('/api/export/flex.csv?month=2030-03').set('Cookie', ADMIN).expect(200)).text.trim().split('\r\n')).toHaveLength(1);
    await request(app).get('/api/export/flex.csv?month=2030-3').set('Cookie', ADMIN).expect(422);
  });

  it('the overview lists everyone with an account', async () => {
    // Anna's account starts in 2030 — today it has not begun.
    expect((await request(app).get('/api/flex/overview').set('Cookie', ADMIN).expect(200)).body.rows).toEqual([]);
    await schedule({ valid_from: '2026-03-02', weekly_minutes: 2400, work_days: '12345' }).expect(201);
    const rows = (await request(app).get('/api/flex/overview').set('Cookie', ADMIN).expect(200)).body.rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ employee_id: anna, over_cap: 0 });
    expect(rows[0].balance).toBeLessThan(0);
  });
});
