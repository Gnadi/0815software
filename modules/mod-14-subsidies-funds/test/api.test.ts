import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { AuthConfig } from '../server/auth.js';
import { fundingCapCents } from '../shared/money.js';
import { obligationState } from '../server/reporting-config.js';
import type { ApplicationDetail, Dashboard, ProgramDetail } from '../shared/types.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

const DAY = 86_400_000;
const T0 = Date.parse('2026-07-20T09:00:00Z');

interface Harness {
  app: Express;
  db: Database.Database;
  cookie: string;
  setNow: (ms: number) => void;
}

/** Build a fresh in-memory app; `withSeed` loads the example dataset. */
async function harness(withSeed = false): Promise<Harness> {
  const db = openDb(':memory:');
  // Seed AT the same instant the clock below is pinned to. The seeded
  // deadlines are offsets from the seed day, so seeding at the real Date.now()
  // while reading at T0 makes the dataset drift as the calendar advances —
  // a "10 days overdue" program stops being overdue once the real date passes
  // T0 + 10 days, and the suite starts failing on a date rather than a commit.
  if (withSeed) seed(db, T0);
  let nowMs = T0;
  const app = createApp({ db, auth, now: () => nowMs });
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  expect(res.status).toBe(200);
  const cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
  return { app, db, cookie, setNow: (ms: number) => (nowMs = ms) };
}

