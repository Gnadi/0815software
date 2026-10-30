import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import { approveTimesheet, createEmployee, createProject, createTask, deleteEmployee, deleteProject, deleteTask, submitTimesheet } from '../server/tracking.js';
import { localOf, nextLocalMidnight, runningTimer, startTimer, stopTimer } from '../server/timer.js';
import type { RunningTimer, TimerStopResult } from '../shared/types.js';

/**
 * The timer (server/timer.ts): started on a project, stopped into an ordinary
 * entry held to every rule a typed one is; one per person; days local to
 * Europe/Vienna; a forgotten timer capped at local midnight and at the daily
 * maximum (600 minutes by default), and marked so.
 *
 * Times are fixed instants, so the suite does not depend on the day it runs.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 'test-secret', ttlHours: 1, secureCookie: false };
const as = (access: AccessLevel, actor: string) => `${COOKIE_NAME}=${createToken(auth, actor, Date.now(), access)}`;
const ANNA = as('edit', 'anna@example.com');
const OFFICE = as('manage', 'office@example.com');
const at = (iso: string) => Date.parse(iso);

let db: Database.Database;
let app: Express;
let anna: number;
let bob: number;
let project: number;
let task: number;

beforeEach(() => {
  db = openDb(':memory:');
  anna = createEmployee(db, { name: 'Anna', email: 'anna@example.com' });
  bob = createEmployee(db, { name: 'Bob', email: 'bob@example.com' });
  project = createProject(db, { name: 'Website', client: 'ACME', billableDefault: true, rateCents: 9000, active: true });
  task = createTask(db, project, 'Design');
  app = createApp({ db, auth });
});

const start = (employeeId: number, iso: string, extra: Partial<{ taskId: number | null; note: string | null }> = {}) =>
  startTimer(db, { employeeId, projectId: project, taskId: extra.taskId ?? null, note: extra.note ?? null, billable: null }, 'anna@example.com', at(iso));

describe('local days, without a library', () => {
  it('a day is the day where the people work, across the clock change', () => {
    // 00:30 in Vienna on 21 October is still 20 October in UTC.
    expect(localOf(at('2026-10-20T22:30:00Z'), 'Europe/Vienna')).toEqual({ date: '2026-10-21', weekday: 3, hour: 0 });
    // Summer time: midnight is 22:00 UTC. The 25th has 25 hours (CEST → CET), so its midnight is 23:00 UTC.
    expect(new Date(nextLocalMidnight(at('2026-10-20T08:00:00Z'), 'Europe/Vienna')).toISOString()).toBe('2026-10-20T22:00:00.000Z');
    expect(new Date(nextLocalMidnight(at('2026-10-24T22:30:00Z'), 'Europe/Vienna')).toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });
});

describe('start, stop, and the entry it writes', () => {
  it('runs on the server; stopping writes the entry, marked as the timer\'s', () => {
    start(anna, '2026-10-20T07:00:00Z', { taskId: task, note: 'Landing page' });
    expect(runningTimer(db, anna, at('2026-10-20T08:30:20Z'))).toMatchObject({ project_name: 'Website', task_name: 'Design', elapsed_minutes: 90, started_by: 'anna@example.com' });
    const stopped = stopTimer(db, anna, 'anna@example.com', at('2026-10-20T09:15:40Z'));
    expect(stopped).toMatchObject({ minutes: 136, capped: false, discarded: false });
    expect(stopped.entry).toMatchObject({ entry_date: '2026-10-20', minutes: 136, task_name: 'Design', note: 'Landing page', billable: true, timer: { started_at: '2026-10-20T07:00:00Z', stopped_at: '2026-10-20T09:15:40Z', capped: false } });
    expect(runningTimer(db, anna)).toBeNull();
    expect(db.prepare('SELECT kind, minutes, actor FROM timer_events ORDER BY id').all()).toEqual([
      { kind: 'start', minutes: null, actor: 'anna@example.com' },
      { kind: 'stop', minutes: 136, actor: 'anna@example.com' },
    ]);
  });

  it('one clock per person: starting another stops the running one first', () => {
    start(anna, '2026-10-20T07:00:00Z');
    const second = startTimer(db, { employeeId: anna, projectId: project, taskId: task, note: null, billable: false }, 'anna@example.com', at('2026-10-20T08:00:00Z'));
    expect(second.stopped).toMatchObject({ minutes: 60 });
    expect(second.timer).toMatchObject({ task_name: 'Design', billable: false, started_at: '2026-10-20T08:00:00Z' });
    // Bob's clock is his own.
    start(bob, '2026-10-20T08:00:00Z');
    expect(runningTimer(db, anna)).not.toBeNull();
  });

  it('a click by mistake leaves no entry', () => {
    start(anna, '2026-10-20T07:00:00Z');
    expect(stopTimer(db, anna, 'anna@example.com', at('2026-10-20T07:00:25Z'))).toEqual({ entry: null, minutes: 0, capped: false, discarded: true });
    expect(db.prepare('SELECT COUNT(*) AS n FROM time_entries').get()).toEqual({ n: 0 });
  });

  it('the day is local: a timer started 00:30 in Vienna books the Vienna day', () => {
    start(anna, '2026-10-20T22:30:00Z');
    expect(stopTimer(db, anna, 'anna@example.com', at('2026-10-20T23:30:00Z')).entry).toMatchObject({ entry_date: '2026-10-21', minutes: 60 });
  });
});

describe('a forgotten timer', () => {
  it('ends at local midnight, and the entry says it was capped', () => {
    start(anna, '2026-10-20T20:00:00Z'); // 22:00 in Vienna
    const r = stopTimer(db, anna, 'anna@example.com', at('2026-10-21T06:30:00Z'));
    expect(r).toMatchObject({ minutes: 120, capped: true });
    expect(r.entry).toMatchObject({ entry_date: '2026-10-20', timer: { stopped_at: '2026-10-20T22:00:00Z', capped: true } });
  });

  it('ends at the daily maximum (600 minutes by default)', () => {
    start(anna, '2026-10-20T05:00:00Z');
    expect(stopTimer(db, anna, 'anna@example.com', at('2026-10-20T19:00:00Z'))).toMatchObject({ minutes: 600, capped: true });
  });

  it('may be stopped at the time one actually finished — not before it started, not in the future', () => {
    start(anna, '2026-10-20T07:00:00Z');
    const refusal = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return (err as { details: { message: string }[] }).details[0]!.message;
      }
      throw new Error('expected a refusal');
    };
    expect(refusal(() => stopTimer(db, anna, 'anna@example.com', at('2026-10-20T12:00:00Z'), at('2026-10-20T06:00:00Z')))).toBe('A timer cannot stop before it started');
    expect(refusal(() => stopTimer(db, anna, 'anna@example.com', at('2026-10-20T12:00:00Z'), at('2026-10-20T13:00:00Z')))).toBe('A timer cannot stop in the future');
    expect(stopTimer(db, anna, 'anna@example.com', at('2026-10-21T08:00:00Z'), at('2026-10-20T15:30:00Z'))).toMatchObject({ minutes: 510, capped: false });
  });
});

describe('the rules a typed entry keeps', () => {
  it('an approved week stays locked: the stop is refused and the timer kept, to be discarded', async () => {
    const monday = '2026-10-19';
    db.prepare('INSERT INTO time_entries (employee_id, project_id, entry_date, minutes, billable, created_at) VALUES (?, ?, ?, 60, 1, ?)').run(anna, project, monday, 'x');
    submitTimesheet(db, anna, monday, 'anna@example.com');
    approveTimesheet(db, anna, monday, 'office@example.com', null);
    start(anna, '2026-10-20T07:00:00Z');
    expect(() => stopTimer(db, anna, 'anna@example.com', at('2026-10-20T08:00:00Z'))).toThrow(/approved and locked/);
    expect(runningTimer(db, anna)).not.toBeNull();
    await request(app).post('/api/timer/discard').set('Cookie', ANNA).send({}).expect(200);
    expect(runningTimer(db, anna)).toBeNull();
    expect(db.prepare("SELECT kind FROM timer_events WHERE kind = 'discard'").all()).toHaveLength(1);
  });

  it('below manage, only one\'s own timer; the office runs anyone\'s', async () => {
    await request(app).post('/api/timer/start').set('Cookie', ANNA).send({ project_id: project, employee_id: bob }).expect(403);
    const started = (await request(app).post('/api/timer/start').set('Cookie', ANNA).send({ project_id: project }).expect(201)).body as { timer: RunningTimer };
    expect(started.timer.employee_id).toBe(anna);
    expect((await request(app).get('/api/timer').set('Cookie', ANNA).expect(200)).body.timer.project_name).toBe('Website');
    await request(app).post('/api/timer/stop').set('Cookie', ANNA).send({ employee_id: bob }).expect(403);
    await request(app).post('/api/timer/start').set('Cookie', OFFICE).send({ project_id: project, employee_id: bob }).expect(201);
    expect((await request(app).get('/api/timers').set('Cookie', OFFICE).expect(200)).body.timers).toHaveLength(2);
    await request(app).get('/api/timers').set('Cookie', ANNA).expect(403);
    await request(app).post('/api/timer/start').set('Cookie', as('view', 'anna@example.com')).send({ project_id: project }).expect(403);
    // No employee record for this login: told, not guessed.
    expect((await request(app).post('/api/timer/start').set('Cookie', as('edit', 'stranger@example.com')).send({ project_id: project }).expect(404)).body.error).toMatch(/No employee record/);
  });

  it('what it is for can change while it runs; an archived project or a foreign task is refused', async () => {
    const other = createProject(db, { name: 'Old', client: null, billableDefault: false, rateCents: 0, active: false });
    await request(app).post('/api/timer/start').set('Cookie', ANNA).send({ project_id: other }).expect(422);
    await request(app).post('/api/timer/start').set('Cookie', ANNA).send({ project_id: project }).expect(201);
    const moved = (await request(app).put('/api/timer').set('Cookie', ANNA).send({ project_id: project, task_id: task, note: 'Logo' }).expect(200)).body.timer as RunningTimer;
    expect(moved).toMatchObject({ task_name: 'Design', note: 'Logo' });
    const foreign = createTask(db, createProject(db, { name: 'B', client: null, billableDefault: true, rateCents: 0, active: true }), 'X');
    await request(app).put('/api/timer').set('Cookie', ANNA).send({ project_id: project, task_id: foreign }).expect(422);
    const stopped = (await request(app).post('/api/timer/stop').set('Cookie', ANNA).send({ stopped_at: 'yesterday-ish' }).expect(422)).body;
    expect(stopped.details[0].field).toBe('stopped_at');
    await request(app).post('/api/timer/stop').set('Cookie', ANNA).send({}).expect(200);
    await request(app).post('/api/timer/stop').set('Cookie', ANNA).send({}).expect(409);
  });
});

describe('a running timer holds what it points at', () => {
  it('its project, task and person cannot be deleted from under it', () => {
    const spare = createProject(db, { name: 'Spare', client: null, billableDefault: true, rateCents: 0, active: true });
    const sketch = createTask(db, spare, 'Sketch');
    startTimer(db, { employeeId: anna, projectId: spare, taskId: sketch, note: null, billable: null }, 'anna@example.com', at('2026-10-20T07:00:00Z'));
    expect(() => deleteTask(db, sketch)).toThrow(/timer is running/);
    expect(() => deleteProject(db, spare)).toThrow(/timer is running/);
    expect(() => deleteEmployee(db, anna)).toThrow(/timer records/);
    stopTimer(db, anna, 'anna@example.com', at('2026-10-20T07:00:20Z')); // discarded: under a minute
    deleteTask(db, sketch);
    deleteProject(db, spare);
    // The start and the discard stay in the log, so the person stays too.
    expect(() => deleteEmployee(db, anna)).toThrow(/timer records/);
  });
});

describe('the time zone is the office\'s', () => {
  it('is set by a manager and must be a real zone', async () => {
    await request(app).put('/api/settings/timer').set('Cookie', ANNA).send({ timezone: 'Europe/Berlin' }).expect(403);
    await request(app).put('/api/settings/timer').set('Cookie', OFFICE).send({ timezone: 'Mars/Olympus' }).expect(422);
    const saved = (await request(app).put('/api/settings/timer').set('Cookie', OFFICE).send({ timezone: 'America/New_York' }).expect(200)).body;
    expect(saved).toMatchObject({ settings: { timezone: 'America/New_York' }, updated_by: 'office@example.com', notification_configured: false });
    // 03:00 UTC is still the evening before in New York.
    start(anna, '2026-10-21T03:00:00Z');
    expect((stopTimer(db, anna, 'anna@example.com', at('2026-10-21T03:30:00Z')) as TimerStopResult).entry!.entry_date).toBe('2026-10-20');
  });
});
