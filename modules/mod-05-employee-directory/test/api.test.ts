import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { addDays, todayIso } from '../server/directory.js';
import type { AuthConfig } from '../server/auth.js';
import type {
  DepartmentRow,
  EmployeeDetail,
  EmployeeRow,
  OnboardingLists,
  OrgNode,
} from '../shared/types.js';

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

let seq = 0;

async function listEmployees(query = ''): Promise<EmployeeRow[]> {
  const res = await request(app).get(`/api/employees${query}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body.employees as EmployeeRow[];
}

async function detail(id: number): Promise<EmployeeDetail> {
  const res = await request(app).get(`/api/employees/${id}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as EmployeeDetail;
}

async function byName(name: string): Promise<EmployeeRow> {
  const rows = await listEmployees(`?search=${encodeURIComponent(name)}&status=`);
  const row = rows.find((r) => r.name === name);
  expect(row, name).toBeDefined();
  return row!;
}

/** Create an active employee in department 1 (Engineering) with defaults. */
async function createEmployee(overrides: Record<string, unknown> = {}): Promise<EmployeeDetail> {
  seq += 1;
  const res = await request(app)
    .post('/api/employees')
    .set('Cookie', cookie)
    .send({
      name: `Test Person ${seq}`,
      email: `test.person.${seq}@0815software.example`,
      job_title: 'Test Engineer',
      department_id: 1,
      start_date: '2024-01-08',
      ...overrides,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as EmployeeDetail;
}

async function setManager(id: number, managerId: number | null): Promise<request.Response> {
  const current = await detail(id);
  return request(app)
    .put(`/api/employees/${id}`)
    .set('Cookie', cookie)
    .send({
      name: current.name,
      email: current.email,
      job_title: current.job_title,
      department_id: current.department_id,
      manager_id: managerId,
      phone: current.phone,
      location: current.location,
      start_date: current.start_date,
    });
}

async function orgChart(): Promise<OrgNode[]> {
  const res = await request(app).get('/api/orgchart').set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body.roots as OrgNode[];
}

function flatten(nodes: OrgNode[]): OrgNode[] {
  return nodes.flatMap((n) => [n, ...flatten(n.reports)]);
}

beforeAll(async () => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth });

  const res = await request(app)
    .post('/api/login')
    .send({ username: 'admin', password: 'test-password' });
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
});

