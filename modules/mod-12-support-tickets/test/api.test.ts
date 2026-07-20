import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { AuthConfig } from '../server/auth.js';
import { lookupToken } from '../server/auth.js';
import { evaluateSla, SLA_POLICIES, AT_RISK_MINUTES } from '../server/sla-config.js';
import { canTransition } from '../server/status-config.js';
import type { PublicTicket, TicketDetail } from '../shared/types.js';
import { PRIORITIES } from '../shared/types.js';

const auth: AuthConfig = {
  username: 'agent',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
  intakeSecret: 'test-intake-secret',
};

const MINUTE = 60_000;
const T0 = Date.parse('2026-07-19T09:00:00Z');

let db: Database.Database;
let app: Express;
let cookie: string;
let nowMs: number;

/** Advance the injected clock to `minutes` past T0. */
function at(minutes: number): void {
  nowMs = T0 + minutes * MINUTE;
}

async function login(): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'agent', password: 'test-password' });
  expect(res.status).toBe(200);
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

/** Open a ticket through the public web intake; returns { ref, token }. */
async function submitWeb(priority = 'normal', subject = 'Something is broken'): Promise<{ ref: string; token: string }> {
  const res = await request(app).post('/api/intake/web').send({
    requester_name: 'Test Requester',
    requester_email: 'requester@example.com',
    subject,
    body: 'Details of the problem go here.',
    priority,
  });
  expect(res.status).toBe(201);
  return { ref: res.body.ref as string, token: res.body.token as string };
}

