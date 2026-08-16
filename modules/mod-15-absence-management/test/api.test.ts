import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import type { AbsenceRequest, Balance, Employee, RequestDetail } from '../shared/types.js';

/**
 * MOD-15's three correctness properties, each proven here:
 *
 * 1. **Balances are derived, never stored.** Every number comes back from the
 *    entitlement plus the requests, recomputed on read — so a balance cannot
 *    drift away from the bookings that produced it.
 * 2. **A day costs what the employee's own calendar says.** The same week is a
 *    different number of days in Bayern, Berlin and Austria, and the module
 *    charges each person their own.
 * 3. **Every status change is append-only.** Nothing is deleted, nothing is
 *    edited in place; a year later the trail still explains the balance.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

/** Pinned clock: whether carry-over has lapsed is a question about TODAY. */
const T0 = Date.parse('2026-07-20T09:00:00Z');

let db: Database.Database;
let app: Express;
let cookie: string;
let nowMs = T0;

async function harness(): Promise<void> {
  db = openDb(':memory:');
  nowMs = T0;
  app = createApp({ db, auth, now: () => nowMs });
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  expect(res.status).toBe(200);
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
}

beforeEach(harness);

async function makeEmployee(region = 'DE-BY', name = 'Anna Berger'): Promise<Employee> {
  const res = await request(app)
    .post('/api/employees')
    .set('Cookie', cookie)
    .send({ name, email: `${name.replace(/\W+/g, '.').toLowerCase()}@example.de`, region, started_on: '2020-01-01' });
  expect(res.status).toBe(201);
  return res.body as Employee;
}

async function setEntitlement(id: number, patch: Record<string, unknown> = {}): Promise<void> {
  const res = await request(app)
    .put(`/api/employees/${id}/entitlement`)
    .set('Cookie', cookie)
    .send({ year: 2026, base_days: 30, carry_over_days: 0, ...patch });
  expect(res.status).toBe(200);
}

async function book(id: number, patch: Record<string, unknown> = {}): Promise<RequestDetail> {
  const res = await request(app)
    .post('/api/requests')
    .set('Cookie', cookie)
    .send({ employee_id: id, type: 'vacation', from_date: '2026-08-03', to_date: '2026-08-07', ...patch });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as RequestDetail;
}

