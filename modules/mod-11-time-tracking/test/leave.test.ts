import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';

/**
 * Absences (server/leave.ts): what a request costs and what is left are
 * derived; people request their own leave, `manage` decides — never on their
 * own request — and sick leave stays private.
 *
 * Fixed dates: 11–15 May 2026 holds Christi Himmelfahrt (Thu 14 May) in AT and
 * DE; 4–8 March 2030 holds no holiday; requests in May 2026 lie in the past
 * (today is later), those in 2030 in the future.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 'test-secret', ttlHours: 1, secureCookie: false };
let db: Database.Database;
let app: Express;
let anna: number;
let bob: number;

const as = (access: AccessLevel, actor: string) => `${COOKIE_NAME}=${createToken(auth, actor, Date.now(), access)}`;
const ANNA = as('edit', 'anna@0815software.example');
const BOB = as('edit', 'bob@0815software.example');
const BOSS = as('manage', 'david@0815software.example');
const ADMIN = as('manage', 'admin');

const ask = (cookie: string, values: Record<string, unknown>) => request(app).post('/api/leave/requests').set('Cookie', cookie).send(values);
const grant = (employeeId: number, year: number, days: number, kind = 'allowance') =>
  request(app).post(`/api/employees/${employeeId}/entitlements`).set('Cookie', ADMIN).send({ year, days, kind });
const account = async (cookie: string, employeeId: number, year: number) =>
  (await request(app).get(`/api/leave/balance?employee_id=${employeeId}&year=${year}`).set('Cookie', cookie).expect(200)).body;

beforeEach(async () => {
  db = openDb(':memory:');
  seed(db);
  // The seed brings example absences and schedules; these tests count from empty ledgers.
  db.exec('DELETE FROM leave_events; DELETE FROM leave_requests; DELETE FROM leave_entitlements; DELETE FROM flex_entries; DELETE FROM work_schedules;');
  const id = (email: string) => (db.prepare('SELECT id FROM employees WHERE email = ?').get(email) as { id: number }).id;
  anna = id('anna@0815software.example');
  bob = id('bob@0815software.example');
  app = createApp({ db, auth });
  await grant(anna, 2026, 25).expect(201);
  await grant(anna, 2030, 25).expect(201);
});

describe('what a request costs — derived', () => {
  it('counts working days: weekends and statutory holidays are free', async () => {
    const week = await ask(ANNA, { type: 'vacation', start_date: '2026-05-11', end_date: '2026-05-17' }).expect(201);
    expect(week.body).toMatchObject({ employee_name: 'Anna Berger', days: 4, status: 'requested', created_by: 'anna@0815software.example' });
    const half = await ask(ANNA, { type: 'vacation', start_date: '2030-03-04', half_day: true }).expect(201);
    expect(half.body.days).toBe(0.5);
    const weekend = await ask(ANNA, { type: 'vacation', start_date: '2030-03-09', end_date: '2030-03-10' }).expect(422);
    expect(weekend.body.details[0].message).toBe('There is no working day in that range');
  });

  it('part-time: only the days the person works, by the schedule on each date', async () => {
    const schedule = (values: Record<string, unknown>) => request(app).post(`/api/employees/${anna}/schedules`).set('Cookie', ADMIN).send(values);
    await schedule({ valid_from: '2030-01-01', work_days: '531', weekly_minutes: 1200 }).expect(201);
    expect((await ask(ANNA, { type: 'vacation', start_date: '2030-03-04', end_date: '2030-03-08' }).expect(201)).body.days).toBe(3);
    // Full-time from April: March leave keeps its price, April counts five days.
    await schedule({ valid_from: '2030-04-01', work_days: '12345', weekly_minutes: 2400 }).expect(201);
    const mine = (await request(app).get(`/api/leave/requests?employee_id=${anna}`).set('Cookie', ANNA)).body.requests;
    expect(mine[0].days).toBe(3);
    expect((await ask(ANNA, { type: 'vacation', start_date: '2030-04-08', end_date: '2030-04-12' }).expect(201)).body.days).toBe(5);
    await schedule({ valid_from: '2030-05-01', work_days: '1123' }).expect(422);
    await schedule({ valid_from: '2030-04-01', work_days: '12345' }).expect(409);
  });

  it('follows the holiday calendar the admin sets: country and company days', async () => {
    await request(app).put('/api/leave/settings').set('Cookie', BOSS.replace('david', 'x')).send({ country: 'DE' }).expect(200);
    // Germany: Karfreitag (3 April 2026) is a holiday; Austria: it is not.
    const holidays = (await request(app).get('/api/leave/holidays?year=2026').set('Cookie', ANNA).expect(200)).body.holidays;
    expect(holidays.map((h: { date: string }) => h.date)).toContain('2026-04-03');
    await request(app)
      .put('/api/leave/settings')
      .set('Cookie', ADMIN)
      .send({ country: 'AT', extra_holidays: [{ date: '2030-03-06', name: 'Betriebsurlaub' }] })
      .expect(200);
    expect((await ask(ANNA, { type: 'vacation', start_date: '2030-03-04', end_date: '2030-03-08' }).expect(201)).body.days).toBe(4);
    await request(app).put('/api/leave/settings').set('Cookie', ANNA).send({ country: 'DE' }).expect(403);
    await request(app).put('/api/leave/settings').set('Cookie', ADMIN).send({ country: 'CH' }).expect(422);
  });
});

describe('the year’s account — derived from the ledger and the decisions', () => {
  it('pending, taken, remaining, free', async () => {
    const r = (await ask(ANNA, { type: 'vacation', start_date: '2030-03-04', end_date: '2030-03-08' }).expect(201)).body;
    expect(await account(ANNA, anna, 2030)).toMatchObject({ entitled: 25, pending: 5, taken: 0, remaining: 25, free: 20 });
    await request(app).post(`/api/leave/requests/${r.id}/approve`).set('Cookie', BOSS).send({}).expect(200);
    expect(await account(ANNA, anna, 2030)).toMatchObject({ pending: 0, taken: 5, remaining: 20, free: 20 });
    await grant(anna, 2030, 3, 'carryover').expect(201);
    await grant(anna, 2030, -1, 'adjustment').expect(201);
    expect((await account(ANNA, anna, 2030)).remaining).toBe(22);
    await grant(anna, 2030, -1, 'allowance').expect(422);
  });

  it('refuses more vacation than is free, and re-checks at approval', async () => {
    const big = await ask(ANNA, { type: 'vacation', start_date: '2030-03-04', end_date: '2030-04-12' }).expect(422);
    expect(big.body.details[0].message).toMatch(/days requested, 25 left in 2030/);
    const r = (await ask(ANNA, { type: 'vacation', start_date: '2030-03-04', end_date: '2030-03-08' }).expect(201)).body;
    // The allowance was corrected after the request: approving would overdraw.
    await grant(anna, 2030, -22, 'adjustment').expect(201);
    expect((await request(app).post(`/api/leave/requests/${r.id}/approve`).set('Cookie', BOSS).send({}).expect(409)).body.error).toBe('5 days requested, 3 left in 2030');
    // Sick leave and unpaid leave draw nothing from the allowance.
    await ask(ANNA, { type: 'unpaid', start_date: '2030-05-06', end_date: '2030-05-10' }).expect(201);
  });

  it('one request per day, and one calendar year per request', async () => {
    await ask(ANNA, { type: 'vacation', start_date: '2030-03-04', end_date: '2030-03-06' }).expect(201);
    expect((await ask(ANNA, { type: 'sick', start_date: '2030-03-06' }).expect(409)).body.error).toMatch(/already has leave from 2030-03-04/);
    expect((await ask(ANNA, { type: 'vacation', start_date: '2030-12-30', end_date: '2031-01-02' }).expect(422)).body.details[0].message).toMatch(/Split leave at the new year/);
  });
});

describe('who may do what', () => {
  it('an editor requests only their own leave; manage requests for anyone', async () => {
    expect((await ask(BOB, { employee_id: anna, type: 'vacation', start_date: '2030-03-04' }).expect(403)).body.error).toBe('You can only request leave for yourself');
    expect((await ask(as('edit', 'stranger@example'), { type: 'vacation', start_date: '2030-03-04' }).expect(403)).body.error).toMatch(/No employee record carries/);
    await ask(ADMIN, { employee_id: bob, type: 'special', start_date: '2030-03-04' }).expect(201);
    await ask(as('view', 'anna@0815software.example'), { type: 'vacation', start_date: '2030-03-05' }).expect(403);
  });

  it('manage decides — never on their own request — and a rejection says why', async () => {
    const r = (await ask(ANNA, { type: 'vacation', start_date: '2030-03-04' }).expect(201)).body;
    await request(app).post(`/api/leave/requests/${r.id}/approve`).set('Cookie', BOB).send({}).expect(403);
    const annaAsManager = as('manage', 'anna@0815software.example');
    expect((await request(app).post(`/api/leave/requests/${r.id}/approve`).set('Cookie', annaAsManager).send({}).expect(403)).body.error).toBe('Nobody decides their own leave');
    expect((await request(app).get('/api/leave/requests?to_decide=1').set('Cookie', annaAsManager)).body.requests).toEqual([]);
    expect((await request(app).get('/api/leave/requests?to_decide=1').set('Cookie', BOSS)).body.requests.map((x: { id: number }) => x.id)).toEqual([r.id]);
    await request(app).post(`/api/leave/requests/${r.id}/reject`).set('Cookie', BOSS).send({}).expect(422);
    const rejected = await request(app).post(`/api/leave/requests/${r.id}/reject`).set('Cookie', BOSS).send({ note: 'Messe' }).expect(200);
    expect(rejected.body).toMatchObject({ status: 'rejected', decided_by: 'david@0815software.example', decision_note: 'Messe' });
    await request(app).post(`/api/leave/requests/${r.id}/approve`).set('Cookie', BOSS).send({}).expect(409);
    const detail = (await request(app).get(`/api/leave/requests/${r.id}`).set('Cookie', ANNA).expect(200)).body;
    expect(detail.events.map((e: { type: string; actor: string }) => [e.type, e.actor])).toEqual([
      ['requested', 'anna@0815software.example'],
      ['rejected', 'david@0815software.example'],
    ]);
  });

  it('withdrawing: a request, or approved leave not yet begun — not leave already taken', async () => {
    const future = (await ask(ANNA, { type: 'vacation', start_date: '2030-03-04' }).expect(201)).body;
    await request(app).post(`/api/leave/requests/${future.id}/approve`).set('Cookie', BOSS).send({}).expect(200);
    await request(app).post(`/api/leave/requests/${future.id}/withdraw`).set('Cookie', BOB).expect(403);
    expect((await request(app).post(`/api/leave/requests/${future.id}/withdraw`).set('Cookie', ANNA).expect(200)).body.status).toBe('withdrawn');
    const past = (await ask(ANNA, { type: 'vacation', start_date: '2026-05-11' }).expect(201)).body;
    await request(app).post(`/api/leave/requests/${past.id}/approve`).set('Cookie', BOSS).send({}).expect(200);
    expect((await request(app).post(`/api/leave/requests/${past.id}/withdraw`).set('Cookie', ANNA).expect(409)).body.error).toMatch(/has begun/);
  });

  it('someone with leave on record is not deleted', async () => {
    await request(app).delete(`/api/employees/${anna}`).set('Cookie', ADMIN).expect(409);
  });
});

describe('sick leave is private', () => {
  it('is recorded, not requested — and others see only "absent"', async () => {
    const sick = (await ask(ANNA, { type: 'sick', start_date: '2030-03-04', end_date: '2030-03-05', note: 'Grippe' }).expect(201)).body;
    expect(sick).toMatchObject({ type: 'sick', status: 'approved', decided_by: 'anna@0815software.example', note: 'Grippe' });
    const seenBy = async (cookie: string) => (await request(app).get(`/api/leave/requests?employee_id=${anna}`).set('Cookie', cookie)).body.requests[0];
    expect(await seenBy(BOB)).toMatchObject({ type: 'absent', note: null });
    expect(await seenBy(as('view', 'clara@0815software.example'))).toMatchObject({ type: 'absent', note: null });
    expect(await seenBy(BOSS)).toMatchObject({ type: 'sick', note: 'Grippe' });
    const calendar = (await request(app).get('/api/leave/calendar?month=2030-03').set('Cookie', BOB).expect(200)).body;
    expect(calendar.rows.find((r: { employee_id: number }) => r.employee_id === anna).absences).toEqual([
      { date: '2030-03-04', type: 'absent', status: 'approved', half: false },
      { date: '2030-03-05', type: 'absent', status: 'approved', half: false },
    ]);
  });
});

describe('the team calendar', () => {
  it('a month of days with their holidays, and each person’s absences on working days only', async () => {
    await ask(ANNA, { type: 'vacation', start_date: '2026-05-11', end_date: '2026-05-17' }).expect(201);
    const cal = (await request(app).get('/api/leave/calendar?month=2026-05').set('Cookie', as('view', 'x@example')).expect(200)).body;
    expect(cal.days).toHaveLength(31);
    expect(cal.days.find((d: { date: string }) => d.date === '2026-05-14')).toEqual({ date: '2026-05-14', weekday: 4, holiday: 'Christi Himmelfahrt' });
    const absences = cal.rows.find((r: { employee_id: number }) => r.employee_id === anna).absences.map((a: { date: string }) => a.date);
    expect(absences).toEqual(['2026-05-11', '2026-05-12', '2026-05-13', '2026-05-15']);
    expect((await request(app).get('/api/leave/calendar?month=2026-02').set('Cookie', ANNA)).body.days).toHaveLength(28);
  });
});