async function detail(ref: string): Promise<TicketDetail> {
  const res = await request(app).get(`/api/tickets/${ref}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body as TicketDetail;
}

async function setStatus(ref: string, to: string): Promise<request.Response> {
  return request(app).post(`/api/tickets/${ref}/status`).set('Cookie', cookie).send({ to });
}

beforeAll(async () => {
  db = openDb(':memory:');
  seed(db);
  nowMs = T0;
  app = createApp({ db, auth, now: () => nowMs });
  cookie = await login();
});

beforeEach(() => {
  nowMs = T0;
});

// ── Auth ─────────────────────────────────────────────────────────────
describe('agent auth', () => {
  it('rejects unauthenticated agent routes with 401', async () => {
    for (const path of ['/api/config', '/api/agents', '/api/dashboard', '/api/tickets', '/api/tickets/TKT-2026-0001']) {
      expect((await request(app).get(path)).status, path).toBe(401);
    }
    expect((await request(app).post('/api/tickets/TKT-2026-0001/status').send({ to: 'open' })).status).toBe(401);
  });

  it('rejects bad credentials, accepts good ones with an HttpOnly cookie', async () => {
    expect((await request(app).post('/api/login').send({ username: 'agent', password: 'nope' })).status).toBe(401);
    const ok = await request(app).post('/api/login').send({ username: 'agent', password: 'test-password' });
    expect(ok.status).toBe(200);
    expect(ok.headers['set-cookie']![0]).toContain('mod12_session=');
    expect(ok.headers['set-cookie']![0]).toContain('HttpOnly');
  });
});

// ── Config mirrors the two config files ──────────────────────────────
describe('config endpoint', () => {
  it('serves the workflow transitions and the SLA policy', async () => {
    const res = await request(app).get('/api/config').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.transitions.new).toEqual(['open', 'pending', 'resolved']);
    expect(res.body.transitions.closed).toEqual(['open']);
    expect(res.body.sla.urgent).toEqual({ first_response_minutes: 30, resolution_minutes: 240 });
    expect(res.body.at_risk_minutes).toBe(AT_RISK_MINUTES);
  });
});

// ── Status workflow ──────────────────────────────────────────────────
describe('status workflow', () => {
  it('walks the legal path new → open → pending → resolved → closed', async () => {
    const { ref } = await submitWeb();
    expect((await detail(ref)).status).toBe('new');
    for (const to of ['open', 'pending', 'resolved', 'closed']) {
      expect((await setStatus(ref, to)).status, to).toBe(200);
    }
    expect((await detail(ref)).status).toBe('closed');
  });

  it('rejects an illegal transition with 422', async () => {
    const { ref } = await submitWeb();
    const res = await setStatus(ref, 'closed'); // new → closed is not allowed
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('to');
    expect(res.body.details[0].message).toContain('Illegal transition');
  });

  it('rejects transitioning to the current status with 422', async () => {
    const { ref } = await submitWeb();
    await setStatus(ref, 'open');
    const res = await setStatus(ref, 'open');
    expect(res.status).toBe(422);
    expect(res.body.details[0].message).toContain('already');
  });

  it('rejects an unknown status value with 422', async () => {
    const { ref } = await submitWeb();
    expect((await setStatus(ref, 'banana')).status).toBe(422);
  });
});

// ── Append-only timeline (never mutated) ─────────────────────────────
describe('append-only timeline', () => {
  it('retains every event including full assignment history', async () => {
    const { ref } = await submitWeb();
    at(2);
    expect((await request(app).post(`/api/tickets/${ref}/assign`).set('Cookie', cookie).send({ assignee_id: 1 })).status).toBe(200);
    at(4);
    expect((await setStatus(ref, 'open')).status).toBe(200);
    at(6);
    expect((await request(app).post(`/api/tickets/${ref}/comment`).set('Cookie', cookie).send({ body: 'internal thoughts', visibility: 'internal' })).status).toBe(200);
    at(8);
    expect((await request(app).post(`/api/tickets/${ref}/assign`).set('Cookie', cookie).send({ assignee_id: 2 })).status).toBe(200);
    at(10);
    expect((await request(app).post(`/api/tickets/${ref}/priority`).set('Cookie', cookie).send({ priority: 'high' })).status).toBe(200);

    const d = await detail(ref);
    // created + assign + status + comment + assign + priority = 6 events, in order.
    expect(d.events.map((e) => e.type)).toEqual([
      'created',
      'assignment',
      'status_change',
      'comment',
      'assignment',
      'priority_change',
    ]);
    // Both assignment rows survive; the first is not overwritten by the second.
    const assignments = d.events.filter((e) => e.type === 'assignment');
    expect(assignments).toHaveLength(2);
    expect(assignments[0]!.payload.assignee_id).toBe(1);
    expect(assignments[1]!.payload.assignee_id).toBe(2);
    expect(d.assignee_id).toBe(2); // current = latest

    // The raw event count only ever grows — nothing is deleted.
    const ticketId = (db.prepare('SELECT id FROM tickets WHERE ref = ?').get(ref) as { id: number }).id;
    const count = (db.prepare('SELECT COUNT(*) AS n FROM ticket_events WHERE ticket_id = ?').get(ticketId) as { n: number }).n;
    expect(count).toBe(6);

    // Making another change never mutates an earlier row's timestamp/payload.
    const firstAssignBefore = JSON.stringify(d.events[1]);
    at(12);
    await setStatus(ref, 'pending');
    const d2 = await detail(ref);
    expect(JSON.stringify(d2.events[1])).toBe(firstAssignBefore);
    expect(d2.events).toHaveLength(7);
  });
});

// ── SLA — pure boundary proofs against fixed inputs ──────────────────
describe('SLA breach is derived from fixed clock inputs', () => {
  const createdMs = T0;

  for (const priority of PRIORITIES) {
    const p = SLA_POLICIES[priority];

    it(`${priority}: first response met vs breached at the boundary`, () => {
      const frDueMs = createdMs + p.firstResponseMinutes * MINUTE;
      // Replied one minute BEFORE due → met.
      const met = evaluateSla({ createdMs, priority, firstResponseMs: frDueMs - MINUTE, resolvedMs: null, nowMs: frDueMs + MINUTE });
      expect(met.first_response.state).toBe('met');
      expect(met.first_response.breached).toBe(false);
      // Replied one minute AFTER due → breached (late).
      const late = evaluateSla({ createdMs, priority, firstResponseMs: frDueMs + MINUTE, resolvedMs: null, nowMs: frDueMs + 2 * MINUTE });
      expect(late.first_response.state).toBe('breached');
      // No reply, now past due → breached (open).
      const open = evaluateSla({ createdMs, priority, firstResponseMs: null, resolvedMs: null, nowMs: frDueMs + MINUTE });
      expect(open.first_response.breached).toBe(true);
      // No reply, before due → pending.
      const early = evaluateSla({ createdMs, priority, firstResponseMs: null, resolvedMs: null, nowMs: frDueMs - AT_RISK_MINUTES * MINUTE - MINUTE });
      expect(early.first_response.state).toBe('pending');
    });

    it(`${priority}: resolution met vs breached at the boundary`, () => {
      const resDueMs = createdMs + p.resolutionMinutes * MINUTE;
      const met = evaluateSla({ createdMs, priority, firstResponseMs: createdMs, resolvedMs: resDueMs - MINUTE, nowMs: resDueMs });
      expect(met.resolution.state).toBe('met');
      const late = evaluateSla({ createdMs, priority, firstResponseMs: createdMs, resolvedMs: resDueMs + MINUTE, nowMs: resDueMs + 2 * MINUTE });
      expect(late.resolution.state).toBe('breached');
      const openBreach = evaluateSla({ createdMs, priority, firstResponseMs: createdMs, resolvedMs: null, nowMs: resDueMs + MINUTE });
      expect(openBreach.resolution.breached).toBe(true);
    });

    it(`${priority}: at-risk window is entered exactly ${AT_RISK_MINUTES}m before due`, () => {
      const frDueMs = createdMs + p.firstResponseMinutes * MINUTE;
      const atRisk = evaluateSla({ createdMs, priority, firstResponseMs: null, resolvedMs: null, nowMs: frDueMs - AT_RISK_MINUTES * MINUTE });
      expect(atRisk.first_response.state).toBe('at_risk');
    });
  }

  it('applies the CURRENT priority policy after a priority change (via the API + injected clock)', async () => {
    at(0);
    const { ref } = await submitWeb('low'); // low FR target = 480m
    // 90 minutes in: comfortably within the low target, no breach.
    at(90);
    expect((await detail(ref)).sla.first_response.breached).toBe(false);
    // Escalate to urgent (FR target = 30m). Now 90m > 30m with no reply → breached.
    at(91);
    expect((await request(app).post(`/api/tickets/${ref}/priority`).set('Cookie', cookie).send({ priority: 'urgent' })).status).toBe(200);
    at(92);
    expect((await detail(ref)).sla.first_response.breached).toBe(true);
  });

  it('a public agent reply stops the first-response clock (met), an internal note does not', async () => {
    at(0);
    const { ref } = await submitWeb('urgent'); // 30m FR target
    at(10);
    // Internal note first — must NOT count as a first response.
    await request(app).post(`/api/tickets/${ref}/comment`).set('Cookie', cookie).send({ body: 'looking', visibility: 'internal' });
    at(40); // past the 30m target, still no PUBLIC reply
    expect((await detail(ref)).sla.first_response.breached).toBe(true);

    at(0);
    const fresh = await submitWeb('urgent');
    at(10); // public reply within 30m
    await request(app).post(`/api/tickets/${fresh.ref}/comment`).set('Cookie', cookie).send({ body: 'on it', visibility: 'public' });
    at(40);
    const d = await detail(fresh.ref);
    expect(d.sla.first_response.state).toBe('met');
    expect(d.first_response_at).toBeTruthy();
  });
});

// ── SLA dashboard ────────────────────────────────────────────────────
describe('SLA dashboard', () => {
  it('derives breached / at-risk counts by priority (from the seed)', async () => {
    const res = await request(app).get('/api/dashboard').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.totals.breached).toBeGreaterThan(0);
    expect(res.body.totals.open).toBeGreaterThan(0);
    const urgent = res.body.by_priority.find((b: { priority: string }) => b.priority === 'urgent');
    expect(urgent.breached).toBeGreaterThan(0);
  });
});

// ── Reopen via requester follow-up ───────────────────────────────────
describe('requester follow-up reopens a resolved ticket', () => {
  it('appends the comment and a reopened status_change back to open', async () => {
    at(0);
    const { ref, token } = await submitWeb();
    at(5);
    await setStatus(ref, 'open');
    at(10);
    await setStatus(ref, 'resolved');
    expect((await detail(ref)).status).toBe('resolved');

    at(20);
    const res = await request(app)
      .post(`/api/public/tickets/${ref}/comment`)
      .query({ token })
      .send({ body: 'This is still happening, please look again.' });
    expect(res.status).toBe(200);

    const d = await detail(ref);
    expect(d.status).toBe('open');
    const last = d.events[d.events.length - 1]!;
    expect(last.type).toBe('status_change');
    expect(last.payload.reopened).toBe(true);
    // The resolution timestamp is the FIRST time it entered resolved and survives the reopen.
    expect(d.resolved_at).toBeTruthy();
  });
});

// ── Email intake ─────────────────────────────────────────────────────
describe('email intake', () => {
  function email(payload: Record<string, unknown>, secret?: string): request.Test {
    const req = request(app).post('/api/intake/email');
    if (secret !== undefined) req.set('X-Intake-Secret', secret);
    return req.send(payload);
  }

  it('requires the shared secret: 401 without it, 403 with a wrong one', async () => {
    const payload = { from: 'a@example.com', subject: 'Help', body: 'Please help' };
    expect((await email(payload)).status).toBe(401);
    expect((await email(payload, 'wrong-secret')).status).toBe(403);
  });

  it('opens a new ticket, then appends to it when in_reply_to matches an open ticket', async () => {
    const opened = await email({ from: 'wanda@example.com', subject: 'Sync failing', body: 'Nightly sync failed' }, 'test-intake-secret');
    expect(opened.status).toBe(201);
    expect(opened.body.action).toBe('created');
    const ref = opened.body.ref as string;

    const appended = await email({ from: 'wanda@example.com', subject: 'Re: Sync failing', body: 'Still failing this morning', in_reply_to: ref }, 'test-intake-secret');
    expect(appended.status).toBe(200);
    expect(appended.body.action).toBe('appended');
    expect(appended.body.ref).toBe(ref);

    const d = await detail(ref);
    const publicComments = d.events.filter((e) => e.type === 'comment' && e.visibility === 'public');
    expect(publicComments).toHaveLength(1);
    expect(publicComments[0]!.actor_type).toBe('requester');
  });

  it('opens a NEW ticket when in_reply_to points at a closed (or unknown) ticket', async () => {
    const opened = await email({ from: 'carl@example.com', subject: 'Done thing', body: 'x' }, 'test-intake-secret');
    const ref = opened.body.ref as string;
    // Close it through the agent side.
    for (const to of ['open', 'resolved', 'closed']) expect((await setStatus(ref, to)).status).toBe(200);

    const reply = await email({ from: 'carl@example.com', subject: 'Re: Done thing', body: 'Actually a new issue', in_reply_to: ref }, 'test-intake-secret');
    expect(reply.status).toBe(201);
    expect(reply.body.action).toBe('created');
    expect(reply.body.ref).not.toBe(ref);

    const unknown = await email({ from: 'carl@example.com', subject: 'Re: nothing', body: 'y', in_reply_to: 'TKT-1999-9999' }, 'test-intake-secret');
    expect(unknown.status).toBe(201);
    expect(unknown.body.action).toBe('created');
  });
});

// ── Public status page & lookup token ────────────────────────────────
describe('public status page', () => {
  it('serves the ticket with a valid token and 404s on a wrong/missing one', async () => {
    const { ref, token } = await submitWeb('high', 'Public visible subject');

    const ok = await request(app).get(`/api/public/tickets/${ref}`).query({ token });
    expect(ok.status).toBe(200);
    expect((ok.body as PublicTicket).subject).toBe('Public visible subject');

    expect((await request(app).get(`/api/public/tickets/${ref}`).query({ token: 'deadbeef' })).status).toBe(404);
    expect((await request(app).get(`/api/public/tickets/${ref}`)).status).toBe(404);
    // Valid-looking token but a ref that does not exist → 404.
    const ghost = 'TKT-2026-9999';
    expect((await request(app).get(`/api/public/tickets/${ghost}`).query({ token: lookupToken(auth, ghost) })).status).toBe(404);
  });

  it('never exposes internal notes on the public page', async () => {
    at(0);
    const { ref, token } = await submitWeb();
    at(5);
    await request(app).post(`/api/tickets/${ref}/comment`).set('Cookie', cookie).send({ body: 'PUBLIC-REPLY', visibility: 'public' });
    at(6);
    await request(app).post(`/api/tickets/${ref}/comment`).set('Cookie', cookie).send({ body: 'SECRET-NOTE', visibility: 'internal' });

    const res = await request(app).get(`/api/public/tickets/${ref}`).query({ token });
    expect(res.status).toBe(200);
    const bodies = (res.body as PublicTicket).events.map((e) => e.body ?? '').join(' | ');
    expect(bodies).toContain('PUBLIC-REPLY');
    expect(bodies).not.toContain('SECRET-NOTE');
  });
});

// ── Config self-check sanity ─────────────────────────────────────────
describe('status-config invariants', () => {
  it('every transition target is reachable and no status transitions to itself', () => {
    expect(canTransition('new', 'open')).toBe(true);
    expect(canTransition('new', 'closed')).toBe(false);
    expect(canTransition('resolved', 'open')).toBe(true);
    expect(canTransition('closed', 'open')).toBe(true);
    expect(canTransition('closed', 'pending')).toBe(false);
  });
});
