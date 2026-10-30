import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import { createEmployee, createProject, createTask } from '../server/tracking.js';
import { addSchedule } from '../server/schedules.js';
import { addEntitlement, createRequest } from '../server/leave.js';
import { planTask } from '../server/planning.js';
import { flexAccount } from '../server/flextime.js';
import { myOverview } from '../server/my-area.js';
import { startTimer } from '../server/timer.js';

/**
 * "My area" (server/my-area.ts): one person's own figures, each the very
 * number its own screen shows — so the test compares with those functions
 * rather than restating the arithmetic. The clock: Wednesday 21 October 2026.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 'test-secret', ttlHours: 1, secureCookie: false };
const as = (access: AccessLevel, actor: string) => `${COOKIE_NAME}=${createToken(auth, actor, Date.now(), access)}`;
const NOW = Date.parse('2026-10-21T08:00:00Z');
const viewer = { actor: 'anna@example.com', access: 'edit' as AccessLevel };

let db: Database.Database;
let anna: number;

beforeEach(() => {
  db = openDb(':memory:');
  anna = createEmployee(db, { name: 'Anna', email: 'anna@example.com' });
  const bob = createEmployee(db, { name: 'Bob', email: 'bob@example.com' });
  const project = createProject(db, { name: 'Website', client: null, billableDefault: true, rateCents: 0, active: true });
  addSchedule(db, anna, { validFrom: '2026-10-05', weeklyMinutes: 2400, workDays: '12345', note: null }, 'office');
  const book = (date: string, minutes: number) =>
    db.prepare('INSERT INTO time_entries (employee_id, project_id, entry_date, minutes, billable, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(anna, project, date, minutes, 'x');
  book('2026-10-14', 480);
  book('2026-10-19', 450);
  book('2026-10-20', 300);
  addEntitlement(db, anna, { year: 2026, kind: 'allowance', days: 25, note: null }, 'office');
  createRequest(db, { employeeId: anna, type: 'vacation', startDate: '2026-11-02', endDate: '2026-11-04', halfDay: false, note: null }, viewer, '2026-10-21');
  const mine = createTask(db, project, 'Landing page');
  const theirs = createTask(db, project, 'Backend');
  planTask(db, mine, { assigneeId: anna, dueDate: '2026-10-19', estimateMinutes: null, milestoneId: null, description: null });
  planTask(db, theirs, { assigneeId: bob, dueDate: '2026-10-25', estimateMinutes: null, milestoneId: null, description: null });
  startTimer(db, { employeeId: anna, projectId: project, taskId: mine, note: null, billable: null }, 'anna@example.com', NOW - 45 * 60_000);
});

describe('my area', () => {
  it('shows this person\'s week, last week, flexitime, leave, requests, tasks and timer', () => {
    const o = myOverview(db, anna, viewer, NOW);
    expect(o).toMatchObject({
      employee: { id: anna, name: 'Anna' },
      today: '2026-10-21',
      timer: { task_name: 'Landing page', elapsed_minutes: 45 },
      week: { week_start: '2026-10-19', minutes: 750, status: 'draft' },
      last_week: { week_start: '2026-10-12', minutes: 480, status: 'draft' },
      pending_requests: 1,
      next_absence: { type: 'vacation', start_date: '2026-11-02', status: 'requested' },
      tasks: { open: 1, overdue: 1 },
    });
    expect(o.tasks.next.map((t) => t.name)).toEqual(['Landing page']);
    // The same figures the flexitime and leave screens show.
    const flex = flexAccount(db, anna, '2026-10-21', viewer);
    expect(o.flex).toEqual({ balance: flex.balance, over_cap: flex.over_cap, under_floor: flex.under_floor });
    expect(o.leave).toMatchObject({ entitled: 25, pending: 3, free: 22 });
  });

  it('is the signed-in person\'s own; a login without an employee record is told so', async () => {
    const app = createApp({ db, auth });
    const res = await request(app).get('/api/my-overview').set('Cookie', as('view', 'Anna@example.com')).expect(200);
    expect(res.body.employee.name).toBe('Anna');
    expect((await request(app).get('/api/my-overview').set('Cookie', as('manage', 'office')).expect(404)).body.error).toMatch(/No employee record/);
  });

  it('without a weekly target there is no flexitime figure, not a zero', () => {
    const bob = (db.prepare("SELECT id FROM employees WHERE name = 'Bob'").get() as { id: number }).id;
    expect(myOverview(db, bob, { actor: 'bob@example.com', access: 'edit' }, NOW).flex).toBeNull();
  });
});