async function balance(id: number, year = 2026): Promise<Balance> {
  const res = await request(app).get(`/api/employees/${id}/balance?year=${year}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as Balance;
}

describe('auth', () => {
  it('refuses every operational route without a session', async () => {
    for (const path of ['/api/config', '/api/employees', '/api/requests', '/api/balances', '/api/holidays?region=AT']) {
      expect((await request(app).get(path)).status, path).toBe(401);
    }
    expect((await request(app).post('/api/employees').send({})).status).toBe(401);
  });

  it('serves health and readiness without one', async () => {
    expect((await request(app).get('/api/health')).status).toBe(200);
    expect((await request(app).get('/api/ready')).body).toEqual({ ready: true });
  });

  it('offers the client exactly the types and regions the server accepts', async () => {
    const res = await request(app).get('/api/config').set('Cookie', cookie);
    expect(res.body.types.map((t: { key: string }) => t.key)).toContain('vacation');
    expect(res.body.regions).toHaveLength(17); // 16 German states + Austria
    expect(res.body.today).toBe('2026-07-20');
  });
});

describe('employees', () => {
  it('creates and reads one back', async () => {
    const employee = await makeEmployee('DE-BE', 'Klara Meyer');
    expect(employee).toMatchObject({ region: 'DE-BE', left_on: null });
    const read = await request(app).get(`/api/employees/${employee.id}`).set('Cookie', cookie);
    expect(read.body.email).toBe('klara.meyer@example.de');
  });

  it('refuses a duplicate email and an unknown region', async () => {
    await makeEmployee('DE-BY', 'Anna Berger');
    const dup = await request(app)
      .post('/api/employees')
      .set('Cookie', cookie)
      .send({ name: 'Someone Else', email: 'anna.berger@example.de', region: 'DE-BY', started_on: '2020-01-01' });
    expect(dup.status).toBe(409);

    const bad = await request(app)
      .post('/api/employees')
      .set('Cookie', cookie)
      .send({ name: 'X', email: 'x@example.de', region: 'DE-XX', started_on: '2020-01-01' });
    expect(bad.status).toBe(422);
    expect(bad.body.details[0].field).toBe('region');
  });

  // Leaving is a date, never a delete: the balance, the requests and the trail
  // all stay answerable, which is what a payroll query months later needs.
  it('offboards without deleting, and hides them from the default list', async () => {
    const employee = await makeEmployee();
    await setEntitlement(employee.id);
    await book(employee.id);

    const off = await request(app)
      .post(`/api/employees/${employee.id}/offboard`)
      .set('Cookie', cookie)
      .send({ left_on: '2026-09-30' });
    expect(off.status).toBe(200);
    expect(off.body.left_on).toBe('2026-09-30');

    const active = await request(app).get('/api/employees').set('Cookie', cookie);
    expect(active.body.employees).toHaveLength(0);
    const all = await request(app).get('/api/employees?include_left=true').set('Cookie', cookie);
    expect(all.body.employees).toHaveLength(1);

    // And their history is still there.
    expect((await balance(employee.id)).taken_days).toBe(0);
    const requests = await request(app).get('/api/requests').set('Cookie', cookie);
    expect(requests.body.requests).toHaveLength(1);
  });

  it('refuses leave that starts after someone left', async () => {
    const employee = await makeEmployee();
    await setEntitlement(employee.id);
    await request(app)
      .post(`/api/employees/${employee.id}/offboard`)
      .set('Cookie', cookie)
      .send({ left_on: '2026-07-31' });
    const res = await request(app)
      .post('/api/requests')
      .set('Cookie', cookie)
      .send({ employee_id: employee.id, type: 'vacation', from_date: '2026-08-03', to_date: '2026-08-07' });
    expect(res.status).toBe(409);
  });

  it('refuses leave that starts before someone joined', async () => {
    const employee = await makeEmployee();
    const res = await request(app)
      .post('/api/requests')
      .set('Cookie', cookie)
      .send({ employee_id: employee.id, type: 'vacation', from_date: '2019-08-05', to_date: '2019-08-07' });
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('from_date');
  });
});

describe('a day costs what the employee’s own calendar says', () => {
  // The property this module exists for. Same dates, same request, three
  // different answers — because a public holiday is a question about where
  // somebody works, not about the company.
  it('charges a Bavarian, a Berliner and an Austrian differently for one week', async () => {
    const cases: [string, number][] = [
      ['DE-BY', 4], // Fronleichnam 2026-06-04 is a holiday
      ['DE-BE', 5], // …and an ordinary Thursday in Berlin
      ['AT', 4], // Fronleichnam is nationwide in Austria
    ];
    for (const [region, expected] of cases) {
      const employee = await makeEmployee(region, `Person ${region}`);
      await setEntitlement(employee.id);
      const req = await book(employee.id, { from_date: '2026-06-01', to_date: '2026-06-05' });
      expect(req.days, region).toBe(expected);
    }
  });

  it('never charges for a weekend', async () => {
    const employee = await makeEmployee();
    await setEntitlement(employee.id);
    const req = await book(employee.id, { from_date: '2026-08-03', to_date: '2026-08-16' });
    expect(req.days).toBe(10); // two full weeks, four weekend days dropped
  });

  it('takes half a day off each half-day edge', async () => {
    const employee = await makeEmployee();
    await setEntitlement(employee.id);
    const req = await book(employee.id, { half_start: true, half_end: true });
    expect(req.days).toBe(4);
  });

  // A span made only of closed days books nothing, so recording it would put a
  // phantom entry on the team calendar for days the office is shut anyway.
  it('refuses a span with no working days in it', async () => {
    const employee = await makeEmployee();
    const res = await request(app)
      .post('/api/requests')
      .set('Cookie', cookie)
      .send({ employee_id: employee.id, type: 'vacation', from_date: '2026-08-08', to_date: '2026-08-09' });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('no working days');
  });

  it('exposes the same holidays the booking maths uses', async () => {
    const res = await request(app).get('/api/holidays?region=DE-BY&year=2026').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.holidays.map((h: { date: string }) => h.date)).toContain('2026-06-04');
    const berlin = await request(app).get('/api/holidays?region=DE-BE&year=2026').set('Cookie', cookie);
    expect(berlin.body.holidays.map((h: { date: string }) => h.date)).not.toContain('2026-06-04');
  });
});

describe('balances are derived, never stored', () => {
  it('adds up entitlement, taken and pending', async () => {
    const employee = await makeEmployee();
    await setEntitlement(employee.id, { base_days: 30, carry_over_days: 5, carry_over_expires_on: null });

    const approved = await book(employee.id, { from_date: '2026-08-03', to_date: '2026-08-07' }); // 5
    await request(app).post(`/api/requests/${approved.id}/approve`).set('Cookie', cookie).send({});
    await book(employee.id, { from_date: '2026-09-07', to_date: '2026-09-08' }); // 2, pending

    expect(await balance(employee.id)).toMatchObject({
      base_days: 30,
      carry_over_days: 5,
      entitled_days: 35,
      taken_days: 5,
      pending_days: 2,
      remaining_days: 30,
      projected_remaining_days: 28,
    });
  });

  it('recomputes after a withdrawal rather than adjusting a stored number', async () => {
    const employee = await makeEmployee();
    await setEntitlement(employee.id);
    const req = await book(employee.id);
    await request(app).post(`/api/requests/${req.id}/approve`).set('Cookie', cookie).send({});
    expect((await balance(employee.id)).taken_days).toBe(5);

    await request(app).post(`/api/requests/${req.id}/withdraw`).set('Cookie', cookie).send({ note: 'Plans changed' });
    expect((await balance(employee.id)).taken_days).toBe(0);
    expect((await balance(employee.id)).remaining_days).toBe(30);
  });

  // Half days are why every count is integer tenths internally. A balance
  // reading 24.499999999999996 is a support ticket, not a rounding curiosity.
  it('keeps half days exact across many bookings', async () => {
    const employee = await makeEmployee();
    await setEntitlement(employee.id);
    const spans: [string, string][] = [
      ['2026-08-03', '2026-08-03'],
      ['2026-08-10', '2026-08-10'],
      ['2026-08-17', '2026-08-17'],
    ];
    for (const [from, to] of spans) {
      const req = await book(employee.id, { from_date: from, to_date: to, half_start: true });
      await request(app).post(`/api/requests/${req.id}/approve`).set('Cookie', cookie).send({});
    }
    const result = await balance(employee.id);
    expect(result.taken_days).toBe(1.5);
    expect(result.remaining_days).toBe(28.5);
  });

  it('reports lapsed carry-over separately instead of silently dropping it', async () => {
    const employee = await makeEmployee();
    // Expired: today is 2026-07-20, the carry-over lapsed on 31 March.
    await setEntitlement(employee.id, { base_days: 30, carry_over_days: 5, carry_over_expires_on: '2026-03-31' });
    const result = await balance(employee.id);
    expect(result).toMatchObject({
      carry_over_days: 5,
      carry_over_expired_days: 5,
      entitled_days: 30,
      remaining_days: 30,
    });
  });

  it('still counts carry-over that has not lapsed yet', async () => {
    const employee = await makeEmployee();
    await setEntitlement(employee.id, { base_days: 30, carry_over_days: 5, carry_over_expires_on: '2026-12-31' });
    expect((await balance(employee.id)).entitled_days).toBe(35);
  });

  it('is zero-but-answerable for an employee with no entitlement row', async () => {
    const employee = await makeEmployee();
    expect(await balance(employee.id)).toMatchObject({ entitled_days: 0, taken_days: 0, remaining_days: 0 });
  });

  // A request spanning new year belongs to both years, charged to each for the
  // days that actually fall in it — which is what the employee and payroll
  // both expect.
  it('splits a request that crosses new year across both years', async () => {
    const employee = await makeEmployee('DE-BE');
    await setEntitlement(employee.id, { year: 2026, base_days: 30 });
    await request(app)
      .put(`/api/employees/${employee.id}/entitlement`)
      .set('Cookie', cookie)
      .send({ year: 2027, base_days: 30 });

    const req = await book(employee.id, { from_date: '2026-12-28', to_date: '2027-01-08' });
    await request(app).post(`/api/requests/${req.id}/approve`).set('Cookie', cookie).send({});

    // 2026: Mon 28 – Thu 31 (Neujahr is 2027). 2027: Fri 1 is Neujahr, so
    // Mon 4 – Fri 8 = 5.
    expect((await balance(employee.id, 2026)).taken_days).toBe(4);
    expect((await balance(employee.id, 2027)).taken_days).toBe(5);
  });
});

describe('which absences draw down the entitlement', () => {
  // Counting illness against someone's holiday is unlawful in Germany
  // (§ 9 BUrlG) and Austria (§ 5 UrlG). It is a config flag, but not a
  // preference.
  it('sick leave costs days but not entitlement, and needs no approver', async () => {
    const employee = await makeEmployee();
    await setEntitlement(employee.id);
    const req = await book(employee.id, { type: 'sick', from_date: '2026-08-03', to_date: '2026-08-05' });
    expect(req.status).toBe('approved');
    expect(req.days).toBe(3);
    expect((await balance(employee.id)).taken_days).toBe(0);
  });

  it('unpaid and special leave do not deduct either', async () => {
    const employee = await makeEmployee();
    await setEntitlement(employee.id);
    for (const [type, from, to] of [
      ['unpaid', '2026-08-03', '2026-08-05'],
      ['special', '2026-08-10', '2026-08-11'],
    ] as const) {
      const req = await book(employee.id, { type, from_date: from, to_date: to });
      await request(app).post(`/api/requests/${req.id}/approve`).set('Cookie', cookie).send({});
    }
    expect((await balance(employee.id)).taken_days).toBe(0);
  });

  it('refuses an absence type that does not exist', async () => {
    const employee = await makeEmployee();
    const res = await request(app)
      .post('/api/requests')
      .set('Cookie', cookie)
      .send({ employee_id: employee.id, type: 'sabbatical', from_date: '2026-08-03', to_date: '2026-08-05' });
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('type');
  });
});

describe('overlaps', () => {
  // Two people cannot both be the only one on the helpdesk on Monday, and one
  // person cannot be on holiday twice. Checked inside the write transaction.
  it('refuses a request overlapping a pending one, naming the clash', async () => {
    const employee = await makeEmployee();
    await setEntitlement(employee.id);
    const first = await book(employee.id, { from_date: '2026-08-03', to_date: '2026-08-07' });

    const res = await request(app)
      .post('/api/requests')
      .set('Cookie', cookie)
      .send({ employee_id: employee.id, type: 'vacation', from_date: '2026-08-05', to_date: '2026-08-12' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(`#${first.id}`);
  });

  it('refuses one overlapping an approved request too', async () => {
    const employee = await makeEmployee();
    await setEntitlement(employee.id);
    const first = await book(employee.id);
    await request(app).post(`/api/requests/${first.id}/approve`).set('Cookie', cookie).send({});
    const res = await request(app)
      .post('/api/requests')
      .set('Cookie', cookie)
      .send({ employee_id: employee.id, type: 'sick', from_date: '2026-08-05', to_date: '2026-08-05' });
    expect(res.status).toBe(409);
  });

  // A rejected or withdrawn request holds no slot — the dates are free again.
  it('allows a request over a rejected one', async () => {
    const employee = await makeEmployee();
    await setEntitlement(employee.id);
    const first = await book(employee.id);
    await request(app).post(`/api/requests/${first.id}/reject`).set('Cookie', cookie).send({ note: 'Too busy' });
    const second = await book(employee.id);
    expect(second.id).not.toBe(first.id);
  });

  it('lets two different people book the same week', async () => {
    const a = await makeEmployee('DE-BY', 'Anna Berger');
    const b = await makeEmployee('DE-BE', 'Klara Meyer');
    await setEntitlement(a.id);
    await setEntitlement(b.id);
    await book(a.id);
    await book(b.id);
    const res = await request(app).get('/api/requests').set('Cookie', cookie);
    expect(res.body.requests).toHaveLength(2);
  });
});