async function makeProgram(
  h: Harness,
  overrides: Record<string, unknown> = {},
): Promise<ProgramDetail> {
  const res = await request(h.app)
    .post('/api/programs')
    .set('Cookie', h.cookie)
    .send({
      name: 'Digital Jetzt',
      funding_body: 'BMWK',
      category: 'digitalisation',
      funding_rate: 50,
      max_grant_cents: 50_000_00,
      status: 'open',
      ...overrides,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as ProgramDetail;
}

async function makeApplication(
  h: Harness,
  programId: number,
  overrides: Record<string, unknown> = {},
): Promise<ApplicationDetail> {
  const res = await request(h.app)
    .post('/api/applications')
    .set('Cookie', h.cookie)
    .send({
      program_id: programId,
      title: 'ERP modernisation',
      eligible_costs_cents: 100_000_00,
      requested_amount_cents: 40_000_00,
      ...overrides,
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as ApplicationDetail;
}

function transition(h: Harness, id: number, payload: Record<string, unknown>): request.Test {
  return request(h.app).post(`/api/applications/${id}/transition`).set('Cookie', h.cookie).send(payload);
}

/** Drive an application all the way to approved with the given grant. */
async function approve(h: Harness, id: number, approvedCents: number): Promise<void> {
  expect((await transition(h, id, { to: 'submitted' })).status).toBe(200);
  expect((await transition(h, id, { to: 'under_review' })).status).toBe(200);
  expect((await transition(h, id, { to: 'approved', approved_amount_cents: approvedCents })).status).toBe(200);
}

// ── Auth ───────────────────────────────────────────────────────────────
describe('auth', () => {
  it('rejects unauthenticated API routes with 401', async () => {
    const h = await harness();
    for (const path of ['/api/config', '/api/programs', '/api/applications', '/api/dashboard', '/api/export/applications.csv']) {
      expect((await request(h.app).get(path)).status, path).toBe(401);
    }
    expect((await request(h.app).post('/api/applications/1/transition').send({ to: 'submitted' })).status).toBe(401);
  });

  it('rejects bad credentials, accepts good ones with an HttpOnly cookie', async () => {
    const h = await harness();
    expect((await request(h.app).post('/api/login').send({ username: 'admin', password: 'nope' })).status).toBe(401);
    const ok = await request(h.app).post('/api/login').send({ username: 'admin', password: 'test-password' });
    expect(ok.status).toBe(200);
    expect(ok.headers['set-cookie']![0]).toContain('mod14_session=');
    expect(ok.headers['set-cookie']![0]).toContain('HttpOnly');
  });
});

// ── Config mirrors the workflow file ──────────────────────────────────
describe('config endpoint', () => {
  it('serves the transitions and category set', async () => {
    const h = await harness();
    const res = await request(h.app).get('/api/config').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.body.transitions.draft).toEqual(['submitted', 'withdrawn']);
    expect(res.body.transitions.under_review).toEqual(['approved', 'rejected', 'withdrawn']);
    expect(res.body.transitions.approved).toEqual([]);
    expect(res.body.at_risk_days).toBe(30);
  });
});

// ── Program CRUD + delete guard ───────────────────────────────────────
describe('funding programs', () => {
  it('creates and lists a program', async () => {
    const h = await harness();
    const p = await makeProgram(h);
    expect(p.category_label).toBe('Digitalisation');
    const list = await request(h.app).get('/api/programs').set('Cookie', h.cookie);
    expect(list.body.programs).toHaveLength(1);
  });

  it('refuses to hard-delete a program that has applications (409)', async () => {
    const h = await harness();
    const p = await makeProgram(h);
    await makeApplication(h, p.id);
    const del = await request(h.app).delete(`/api/programs/${p.id}`).set('Cookie', h.cookie);
    expect(del.status).toBe(409);
    expect(del.body.error).toContain('cannot be deleted');
    // A program with no applications can be deleted.
    const empty = await makeProgram(h, { name: 'Empty program' });
    expect((await request(h.app).delete(`/api/programs/${empty.id}`).set('Cookie', h.cookie)).status).toBe(200);
  });
});

// ── The requested-vs-cap sanity rule ──────────────────────────────────
describe('requested-vs-cap rule', () => {
  it('rejects a requested amount above eligible_costs × funding_rate (422)', async () => {
    const h = await harness();
    const p = await makeProgram(h, { funding_rate: 40 });
    // cap = 100_000_00 × 40% = 40_000_00; ask for one cent more.
    const cap = fundingCapCents(100_000_00, 40);
    const over = await request(h.app)
      .post('/api/applications')
      .set('Cookie', h.cookie)
      .send({ program_id: p.id, title: 'Too much', eligible_costs_cents: 100_000_00, requested_amount_cents: cap + 1 });
    expect(over.status).toBe(422);
    expect(over.body.details[0].field).toBe('requested_amount_cents');
    // Exactly at the cap is allowed.
    const ok = await makeApplication(h, p.id, { requested_amount_cents: cap });
    expect(ok.requested_amount_cents).toBe(cap);
    expect(ok.funding_cap_cents).toBe(cap);
  });
});

// ── Status workflow ───────────────────────────────────────────────────
describe('status workflow', () => {
  it('walks draft → submitted → under_review → approved', async () => {
    const h = await harness();
    const p = await makeProgram(h);
    const a = await makeApplication(h, p.id);
    expect(a.status).toBe('draft');
    await approve(h, a.id, 30_000_00);
    const detail = (await request(h.app).get(`/api/applications/${a.id}`).set('Cookie', h.cookie)).body as ApplicationDetail;
    expect(detail.status).toBe('approved');
    expect(detail.approved_amount_cents).toBe(30_000_00);
  });

  it('rejects an illegal jump draft → approved with 422', async () => {
    const h = await harness();
    const p = await makeProgram(h);
    const a = await makeApplication(h, p.id);
    const res = await transition(h, a.id, { to: 'approved', approved_amount_cents: 10_000_00 });
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('to');
    expect(res.body.details[0].message).toContain('Illegal transition');
  });

  it('keeps the whole append-only timeline through a move sequence', async () => {
    const h = await harness();
    const p = await makeProgram(h);
    const a = await makeApplication(h, p.id);
    await approve(h, a.id, 20_000_00);
    const detail = (await request(h.app).get(`/api/applications/${a.id}`).set('Cookie', h.cookie)).body as ApplicationDetail;
    // created + 3 status_changes = 4 events, oldest first, none mutated.
    expect(detail.events.map((e) => e.to_status)).toEqual(['draft', 'submitted', 'under_review', 'approved']);
    expect(detail.events[0].type).toBe('created');
    expect(detail.events[0].from_status).toBeNull();
    expect(detail.events[3].approved_amount_cents).toBe(20_000_00);
  });
});

// ── approved_amount bounds ────────────────────────────────────────────
describe('approved_amount bounds', () => {
  it('rejects a zero / missing approved amount with 422', async () => {
    const h = await harness();
    const p = await makeProgram(h);
    const a = await makeApplication(h, p.id);
    await transition(h, a.id, { to: 'submitted' });
    await transition(h, a.id, { to: 'under_review' });
    expect((await transition(h, a.id, { to: 'approved', approved_amount_cents: 0 })).status).toBe(422);
    expect((await transition(h, a.id, { to: 'approved' })).status).toBe(422);
    // still under_review (nothing was approved)
    const detail = (await request(h.app).get(`/api/applications/${a.id}`).set('Cookie', h.cookie)).body as ApplicationDetail;
    expect(detail.status).toBe('under_review');
  });

  it('rejects an approved amount above the program max grant with 422', async () => {
    const h = await harness();
    const p = await makeProgram(h, { max_grant_cents: 50_000_00 });
    const a = await makeApplication(h, p.id);
    await transition(h, a.id, { to: 'submitted' });
    await transition(h, a.id, { to: 'under_review' });
    const res = await transition(h, a.id, { to: 'approved', approved_amount_cents: 50_000_00 + 1 });
    expect(res.status).toBe(422);
    expect(res.body.details[0].message).toContain('max grant');
  });
});

// ── Disbursements ─────────────────────────────────────────────────────
describe('disbursements (derived remaining)', () => {
  async function approvedApp(h: Harness, approved = 30_000_00): Promise<number> {
    const p = await makeProgram(h);
    const a = await makeApplication(h, p.id);
    await approve(h, a.id, approved);
    return a.id;
  }

  function tranche(h: Harness, id: number, amount: number): request.Test {
    return request(h.app)
      .post(`/api/applications/${id}/tranches`)
      .set('Cookie', h.cookie)
      .send({ disbursed_on: '2026-07-01', amount_cents: amount });
  }

  it('keeps remaining = approved − SUM(tranches) and detects fully disbursed', async () => {
    const h = await harness();
    const id = await approvedApp(h, 30_000_00);
    let d = (await tranche(h, id, 10_000_00)).body as ApplicationDetail;
    expect(d.disbursed_cents).toBe(10_000_00);
    expect(d.remaining_cents).toBe(20_000_00);
    expect(d.fully_disbursed).toBe(false);
    d = (await tranche(h, id, 20_000_00)).body as ApplicationDetail;
    expect(d.disbursed_cents).toBe(30_000_00);
    expect(d.remaining_cents).toBe(0);
    expect(d.fully_disbursed).toBe(true);
    expect(d.tranches).toHaveLength(2);
  });

  it('rejects an over-disbursement atomically (422, nothing written)', async () => {
    const h = await harness();
    const id = await approvedApp(h, 30_000_00);
    expect((await tranche(h, id, 25_000_00)).status).toBe(200);
    const before = (await request(h.app).get(`/api/applications/${id}`).set('Cookie', h.cookie)).body as ApplicationDetail;
    const over = await tranche(h, id, 10_000_00); // 25k + 10k > 30k
    expect(over.status).toBe(422);
    expect(over.body.details[0].field).toBe('amount_cents');
    const after = (await request(h.app).get(`/api/applications/${id}`).set('Cookie', h.cookie)).body as ApplicationDetail;
    expect(after.disbursed_cents).toBe(before.disbursed_cents); // unchanged
    expect(after.tranches).toHaveLength(1);
  });

  it('refuses a tranche on a non-approved application (409)', async () => {
    const h = await harness();
    const p = await makeProgram(h);
    const a = await makeApplication(h, p.id);
    const res = await tranche(h, a.id, 1_000_00);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('only approved');
  });
});

// ── Reporting obligations — derived via injected clock ────────────────
describe('reporting obligations (injected clock)', () => {
  it('derives overdue vs upcoming from now, in both directions', async () => {
    const h = await harness();
    const p = await makeProgram(h);
    const a = await makeApplication(h, p.id);
    await approve(h, a.id, 20_000_00);
    // due 10 days after T0
    const due = new Date(T0 + 10 * DAY).toISOString().slice(0, 10);
    await request(h.app).post(`/api/applications/${a.id}/obligations`).set('Cookie', h.cookie).send({ title: 'Interim report', due_date: due });

    // now BEFORE the at-risk window → upcoming
    h.setNow(T0 - 40 * DAY);
    let d = (await request(h.app).get(`/api/applications/${a.id}`).set('Cookie', h.cookie)).body as ApplicationDetail;
    expect(d.obligations[0].state).toBe('upcoming');

    // now within 30 days of due → at_risk
    h.setNow(T0);
    d = (await request(h.app).get(`/api/applications/${a.id}`).set('Cookie', h.cookie)).body as ApplicationDetail;
    expect(d.obligations[0].state).toBe('at_risk');

    // now PAST the due day → overdue
    h.setNow(T0 + 20 * DAY);
    d = (await request(h.app).get(`/api/applications/${a.id}`).set('Cookie', h.cookie)).body as ApplicationDetail;
    expect(d.obligations[0].state).toBe('overdue');

    // toggling done wins regardless of the clock
    const obId = d.obligations[0].id;
    const toggled = (await request(h.app).post(`/api/obligations/${obId}/toggle`).set('Cookie', h.cookie)).body as ApplicationDetail;
    expect(toggled.obligations[0].done).toBe(true);
    expect(toggled.obligations[0].done_at).not.toBeNull();
    expect(toggled.obligations[0].state).toBe('done');
  });

  it('pure obligationState agrees at the exact boundaries', async () => {
    const due = '2026-08-01';
    const end = Date.parse('2026-08-01T23:59:59Z');
    expect(obligationState(due, false, end + 1)).toBe('overdue');
    expect(obligationState(due, false, end)).toBe('at_risk');
    expect(obligationState(due, false, end - 30 * DAY)).toBe('at_risk');
    expect(obligationState(due, false, end - 30 * DAY - 1)).toBe('upcoming');
    expect(obligationState(due, true, end + 1)).toBe('done');
  });

  it('refuses an obligation on a non-approved application (409)', async () => {
    const h = await harness();
    const p = await makeProgram(h);
    const a = await makeApplication(h, p.id);
    const res = await request(h.app).post(`/api/applications/${a.id}/obligations`).set('Cookie', h.cookie).send({ title: 'x', due_date: '2026-09-01' });
    expect(res.status).toBe(409);
  });
});

// ── Deadlines dashboard + portfolio ───────────────────────────────────
describe('deadlines dashboard & portfolio totals', () => {
  it('reconciles portfolio totals against a hand-computed fixture', async () => {
    const h = await harness();
    const p = await makeProgram(h, { funding_rate: 50, max_grant_cents: 100_000_00 });

    // App 1: requested 40k, approved 30k, disbursed 10k → remaining 20k
    const a1 = await makeApplication(h, p.id, { requested_amount_cents: 40_000_00 });
    await approve(h, a1.id, 30_000_00);
    await request(h.app).post(`/api/applications/${a1.id}/tranches`).set('Cookie', h.cookie).send({ disbursed_on: '2026-07-01', amount_cents: 10_000_00 });

    // App 2: requested 20k, approved 20k, disbursed 20k → remaining 0
    const a2 = await makeApplication(h, p.id, { requested_amount_cents: 20_000_00 });
    await approve(h, a2.id, 20_000_00);
    await request(h.app).post(`/api/applications/${a2.id}/tranches`).set('Cookie', h.cookie).send({ disbursed_on: '2026-07-01', amount_cents: 20_000_00 });

    // App 3: requested 15k, left as draft (never approved → contributes only to requested)
    await makeApplication(h, p.id, { requested_amount_cents: 15_000_00 });

    const dash = (await request(h.app).get('/api/dashboard').set('Cookie', h.cookie)).body as Dashboard;
    expect(dash.portfolio.requested_cents).toBe(40_000_00 + 20_000_00 + 15_000_00);
    expect(dash.portfolio.approved_cents).toBe(30_000_00 + 20_000_00);
    expect(dash.portfolio.disbursed_cents).toBe(10_000_00 + 20_000_00);
    expect(dash.portfolio.remaining_cents).toBe(50_000_00 - 30_000_00);
    expect(dash.portfolio.counts_by_status.approved).toBe(2);
    expect(dash.portfolio.counts_by_status.draft).toBe(1);
    expect(dash.portfolio.application_count).toBe(3);
    expect(dash.portfolio.program_count).toBe(1);
  });

  it('buckets program deadlines and obligations by overdue/at-risk/upcoming', async () => {
    const h = await harness(true); // seeded dataset
    h.setNow(T0);
    const dash = (await request(h.app).get('/api/dashboard').set('Cookie', h.cookie)).body as Dashboard;
    // seeded closed program is excluded from program deadlines
    expect(dash.program_deadlines.every((d) => d.kind === 'program')).toBe(true);
    // there is at least one overdue obligation and one upcoming program deadline
    const overdue = [...dash.program_deadlines, ...dash.obligation_deadlines].filter((d) => d.state === 'overdue');
    const upcoming = dash.program_deadlines.filter((d) => d.state === 'upcoming');
    expect(overdue.length).toBeGreaterThan(0);
    expect(upcoming.length).toBeGreaterThan(0);
    expect(dash.totals.overdue).toBeGreaterThan(0);
  });
});

// ── CSV export ────────────────────────────────────────────────────────
describe('CSV export', () => {
  it('emits a valid header and a row per application with derived columns', async () => {
    const h = await harness();
    const p = await makeProgram(h);
    const a = await makeApplication(h, p.id, { requested_amount_cents: 30_000_00 });
    await approve(h, a.id, 25_000_00);
    await request(h.app).post(`/api/applications/${a.id}/tranches`).set('Cookie', h.cookie).send({ disbursed_on: '2026-07-01', amount_cents: 5_000_00 });

    const res = await request(h.app).get('/api/export/applications.csv').set('Cookie', h.cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.trimEnd().split('\r\n');
    expect(lines[0]).toContain('ref,program,funding_body,title,status');
    expect(lines[0]).toContain('approved_amount_cents,disbursed_cents,remaining_cents');
    expect(lines).toHaveLength(2); // header + one application
    const cells = lines[1].split(',');
    expect(cells).toContain('approved'); // status
    // approved 2500000, disbursed 500000, remaining 2000000 (cents)
    expect(cells).toContain('2500000');
    expect(cells).toContain('500000');
    expect(cells).toContain('2000000');
  });
});
