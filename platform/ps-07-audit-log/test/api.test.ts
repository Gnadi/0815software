import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};

const svc = { 'X-Service-Token': 'test-service' };
const as = (t: string) => ({ Authorization: `Bearer ${t}` });

let db: Database.Database;
let app: Express;
let clock: number;

async function token(): Promise<string> {
  return (await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' })).body.token as string;
}

beforeEach(() => {
  db = openDb(':memory:');
  clock = Date.parse('2026-07-01T00:00:00Z');
  app = createApp({ db, auth, now: () => clock });
});

async function emit(overrides: Record<string, unknown> = {}): Promise<request.Response> {
  return request(app)
    .post('/api/events')
    .set(svc)
    .send({ actor: 'user:1', action: 'thing.done', resource: 'thing:1', ...overrides });
}

describe('auth & recording', () => {
  it('is public for health, gates reads, and requires a service token to record', async () => {
    expect((await request(app).get('/api/health')).body).toEqual({ ok: true });
    expect((await request(app).get('/api/events')).status).toBe(401);
    expect((await request(app).post('/api/events').send({ actor: 'a', action: 'x', resource: 'r' })).status).toBe(401);
    expect((await request(app).post('/api/events').set({ 'X-Service-Token': 'no' }).send({ actor: 'a', action: 'x', resource: 'r' })).status).toBe(403);
  });

  it('records an event and validates required fields', async () => {
    const res = await emit({ after: { total: 100 }, org: 'acme' });
    expect(res.status).toBe(201);
    expect(res.body.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.prev_hash).toBeNull(); // first event
    expect(res.body.after).toEqual({ total: 100 });
    expect((await request(app).post('/api/events').set(svc).send({ actor: 'a' })).status).toBe(422);
  });
});

describe('hash chain integrity', () => {
  it('chains events and verifies the whole log', async () => {
    const first = await emit();
    const second = await emit({ action: 'thing.updated' });
    expect(second.body.prev_hash).toBe(first.body.hash);

    const t = await token();
    const verify = await request(app).get('/api/verify').set(as(t));
    expect(verify.body).toEqual({ valid: true, count: 2 });
  });

  it('detects tampering with a past event', async () => {
    await emit();
    await emit({ action: 'thing.updated' });
    // Tamper directly in the DB — the audit service would never do this.
    db.prepare("UPDATE audit_events SET action = 'thing.forged' WHERE id = 1").run();

    const t = await token();
    const verify = await request(app).get('/api/verify').set(as(t));
    expect(verify.body.valid).toBe(false);
    expect(verify.body.broken_at).toBe(1);
  });
});

describe('listing & filtering', () => {
  it('filters by actor, resource and action, newest first', async () => {
    await emit({ actor: 'user:1', resource: 'a:1', action: 'created' });
    await emit({ actor: 'user:2', resource: 'a:2', action: 'updated' });
    await emit({ actor: 'user:1', resource: 'a:3', action: 'deleted' });
    const t = await token();

    const byActor = await request(app).get('/api/events?actor=user:1').set(as(t));
    expect(byActor.body.events.length).toBe(2);
    expect(byActor.body.events[0].id).toBeGreaterThan(byActor.body.events[1].id); // newest first

    const byAction = await request(app).get('/api/events?action=updated').set(as(t));
    expect(byAction.body.events.length).toBe(1);
    expect(byAction.body.events[0].actor).toBe('user:2');
  });
});

describe('identity seam', () => {
  it('accepts a PS-01-verified token when IDENTITY_URL is set', async () => {
    const identityFetch = async (_url: string, init?: { body?: string }) => {
      const tok = init?.body ? (JSON.parse(init.body).token as string) : '';
      return { ok: true, status: 200, json: async () => ({ valid: tok === 'ps01-good' }) };
    };
    const seamApp = createApp({ db, auth: { ...auth, identityUrl: 'http://identity.test' }, now: () => clock, identityFetch });
    expect((await request(seamApp).get('/api/events').set(as('ps01-good'))).status).toBe(200);
    expect((await request(seamApp).get('/api/events').set(as('ps01-bad'))).status).toBe(401);
  });
});
