import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import { createEmployee, createProject, submitTimesheet } from '../server/tracking.js';
import { addSchedule } from '../server/schedules.js';
import { dueReminders, runReminders } from '../server/reminders.js';
import { startTimer, writeTimerSettings, DEFAULT_TIMER_SETTINGS } from '../server/timer.js';
import { noopPlatform, type PlatformHooks } from '../server/platform.js';

/**
 * Reminders (server/reminders.ts): opt-in per kind, sent through PS-03, once
 * per person and occasion; due-ness derived from the local clock and the rows.
 *
 * The clock: Wednesday 21 October 2026. Last week is 12–18 October.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 'test-secret', ttlHours: 1, secureCookie: false };
const as = (access: AccessLevel, actor: string) => `${COOKIE_NAME}=${createToken(auth, actor, Date.now(), access)}`;
const at = (iso: string) => Date.parse(iso);
const WEDNESDAY = at('2026-10-21T08:00:00Z'); // 10:00 in Vienna

let db: Database.Database;
let sent: { to: string; subject: string; idempotencyKey: string; channel: string }[];
let failing: boolean;
let anna: number;
let bob: number;
let carla: number;
let project: number;

const ps03: PlatformHooks = {
  ...noopPlatform,
  notificationConfigured: true,
  async notify(m) {
    if (failing) throw new Error('PS-03 is down');
    sent.push({ to: m.to, subject: m.subject, idempotencyKey: m.idempotencyKey, channel: m.channel });
  },
};

const on = (over: Partial<typeof DEFAULT_TIMER_SETTINGS> = {}) =>
  writeTimerSettings(db, { ...DEFAULT_TIMER_SETTINGS, week_reminder: { enabled: true, weekday: 1, hour: 9 }, timer_reminder: { enabled: true, after_minutes: 540 }, ...over }, 'office');

beforeEach(() => {
  db = openDb(':memory:');
  sent = [];
  failing = false;
  anna = createEmployee(db, { name: 'Anna', email: 'anna@example.com' }); // booked time last week, not submitted
  bob = createEmployee(db, { name: 'Bob', email: 'bob@example.com' }); // submitted
  carla = createEmployee(db, { name: 'Carla', email: 'carla@example.com' }); // no time, but a weekly target
  createEmployee(db, { name: 'Dora', email: 'dora@example.com' }); // tracks no time: not chased
  createEmployee(db, { name: 'Emil', email: null }); // no address
  project = createProject(db, { name: 'Website', client: null, billableDefault: true, rateCents: 0, active: true });
  const book = (id: number, date: string) =>
    db.prepare('INSERT INTO time_entries (employee_id, project_id, entry_date, minutes, billable, created_at) VALUES (?, ?, ?, 120, 1, ?)').run(id, project, date, 'x');
  book(anna, '2026-10-14');
  book(bob, '2026-10-14');
  submitTimesheet(db, bob, '2026-10-12', 'bob@example.com');
  addSchedule(db, carla, { validFrom: '2026-01-05', weeklyMinutes: 2400, workDays: '12345', note: null }, 'office');
});

describe('last week not submitted', () => {
  it('goes to whoever booked time or had a target, once, through the configured channel', async () => {
    expect(dueReminders(db, WEDNESDAY)).toEqual([]); // switched off by default
    on({ channel: 'staff-mail' });
    const due = dueReminders(db, WEDNESDAY);
    expect(due.map((d) => [d.kind, d.name, d.ref])).toEqual([
      ['week_not_submitted', 'Anna', '2026-10-12'],
      ['week_not_submitted', 'Carla', '2026-10-12'],
    ]);
    expect(due[0]!.body).toContain('2:00 booked');
    const first = await runReminders(db, ps03, WEDNESDAY);
    expect(first.map((r) => r.employee_name)).toEqual(['Anna', 'Carla']);
    expect(sent[0]).toEqual({ to: 'anna@example.com', subject: 'Your timesheet for the week of 2026-10-12 is not submitted yet', idempotencyKey: `mod-11:week_not_submitted:${anna}:2026-10-12`, channel: 'staff-mail' });
    // The next tick sends nothing again.
    expect(await runReminders(db, ps03, WEDNESDAY + 600_000)).toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it('not before the weekday and hour, local time', () => {
    on({ week_reminder: { enabled: true, weekday: 3, hour: 11 } });
    expect(dueReminders(db, WEDNESDAY)).toEqual([]); // 10:00 Vienna
    expect(dueReminders(db, at('2026-10-21T09:00:00Z'))).toHaveLength(2); // 11:00 Vienna
  });

  it('a failed send is tried again; without PS-03 nothing is sent or recorded', async () => {
    on();
    failing = true;
    expect(await runReminders(db, ps03, WEDNESDAY)).toEqual([]);
    failing = false;
    expect(await runReminders(db, ps03, WEDNESDAY)).toHaveLength(2);
    const fresh = openDb(':memory:');
    expect(await runReminders(fresh, noopPlatform, WEDNESDAY)).toEqual([]);
  });
});

describe('a timer left running', () => {
  it('is reminded once it has run the configured time', async () => {
    on({ week_reminder: { enabled: false, weekday: 1, hour: 9 } });
    startTimer(db, { employeeId: anna, projectId: project, taskId: null, note: null, billable: null }, 'anna@example.com', at('2026-10-20T22:00:00Z'));
    expect(dueReminders(db, at('2026-10-21T06:59:00Z'))).toEqual([]);
    const due = dueReminders(db, at('2026-10-21T07:00:00Z'));
    expect(due).toMatchObject([{ kind: 'timer_running', name: 'Anna', ref: '2026-10-20T22:00:00Z', subject: 'Your timer on Website is still running' }]);
    await runReminders(db, ps03, at('2026-10-21T07:00:00Z'));
    expect(dueReminders(db, at('2026-10-21T08:00:00Z'))).toEqual([]);
  });
});

describe('the office\'s view', () => {
  let app: Express;
  beforeEach(() => {
    app = createApp({ db, auth, platform: ps03 });
  });

  it('settings, what is due, what was sent, and sending now — manage only', async () => {
    const OFFICE = as('manage', 'office');
    await request(app).put('/api/settings/timer').set('Cookie', as('edit', 'anna@example.com')).send({ timezone: 'Europe/Vienna' }).expect(403);
    await request(app).put('/api/settings/timer').set('Cookie', OFFICE).send({ week_reminder: { enabled: true, weekday: 8, hour: 9 } }).expect(422);
    await request(app).put('/api/settings/timer').set('Cookie', OFFICE).send({ week_reminder: { enabled: true, weekday: 1, hour: 0 } }).expect(200);
    await request(app).get('/api/reminders').set('Cookie', as('edit', 'anna@example.com')).expect(403);
    const before = (await request(app).get('/api/reminders').set('Cookie', OFFICE).expect(200)).body;
    expect(before.notification_configured).toBe(true);
    const run = (await request(app).post('/api/reminders/run').set('Cookie', OFFICE).send({}).expect(200)).body;
    expect(run.sent.length).toBeGreaterThanOrEqual(0);
    const standalone = createApp({ db: openDb(':memory:'), auth });
    await request(standalone).post('/api/reminders/run').set('Cookie', OFFICE).send({}).expect(501);
  });
});