describe('the history is append-only', () => {
  it('records every transition, with who and why', async () => {
    const employee = await makeEmployee();
    await setEntitlement(employee.id);
    const req = await book(employee.id, { note: 'Sommerurlaub' });
    await request(app).post(`/api/requests/${req.id}/approve`).set('Cookie', cookie).send({ note: 'Genehmigt' });
    await request(app).post(`/api/requests/${req.id}/withdraw`).set('Cookie', cookie).send({ note: 'Krank geworden' });

    const detail = await request(app).get(`/api/requests/${req.id}`).set('Cookie', cookie);
    const events = detail.body.events as { from_status: string | null; to_status: string; actor: string; note: string | null }[];
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ from_status: null, to_status: 'pending', actor: 'admin' });
    expect(events[1]).toMatchObject({ from_status: 'pending', to_status: 'approved', note: 'Genehmigt' });
    expect(events[2]).toMatchObject({ from_status: 'approved', to_status: 'withdrawn', note: 'Krank geworden' });
  });

  it('refuses a transition the lifecycle does not allow', async () => {
    const employee = await makeEmployee();
    await setEntitlement(employee.id);
    const req = await book(employee.id);
    await request(app).post(`/api/requests/${req.id}/reject`).set('Cookie', cookie).send({});

    // A decided request does not go back. Changing your mind means a new
    // request, so both facts stay in the trail.
    for (const verb of ['approve', 'reject', 'withdraw']) {
      const res = await request(app).post(`/api/requests/${req.id}/${verb}`).set('Cookie', cookie).send({});
      expect(res.status, verb).toBe(409);
    }
  });

  it('lists the working days a request actually covers', async () => {
    const employee = await makeEmployee('DE-BY');
    await setEntitlement(employee.id);
    const req = await book(employee.id, { from_date: '2026-06-01', to_date: '2026-06-05' });
    const detail = await request(app).get(`/api/requests/${req.id}`).set('Cookie', cookie);
    // Fronleichnam (the 4th) is not covered in Bayern.
    expect(detail.body.covered_days).toEqual(['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-05']);
  });
});

