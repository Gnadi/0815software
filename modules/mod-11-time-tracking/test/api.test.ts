import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { AuthConfig } from '../server/auth.js';
import { billableCents, weekStartOf } from '../shared/time.js';
import type { Employee, Project, TimeEntry, TimesheetDetail } from '../shared/types.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

let db: Database.Database;
let app: Express;
let cookie: string;

async function makeEmployee(name: string): Promise<number> {
  const res = await request(app).post('/api/employees').set('Cookie', cookie).send({ name });
  expect(res.status).toBe(201);
  return (res.body as Employee).id;
}

async function makeProject(
  name: string,
  rateCents: number,
  billableDefault = true,
): Promise<number> {
  const res = await request(app)
    .post('/api/projects')
    .set('Cookie', cookie)
    .send({ name, rate_cents: rateCents, billable_default: billableDefault });
  expect(res.status).toBe(201);
  return (res.body as Project).id;
}

async function addEntry(values: Record<string, unknown>): Promise<request.Response> {
  return request(app).post('/api/entries').set('Cookie', cookie).send(values);
}

async function week(employeeId: number, date: string): Promise<TimesheetDetail> {
  const res = await request(app)
    .get(`/api/timesheets/${employeeId}/${date}`)
    .set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as TimesheetDetail;
}

beforeAll(async () => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth });
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
});