describe('auth', () => {
  it('rejects unauthenticated requests with 401', async () => {
    for (const path of [
      '/api/employees',
      '/api/employees/1',
      '/api/departments',
      '/api/orgchart',
      '/api/onboarding',
      '/api/employees/export.csv',
    ]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
    const post = await request(app).post('/api/employees').send({});
    expect(post.status).toBe(401);
    const patch = await request(app).patch('/api/employees/1/onboarding').send({});
    expect(patch.status).toBe(401);
  });

  it('rejects bad credentials', async () => {
    const res = await request(app).post('/api/login').send({ username: 'admin', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('accepts good credentials and sets an HttpOnly session cookie', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ username: 'admin', password: 'test-password' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']![0]).toContain('mod05_session=');
    expect(res.headers['set-cookie']![0]).toContain('HttpOnly');
  });
});

describe('the manager graph stays a forest — cycles are rejected with 422', () => {
  it('rejects direct self-management', async () => {
    const a = await createEmployee();
    const res = await setManager(a.id, a.id);
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('manager_id');
    expect((await detail(a.id)).manager_id).toBeNull();
  });

  it('rejects a 2-node cycle (A manages B, then B is set to manage A)', async () => {
    const a = await createEmployee();
    const b = await createEmployee({ manager_id: a.id });
    expect(b.manager_id).toBe(a.id);

    const res = await setManager(a.id, b.id);
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('manager_id');
    expect(res.body.details[0].message).toContain('cycle');
    // Nothing was written.
    expect((await detail(a.id)).manager_id).toBeNull();
    expect((await detail(b.id)).manager_id).toBe(a.id);
  });

  it('rejects a deep transitive cycle (A→B→C→D, then A under D)', async () => {
    const a = await createEmployee();
    const b = await createEmployee({ manager_id: a.id });
    const c = await createEmployee({ manager_id: b.id });
    const d = await createEmployee({ manager_id: c.id });

    const res = await setManager(a.id, d.id);
    expect(res.status).toBe(422);
    expect(res.body.details[0].message).toContain('cycle');
    expect((await detail(a.id)).manager_id).toBeNull();

    // A legal reassignment within the chain still works (D moves under A).
    const ok = await setManager(d.id, a.id);
    expect(ok.status).toBe(200);
    expect(ok.body.manager_id).toBe(a.id);
  });

  it('rejects an unknown manager and an offboarded manager', async () => {
    const a = await createEmployee();
    const missing = await setManager(a.id, 99_999);
    expect(missing.status).toBe(422);

    const gone = await createEmployee();
    await request(app).post(`/api/employees/${gone.id}/offboard`).set('Cookie', cookie);
    const offboarded = await setManager(a.id, gone.id);
    expect(offboarded.status).toBe(422);
    expect(offboarded.body.details[0].message).toContain('offboarded');
  });
});

describe('departments', () => {
  it('round-trips a department and deletes it while empty', async () => {
    const created = await request(app)
      .post('/api/departments')
      .set('Cookie', cookie)
      .send({ name: 'Research', code: 'rnd' });
    expect(created.status).toBe(201);
    expect(created.body.code).toBe('RND'); // normalized to uppercase
    const id = created.body.id as number;

    const updated = await request(app)
      .put(`/api/departments/${id}`)
      .set('Cookie', cookie)
      .send({ name: 'Research & Development', code: 'RND', parent_id: 1 });
    expect(updated.status).toBe(200);
    expect(updated.body.parent_name).toBe('Engineering');

    const deleted = await request(app).delete(`/api/departments/${id}`).set('Cookie', cookie);
    expect(deleted.status).toBe(200);
    const gone = await request(app).get(`/api/departments/${id}`).set('Cookie', cookie);
    expect(gone.status).toBe(404);
  });

  it('refuses to delete a department with employees (409)', async () => {
    const res = await request(app).delete('/api/departments/1').set('Cookie', cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('employees');
  });

  it('refuses to delete a department with child departments (409)', async () => {
    // A fresh parent/child pair so the guard is isolated from employees.
    const parent = await request(app)
      .post('/api/departments')
      .set('Cookie', cookie)
      .send({ name: 'Guard Parent', code: 'GP' });
    const child = await request(app)
      .post('/api/departments')
      .set('Cookie', cookie)
      .send({ name: 'Guard Child', code: 'GC', parent_id: parent.body.id });
    expect(child.status).toBe(201);

    const res = await request(app).delete(`/api/departments/${parent.body.id}`).set('Cookie', cookie);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('child');

    // Delete bottom-up works.
    expect((await request(app).delete(`/api/departments/${child.body.id}`).set('Cookie', cookie)).status).toBe(200);
    expect((await request(app).delete(`/api/departments/${parent.body.id}`).set('Cookie', cookie)).status).toBe(200);
  });

  it('rejects a duplicate code (422) and a parent cycle (422)', async () => {
    const dup = await request(app)
      .post('/api/departments')
      .set('Cookie', cookie)
      .send({ name: 'Engineering Copy', code: 'ENG' });
    expect(dup.status).toBe(422);
    expect(dup.body.details[0].field).toBe('code');

    // ENG (id 1) is the parent of ENG-PLT (id 2) — reparenting ENG under
    // its own child must fail.
    const departments = (await request(app).get('/api/departments').set('Cookie', cookie)).body
      .departments as DepartmentRow[];
    const eng = departments.find((d) => d.code === 'ENG')!;
    const plt = departments.find((d) => d.code === 'ENG-PLT')!;
    expect(plt.parent_id).toBe(eng.id);

    const cycle = await request(app)
      .put(`/api/departments/${eng.id}`)
      .set('Cookie', cookie)
      .send({ name: eng.name, code: eng.code, parent_id: plt.id });
    expect(cycle.status).toBe(422);
    expect(cycle.body.details[0].field).toBe('parent_id');
  });
});

describe('employees', () => {
  it('rejects a duplicate email with 422, case-insensitively', async () => {
    const first = await createEmployee({ email: 'unique.check@0815software.example' });
    const res = await request(app)
      .post('/api/employees')
      .set('Cookie', cookie)
      .send({
        name: 'Copy Cat',
        email: 'Unique.Check@0815software.example',
        job_title: 'Impostor',
        department_id: 1,
        start_date: '2024-01-08',
      });
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('email');

    // Also on update: taking someone else's email fails…
    const other = await createEmployee();
    const steal = await request(app)
      .put(`/api/employees/${other.id}`)
      .set('Cookie', cookie)
      .send({
        name: other.name,
        email: first.email,
        job_title: other.job_title,
        department_id: other.department_id,
        start_date: other.start_date,
      });
    expect(steal.status).toBe(422);

    // …but keeping your own is fine.
    const keep = await setManager(first.id, null);
    expect(keep.status).toBe(200);
  });

  it('validates the payload (missing fields, bad email, bad date)', async () => {
    const res = await request(app)
      .post('/api/employees')
      .set('Cookie', cookie)
      .send({ name: '', email: 'not-an-email', job_title: '', start_date: '08.01.2024' });
    expect(res.status).toBe(422);
    const fields = res.body.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(
      expect.arrayContaining(['name', 'email', 'job_title', 'department_id', 'start_date']),
    );
  });

  it('filters by department, location, and status; unknown status is 422', async () => {
    const departments = (await request(app).get('/api/departments').set('Cookie', cookie)).body
      .departments as DepartmentRow[];
    const sls = departments.find((d) => d.code === 'SLS')!;
    const bySls = await listEmployees(`?department=${sls.id}`);
    expect(bySls.length).toBeGreaterThanOrEqual(4);
    for (const row of bySls) expect(row.department_code).toBe('SLS');

    const byLocation = await listEmployees('?location=Graz');
    expect(byLocation.length).toBeGreaterThanOrEqual(2);
    for (const row of byLocation) expect(row.location).toBe('Graz');

    const offboarded = await listEmployees('?status=offboarded');
    expect(offboarded.length).toBeGreaterThanOrEqual(1);
    for (const row of offboarded) expect(row.status).toBe('offboarded');

    const bad = await request(app).get('/api/employees?status=fired').set('Cookie', cookie);
    expect(bad.status).toBe(422);
  });
});

describe('manager chain', () => {
  it('walks from the immediate manager up to the root, in order', async () => {
    // Seeded 3-level chain: Petra Maier → Klaus Steiner → Johanna Berger.
    const petra = await byName('Petra Maier');
    const d = await detail(petra.id);
    expect(d.manager_chain.map((p) => p.name)).toEqual(['Klaus Steiner', 'Johanna Berger']);
  });

  it('is empty for a root', async () => {
    const johanna = await byName('Johanna Berger');
    const d = await detail(johanna.id);
    expect(d.manager_chain).toEqual([]);
    expect(d.manager_id).toBeNull();
    expect(d.reports.length).toBeGreaterThanOrEqual(3);
  });
});

describe('org chart', () => {
  it('returns the seeded forest: two roots with correct nesting and report counts', async () => {
    // A freshly seeded database, isolated from employees other tests create.
    const freshDb = openDb(':memory:');
    seed(freshDb);
    const freshApp = createApp({ db: freshDb, auth });
    const login = await request(freshApp)
      .post('/api/login')
      .send({ username: 'admin', password: 'test-password' });
    const freshCookie = login.headers['set-cookie']![0]!.split(';')[0]!;
    const res = await request(freshApp).get('/api/orgchart').set('Cookie', freshCookie);
    expect(res.status).toBe(200);
    const roots = res.body.roots as OrgNode[];
    expect(roots.map((r) => r.name).sort()).toEqual(['Johanna Berger', 'Markus Winkler']);

    const johanna = roots.find((r) => r.name === 'Johanna Berger')!;
    const klaus = johanna.reports.find((r) => r.name === 'Klaus Steiner')!;
    expect(klaus.reports.map((r) => r.name)).toContain('Petra Maier');
    expect(klaus.report_count).toBe(klaus.reports.length);

    // report_count matches reports.length on every node.
    for (const node of flatten(roots)) {
      expect(node.report_count, node.name).toBe(node.reports.length);
    }
  });

  it('contains only active employees', async () => {
    const names = flatten(await orgChart()).map((n) => n.name);
    expect(names).not.toContain('Martin Lang'); // seeded offboarded employee
  });
});

describe('offboarding is a soft state, never a delete', () => {
  it('removes the employee from the org chart but keeps the record fetchable', async () => {
    const emp = await createEmployee({ name: 'Leaving Soon', email: 'leaving.soon@0815software.example' });
    expect(flatten(await orgChart()).map((n) => n.id)).toContain(emp.id);

    const res = await request(app).post(`/api/employees/${emp.id}/offboard`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('offboarded');
    expect(res.body.offboarded_at).toBeTruthy();

    // Gone from the chart…
    expect(flatten(await orgChart()).map((n) => n.id)).not.toContain(emp.id);
    // …but the record is still there, with its history.
    const kept = await detail(emp.id);
    expect(kept.name).toBe('Leaving Soon');
    expect(kept.status).toBe('offboarded');
    // And there is no way to hard-delete it.
    const del = await request(app).delete(`/api/employees/${emp.id}`).set('Cookie', cookie);
    expect(del.status).toBe(404); // no such route

    // Offboarding twice is a conflict.
    const again = await request(app).post(`/api/employees/${emp.id}/offboard`).set('Cookie', cookie);
    expect(again.status).toBe(409);
  });

  it('refuses to offboard a manager with active reports (409)', async () => {
    const boss = await createEmployee();
    const report = await createEmployee({ manager_id: boss.id });

    const refused = await request(app).post(`/api/employees/${boss.id}/offboard`).set('Cookie', cookie);
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain('reassign');

    // After reassigning the report, offboarding works.
    await setManager(report.id, null);
    const ok = await request(app).post(`/api/employees/${boss.id}/offboard`).set('Cookie', cookie);
    expect(ok.status).toBe(200);
  });

  it('reactivation restores the employee; a manager who left meanwhile is cleared', async () => {
    const boss = await createEmployee();
    const emp = await createEmployee({ manager_id: boss.id });
    await request(app).post(`/api/employees/${emp.id}/offboard`).set('Cookie', cookie);
    await request(app).post(`/api/employees/${boss.id}/offboard`).set('Cookie', cookie);

    const res = await request(app).post(`/api/employees/${emp.id}/reactivate`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('active');
    expect(res.body.manager_id).toBeNull(); // boss is gone → new root
    expect(flatten(await orgChart()).map((n) => n.id)).toContain(emp.id);
  });
});

describe('onboarding window is relative to today', () => {
  async function lists(): Promise<OnboardingLists> {
    const res = await request(app).get('/api/onboarding').set('Cookie', cookie);
    expect(res.status).toBe(200);
    return res.body as OnboardingLists;
  }

  it('includes starts within [today − 14, today + 30] and nothing outside', async () => {
    const today = todayIso();
    const inTen = await createEmployee({ start_date: addDays(today, 10) });
    const startedFive = await createEmployee({ start_date: addDays(today, -5) });
    const farFuture = await createEmployee({ start_date: addDays(today, 40) });
    const longAgo = await createEmployee({ start_date: addDays(today, -20) });
    const edgeIn = await createEmployee({ start_date: addDays(today, 30) });
    const edgeOut = await createEmployee({ start_date: addDays(today, -15) });

    const { upcoming, recent } = await lists();
    const upcomingIds = upcoming.map((e) => e.id);
    const recentIds = recent.map((e) => e.id);

    expect(upcomingIds).toContain(inTen.id);
    expect(upcomingIds).toContain(edgeIn.id);
    expect(recentIds).toContain(startedFive.id);
    const all = [...upcomingIds, ...recentIds];
    expect(all).not.toContain(farFuture.id);
    expect(all).not.toContain(longAgo.id);
    expect(all).not.toContain(edgeOut.id);

    const ten = upcoming.find((e) => e.id === inTen.id)!;
    expect(ten.days_until_start).toBe(10);
    const five = recent.find((e) => e.id === startedFive.id)!;
    expect(five.days_until_start).toBe(-5);
  });

  it('excludes offboarded employees even inside the window', async () => {
    const emp = await createEmployee({ start_date: addDays(todayIso(), -3) });
    await request(app).post(`/api/employees/${emp.id}/offboard`).set('Cookie', cookie);
    const { upcoming, recent } = await lists();
    expect([...upcoming, ...recent].map((e) => e.id)).not.toContain(emp.id);
  });

  it('stores checklist flags independently and round-trips them', async () => {
    const emp = await createEmployee({ start_date: addDays(todayIso(), 5) });
    expect(emp.onboarding).toEqual({
      account_created: false,
      hardware_issued: false,
      intro_meeting_booked: false,
    });

    const first = await request(app)
      .patch(`/api/employees/${emp.id}/onboarding`)
      .set('Cookie', cookie)
      .send({ account_created: true });
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      account_created: true,
      hardware_issued: false,
      intro_meeting_booked: false,
    });

    // A second toggle does not reset the first flag.
    const second = await request(app)
      .patch(`/api/employees/${emp.id}/onboarding`)
      .set('Cookie', cookie)
      .send({ intro_meeting_booked: true });
    expect(second.body).toEqual({
      account_created: true,
      hardware_issued: false,
      intro_meeting_booked: true,
    });

    // Reflected in the detail and in the onboarding view.
    expect((await detail(emp.id)).onboarding.account_created).toBe(true);
    const { upcoming } = await lists();
    expect(upcoming.find((e) => e.id === emp.id)!.onboarding.intro_meeting_booked).toBe(true);

    const bad = await request(app)
      .patch(`/api/employees/${emp.id}/onboarding`)
      .set('Cookie', cookie)
      .send({ account_created: 'yes' });
    expect(bad.status).toBe(422);
  });
});

describe('CSV export', () => {
  it('returns valid CSV mirroring the directory listing', async () => {
    const res = await request(app).get('/api/employees/export.csv?status=active').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('employee-directory.csv');

    const lines = (res.text as string).trimEnd().split('\r\n');
    expect(lines[0]).toBe(
      'name,email,job_title,department_code,department,manager,phone,location,start_date,status',
    );
    const active = await listEmployees('?status=active');
    expect(lines.length).toBe(active.length + 1);
    for (const line of lines.slice(1)) expect(line).toContain('active');
  });

  it('honours the active filters', async () => {
    const departments = (await request(app).get('/api/departments').set('Cookie', cookie)).body
      .departments as DepartmentRow[];
    const sls = departments.find((d) => d.code === 'SLS')!;
    const res = await request(app)
      .get(`/api/employees/export.csv?department=${sls.id}&status=active`)
      .set('Cookie', cookie);
    const lines = (res.text as string).trimEnd().split('\r\n');
    const slsActive = await listEmployees(`?department=${sls.id}&status=active`);
    expect(lines.length).toBe(slsActive.length + 1);
    for (const line of lines.slice(1)) expect(line).toContain('SLS');
  });

  it('quotes cells containing commas and doubles embedded quotes', async () => {
    const emp = await createEmployee({
      name: 'Quote, "Tester"',
      email: 'quote.tester@0815software.example',
    });
    const res = await request(app)
      .get('/api/employees/export.csv?search=quote.tester')
      .set('Cookie', cookie);
    const lines = (res.text as string).trimEnd().split('\r\n');
    expect(lines.length).toBe(2);
    expect(lines[1]).toContain('"Quote, ""Tester"""');
    expect(lines[1]).toContain(emp.email);
  });
});