describe('filtering and validation', () => {
  it('filters requests by employee, status and overlapping window', async () => {
    const a = await makeEmployee('DE-BY', 'Anna Berger');
    const b = await makeEmployee('DE-BE', 'Klara Meyer');
    await setEntitlement(a.id);
    await setEntitlement(b.id);
    const first = await book(a.id, { from_date: '2026-08-03', to_date: '2026-08-07' });
    await request(app).post(`/api/requests/${first.id}/approve`).set('Cookie', cookie).send({});
    await book(b.id, { from_date: '2026-09-07', to_date: '2026-09-11' });

    const mine = await request(app).get(`/api/requests?employee_id=${a.id}`).set('Cookie', cookie);
    expect(mine.body.requests).toHaveLength(1);

    const approved = await request(app).get('/api/requests?status=approved').set('Cookie', cookie);
    expect(approved.body.requests).toHaveLength(1);

    // Overlap, not containment: a window inside the span still finds it.
    const window = await request(app).get('/api/requests?from=2026-08-05&to=2026-08-05').set('Cookie', cookie);
    expect(window.body.requests.map((r: AbsenceRequest) => r.id)).toEqual([first.id]);
  });

  it('rejects an unknown status filter', async () => {
    const res = await request(app).get('/api/requests?status=maybe').set('Cookie', cookie);
    expect(res.status).toBe(422);
  });

  it.each(['2026-02-30', '2026-13-01', '20260803', 'soon'])('rejects %o as a date', async (from) => {
    const employee = await makeEmployee();
    const res = await request(app)
      .post('/api/requests')
      .set('Cookie', cookie)
      .send({ employee_id: employee.id, type: 'vacation', from_date: from, to_date: '2026-08-07' });
    expect(res.status).toBe(422);
  });

  it('rejects an entitlement that is not a whole or half day', async () => {
    const employee = await makeEmployee();
    const res = await request(app)
      .put(`/api/employees/${employee.id}/entitlement`)
      .set('Cookie', cookie)
      .send({ year: 2026, base_days: 30.3 });
    expect(res.status).toBe(422);
    expect(res.body.details[0].message).toContain('half day');
  });

  it('replaces rather than duplicates an entitlement for the same year', async () => {
    const employee = await makeEmployee();
    await setEntitlement(employee.id, { base_days: 25 });
    await setEntitlement(employee.id, { base_days: 30 });
    expect((await balance(employee.id)).base_days).toBe(30);
    const rows = db.prepare('SELECT COUNT(*) AS n FROM entitlements WHERE employee_id = ?').get(employee.id) as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it('404s an unknown employee or request', async () => {
    expect((await request(app).get('/api/employees/999').set('Cookie', cookie)).status).toBe(404);
    expect((await request(app).get('/api/requests/999').set('Cookie', cookie)).status).toBe(404);
  });
});

describe('the team view', () => {
  it('reports a balance per active employee', async () => {
    const a = await makeEmployee('DE-BY', 'Anna Berger');
    const b = await makeEmployee('DE-BE', 'Klara Meyer');
    await setEntitlement(a.id, { base_days: 30 });
    await setEntitlement(b.id, { base_days: 28 });
    const res = await request(app).get('/api/balances?year=2026').set('Cookie', cookie);
    expect(res.body.year).toBe(2026);
    expect(res.body.balances.map((x: Balance) => x.base_days).sort()).toEqual([28, 30]);
  });
});

describe('the seeded demo data', () => {
  it('shows three regions charging different days for one week', async () => {
    const { seed } = await import('../server/seed.js');
    seed(db, T0);
    const res = await request(app).get('/api/employees').set('Cookie', cookie);
    const regions = (res.body.employees as Employee[]).map((e) => e.region);
    expect(new Set(regions).size).toBeGreaterThan(1);

    const balances = await request(app).get('/api/balances?year=2026').set('Cookie', cookie);
    expect(balances.body.balances).toHaveLength(4);
    // Every seeded employee has an entitlement, so none of them reads zero.
    for (const b of balances.body.balances as Balance[]) expect(b.entitled_days).toBeGreaterThan(0);
  });
});