describe('auth', () => {
  it('rejects unauthenticated requests with 401', async () => {
    for (const path of ['/api/projects', '/api/employees', '/api/day?employee_id=1&date=2025-01-06', '/api/summary?from=2025-01-01&to=2025-01-31']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
    const post = await request(app).post('/api/entries').send({});
    expect(post.status).toBe(401);
  });

  it('rejects bad credentials, accepts good ones with an HttpOnly cookie', async () => {
    const bad = await request(app).post('/api/login').send({ username: 'admin', password: 'wrong' });
    expect(bad.status).toBe(401);
    const good = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
    expect(good.status).toBe(200);
    expect(good.headers['set-cookie']![0]).toContain('mod11_session=');
    expect(good.headers['set-cookie']![0]).toContain('HttpOnly');
  });
});

describe('time is stored as integer minutes', () => {
  let emp: number;
  let proj: number;
  beforeAll(async () => {
    emp = await makeEmployee('Minutes Tester');
    proj = await makeProject('Minutes Project', 6000);
  });

  it('rejects zero, negative, fractional and non-numeric minutes with 422', async () => {
    for (const minutes of [0, -5, 10.5, 'abc', null, true]) {
      const res = await addEntry({ employee_id: emp, project_id: proj, entry_date: '2023-02-06', minutes });
      expect(res.status, `minutes=${String(minutes)}`).toBe(422);
      expect(res.body.details.map((d: { field: string }) => d.field)).toContain('minutes');
    }
  });

  it('rejects a single entry over 24h (1440 min) with 422', async () => {
    const res = await addEntry({ employee_id: emp, project_id: proj, entry_date: '2023-02-06', minutes: 1441 });
    expect(res.status).toBe(422);
  });

  it('accepts a valid integer-minute entry', async () => {
    const res = await addEntry({ employee_id: emp, project_id: proj, entry_date: '2023-02-06', minutes: 120 });
    expect(res.status).toBe(201);
    expect((res.body as TimeEntry).minutes).toBe(120);
  });
});

describe('the 24h/day cap is enforced across multiple entries', () => {
  it('a second entry that pushes the (employee, date) total over 1440 min → 422', async () => {
    const emp = await makeEmployee('Cap Tester');
    const proj = await makeProject('Cap Project', 6000);
    const date = '2023-03-06';

    const first = await addEntry({ employee_id: emp, project_id: proj, entry_date: date, minutes: 800 });
    expect(first.status).toBe(201);

    // 800 + 700 = 1500 > 1440 — rejected, and nothing is written.
    const second = await addEntry({ employee_id: emp, project_id: proj, entry_date: date, minutes: 700 });
    expect(second.status).toBe(422);
    expect(second.body.details[0].message).toContain('1440');

    // A third entry that fits exactly (800 + 640 = 1440) is fine.
    const third = await addEntry({ employee_id: emp, project_id: proj, entry_date: date, minutes: 640 });
    expect(third.status).toBe(201);

    // The day now sums to exactly 1440; one more minute is rejected.
    const over = await addEntry({ employee_id: emp, project_id: proj, entry_date: date, minutes: 1 });
    expect(over.status).toBe(422);

    // A different day for the same employee is unaffected.
    const otherDay = await addEntry({ employee_id: emp, project_id: proj, entry_date: '2023-03-07', minutes: 600 });
    expect(otherDay.status).toBe(201);
  });
});

describe('billable amount is derived with documented rounding', () => {
  it('billableCents(minutes, rate) rounds half away from zero at the boundary', () => {
    expect(billableCents(3, 10)).toBe(1); // 0.5 → 1
    expect(billableCents(7, 9000)).toBe(1050); // exact
    expect(billableCents(90, 9000)).toBe(13500); // exact
    expect(billableCents(7, 10000)).toBe(1167); // 1166.67 → 1167
    expect(billableCents(1, 10000)).toBe(167); // 166.67 → 167
  });

  it('exposes the derived amount on entries; non-billable entries are 0', async () => {
    const emp = await makeEmployee('Rounding Tester');
    const proj = await makeProject('Rounding Project', 9000); // €90/h

    const seven = await addEntry({ employee_id: emp, project_id: proj, entry_date: '2023-04-03', minutes: 7 });
    expect((seven.body as TimeEntry).billable_cents).toBe(1050);

    const ninety = await addEntry({ employee_id: emp, project_id: proj, entry_date: '2023-04-03', minutes: 90 });
    expect((ninety.body as TimeEntry).billable_cents).toBe(13500);

    const nonBill = await addEntry({
      employee_id: emp,
      project_id: proj,
      entry_date: '2023-04-03',
      minutes: 60,
      billable: false,
    });
    expect((nonBill.body as TimeEntry).billable).toBe(false);
    expect((nonBill.body as TimeEntry).billable_cents).toBe(0);
  });

  it('inherits the project billable default when the flag is omitted', async () => {
    const emp = await makeEmployee('Default Tester');
    const proj = await makeProject('Non-billable Project', 5000, false);
    const res = await addEntry({ employee_id: emp, project_id: proj, entry_date: '2023-04-10', minutes: 60 });
    expect((res.body as TimeEntry).billable).toBe(false);
    expect((res.body as TimeEntry).billable_cents).toBe(0);
  });
});

describe('rollups are derived by query and match hand-computed fixtures', () => {
  it('per-project and per-employee rollups sum the underlying entries', async () => {
    const emp = await makeEmployee('Rollup Tester');
    const proj = await makeProject('Rollup Project', 6000); // €60/h
    // Same week (any dates in the same Mon–Sun window).
    await addEntry({ employee_id: emp, project_id: proj, entry_date: '2023-06-06', minutes: 120 }); // €120.00
    await addEntry({ employee_id: emp, project_id: proj, entry_date: '2023-06-06', minutes: 60, billable: false });
    await addEntry({ employee_id: emp, project_id: proj, entry_date: '2023-06-07', minutes: 90 }); // €90.00

    const summary = await request(app)
      .get('/api/summary?from=2023-06-01&to=2023-06-30')
      .set('Cookie', cookie);
    expect(summary.status).toBe(200);
    const byProject = summary.body.by_project.find((r: { project_id: number }) => r.project_id === proj);
    expect(byProject).toMatchObject({
      total_minutes: 270,
      billable_minutes: 210,
      billable_cents: 21_000, // round(120×60) + round(90×60) = 12000 + 9000
      entry_count: 3,
    });
    const byEmployee = summary.body.by_employee.find((r: { employee_id: number }) => r.employee_id === emp);
    expect(byEmployee).toMatchObject({ total_minutes: 270, billable_minutes: 210, billable_cents: 21_000, entry_count: 3 });

    // The weekly timesheet rollup agrees with the range summary.
    const ws = await week(emp, '2023-06-06');
    expect(ws.total_minutes).toBe(270);
    expect(ws.billable_cents).toBe(21_000);
    expect(ws.by_project[0]).toMatchObject({ project_id: proj, billable_cents: 21_000 });
  });
});

describe('weekly approval locks an approved week', () => {
  let emp: number;
  let proj: number;
  let entryId: number;
  const anyDay = '2023-07-04';
  const weekStart = weekStartOf(anyDay);

  beforeAll(async () => {
    emp = await makeEmployee('Approval Tester');
    proj = await makeProject('Approval Project', 6000);
    const e = await addEntry({ employee_id: emp, project_id: proj, entry_date: anyDay, minutes: 120 });
    entryId = (e.body as TimeEntry).id;
  });

  it('submit requires a non-empty draft and approve requires submitted', async () => {
    const emptyEmp = await makeEmployee('Empty Week');
    const emptySubmit = await request(app)
      .post('/api/timesheets/submit')
      .set('Cookie', cookie)
      .send({ employee_id: emptyEmp, week_start: weekStart });
    expect(emptySubmit.status).toBe(422);

    const earlyApprove = await request(app)
      .post('/api/timesheets/approve')
      .set('Cookie', cookie)
      .send({ employee_id: emp, week_start: weekStart });
    expect(earlyApprove.status).toBe(409); // still draft
  });

  it('submits then approves, recording append-only events', async () => {
    const submitted = await request(app)
      .post('/api/timesheets/submit')
      .set('Cookie', cookie)
      .send({ employee_id: emp, week_start: anyDay }); // mid-week date normalises to Monday
    expect(submitted.status).toBe(200);
    expect((submitted.body as TimesheetDetail).status).toBe('submitted');
    expect((submitted.body as TimesheetDetail).week_start).toBe(weekStart);

    const approved = await request(app)
      .post('/api/timesheets/approve')
      .set('Cookie', cookie)
      .send({ employee_id: emp, week_start: weekStart, note: 'ok' });
    expect(approved.status).toBe(200);
    const detail = approved.body as TimesheetDetail;
    expect(detail.status).toBe('approved');
    const actions = detail.events.map((e) => e.action);
    expect(actions).toEqual(['submit', 'approve']);
    expect(detail.events[1]).toMatchObject({ from_status: 'submitted', to_status: 'approved', actor: 'admin', note: 'ok' });
  });

  it('locks entries in the approved week: edit, delete and new inserts all → 409', async () => {
    const edit = await request(app)
      .put(`/api/entries/${entryId}`)
      .set('Cookie', cookie)
      .send({ employee_id: emp, project_id: proj, entry_date: anyDay, minutes: 200 });
    expect(edit.status).toBe(409);

    const del = await request(app).delete(`/api/entries/${entryId}`).set('Cookie', cookie);
    expect(del.status).toBe(409);

    const insert = await addEntry({ employee_id: emp, project_id: proj, entry_date: anyDay, minutes: 30 });
    expect(insert.status).toBe(409);

    // The entry is untouched.
    const still = await request(app).get(`/api/entries/${entryId}`).set('Cookie', cookie);
    expect((still.body as TimeEntry).minutes).toBe(120);
    expect((still.body as TimeEntry).locked).toBe(true);
  });
});

describe('rejecting a submitted week returns it to draft and records it', () => {
  it('reject → draft, editable again, with a reject event in the history', async () => {
    const emp = await makeEmployee('Reject Tester');
    const proj = await makeProject('Reject Project', 6000);
    const day = '2023-08-08';
    const ws = weekStartOf(day);
    const e = await addEntry({ employee_id: emp, project_id: proj, entry_date: day, minutes: 120 });
    const entryId = (e.body as TimeEntry).id;

    await request(app).post('/api/timesheets/submit').set('Cookie', cookie).send({ employee_id: emp, week_start: ws });

    const rejected = await request(app)
      .post('/api/timesheets/reject')
      .set('Cookie', cookie)
      .send({ employee_id: emp, week_start: ws, note: 'fix the Tuesday entry' });
    expect(rejected.status).toBe(200);
    const detail = rejected.body as TimesheetDetail;
    expect(detail.status).toBe('draft');
    const reject = detail.events.find((ev) => ev.action === 'reject');
    expect(reject).toMatchObject({ from_status: 'submitted', to_status: 'draft', note: 'fix the Tuesday entry' });

    // Back in draft, the entry is editable again.
    const edit = await request(app)
      .put(`/api/entries/${entryId}`)
      .set('Cookie', cookie)
      .send({ employee_id: emp, project_id: proj, entry_date: day, minutes: 90 });
    expect(edit.status).toBe(200);
    expect((edit.body as TimeEntry).minutes).toBe(90);

    // Rejecting a draft (nothing submitted) is a 409.
    const again = await request(app)
      .post('/api/timesheets/reject')
      .set('Cookie', cookie)
      .send({ employee_id: emp, week_start: ws });
    expect(again.status).toBe(409);
  });
});

describe('project and task delete guards', () => {
  it('a project with entries cannot be deleted (409); an unused one can', async () => {
    const empty = await makeProject('Deletable Project', 5000);
    const del = await request(app).delete(`/api/projects/${empty}`).set('Cookie', cookie);
    expect(del.status).toBe(200);

    const used = await makeProject('Used Project', 5000);
    const emp = await makeEmployee('Delete Guard Tester');
    await addEntry({ employee_id: emp, project_id: used, entry_date: '2023-09-05', minutes: 60 });
    const blocked = await request(app).delete(`/api/projects/${used}`).set('Cookie', cookie);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toContain('archive');
  });

  it('an employee with entries cannot be deleted (409)', async () => {
    const emp = await makeEmployee('Undeletable Employee');
    const proj = await makeProject('Any Project', 5000);
    await addEntry({ employee_id: emp, project_id: proj, entry_date: '2023-09-12', minutes: 60 });
    const blocked = await request(app).delete(`/api/employees/${emp}`).set('Cookie', cookie);
    expect(blocked.status).toBe(409);
  });

  it('a task from another project is rejected with 422', async () => {
    const projA = await makeProject('Project A', 5000);
    const projB = await makeProject('Project B', 5000);
    const emp = await makeEmployee('Task Mismatch Tester');
    const taskRes = await request(app).post(`/api/projects/${projA}/tasks`).set('Cookie', cookie).send({ name: 'A task' });
    const taskId = (taskRes.body as Project).tasks[0]!.id;
    const bad = await addEntry({ employee_id: emp, project_id: projB, task_id: taskId, entry_date: '2023-09-19', minutes: 60 });
    expect(bad.status).toBe(422);
    expect(bad.body.details[0].field).toBe('task_id');
  });
});

describe('CSV export profiles', () => {
  const from = '2024-03-01';
  const to = '2024-03-31';
  let emp: number;
  let proj: number;

  beforeAll(async () => {
    emp = await makeEmployee('CSV Person');
    await request(app).put(`/api/employees/${emp}`).set('Cookie', cookie).send({ name: 'CSV Person', email: 'csv@x.io' });
    proj = await makeProject('CSV Project', 6000); // €60/h
    await addEntry({ employee_id: emp, project_id: proj, entry_date: '2024-03-04', minutes: 90 }); // billable → €90.00
    await addEntry({ employee_id: emp, project_id: proj, entry_date: '2024-03-05', minutes: 30, billable: false });
  });

  async function csv(profile: string): Promise<string[]> {
    const res = await request(app)
      .get(`/api/export/timesheets.csv?profile=${profile}&from=${from}&to=${to}`)
      .set('Cookie', cookie);
    expect(res.status, profile).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    return res.text.trimEnd().split('\r\n');
  }

  it('PAYROLL: one row per employee with decimal hours', async () => {
    const lines = await csv('PAYROLL');
    expect(lines[0]).toBe('employee,email,period_start,period_end,total_hours,billable_hours,nonbillable_hours');
    const row = lines.find((l) => l.startsWith('CSV Person'))!;
    // 90 + 30 = 120 min → 2.00 total, 1.50 billable, 0.50 non-billable
    expect(row).toBe('CSV Person,csv@x.io,2024-03-01,2024-03-31,2.00,1.50,0.50');
  });

  it('BILLING: one row per project with euro amounts (billable only)', async () => {
    const lines = await csv('BILLING');
    expect(lines[0]).toBe('client,project,period_start,period_end,billable_hours,rate_eur,amount_eur');
    const row = lines.find((l) => l.includes('CSV Project'))!;
    // billable 90 min → 1.50 h at €60/h → €90.00
    expect(row).toBe(',CSV Project,2024-03-01,2024-03-31,1.50,60.00,90.00');
  });

  it('DETAIL: one row per entry, semicolon-separated', async () => {
    const lines = await csv('DETAIL');
    expect(lines[0]).toBe('date;employee;client;project;task;minutes;hours;billable;rate_eur;amount_eur;note');
    expect(lines).toContain('2024-03-04;CSV Person;;CSV Project;;90;1.50;yes;60.00;90.00;');
    expect(lines).toContain('2024-03-05;CSV Person;;CSV Project;;30;0.50;no;60.00;0.00;');
  });

  it('rejects an unknown profile and a backwards range with 422', async () => {
    const bad = await request(app).get(`/api/export/timesheets.csv?profile=NOPE&from=${from}&to=${to}`).set('Cookie', cookie);
    expect(bad.status).toBe(422);
    const backwards = await request(app).get(`/api/export/timesheets.csv?profile=PAYROLL&from=${to}&to=${from}`).set('Cookie', cookie);
    expect(backwards.status).toBe(422);
  });

  it('lists the shipped profiles with their scopes', async () => {
    const res = await request(app).get('/api/export/profiles').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const names = res.body.profiles.map((p: { name: string }) => p.name);
    expect(names).toEqual(['PAYROLL', 'BILLING', 'DETAIL']);
    const scopes = res.body.profiles.map((p: { scope: string }) => p.scope);
    expect(scopes).toEqual(['employee', 'project', 'entry']);
  });
});

describe('seed data', () => {
  it('creates an approved (locked) week and a submitted week', async () => {
    // Anna (employee 1) has an approved prior week and a submitted last week in the seed.
    const sheets = await request(app).get('/api/timesheets?employee_id=1').set('Cookie', cookie);
    expect(sheets.status).toBe(200);
    const statuses = sheets.body.timesheets.map((t: { status: string }) => t.status);
    expect(statuses).toContain('approved');
    expect(statuses).toContain('submitted');
  });
});
