import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import type { FetchLike } from '../server/webhooks.js';
import { MAX_ATTEMPTS } from '../server/retry.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};

let app: Express;
let db: Database.Database;
let clock: number;
let fetchOutcome: 'ok' | 'fail';

const mockFetch: FetchLike = async () => (fetchOutcome === 'ok' ? { ok: true, status: 200 } : { ok: false, status: 500 });

async function adminToken(): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' });
  return res.body.token as string;
}

function as(token: string) {
  return { Authorization: `Bearer ${token}` };
}

beforeEach(() => {
  db = openDb(':memory:');
  clock = Date.parse('2026-07-01T00:00:00Z');
  fetchOutcome = 'ok';
  app = createApp({ db, auth, now: () => clock, fetchImpl: mockFetch });
});

const SIMPLE = {
  initial: 'a',
  steps: ['a', 'b', 'c'],
  transitions: { a: ['b'], b: ['c'] },
  terminal: ['c'],
};

describe('auth & health', () => {
  it('health is public, protected routes need auth', async () => {
    expect((await request(app).get('/api/health')).body).toEqual({ ok: true });
    expect((await request(app).get('/api/workflows')).status).toBe(401);
    expect((await request(app).post('/api/login').send({ username: 'admin', password: 'nope' })).status).toBe(401);
  });
});

describe('workflows & idempotent run', () => {
  it('creates a workflow and dedupes runs by idempotency key', async () => {
    const token = await adminToken();
    await request(app)
      .post('/api/workflows')
      .set(as(token))
      .send({ key: 'idem', name: 'Idem', definition: SIMPLE })
      .expect(201);

    const first = await request(app)
      .post('/api/workflows/idem/run')
      .set(as(token))
      .send({ idempotency_key: 'k1', input: { a: 1 } });
    expect(first.status).toBe(201);
    const id = first.body.instance.id;

    const replay = await request(app)
      .post('/api/workflows/idem/run')
      .set(as(token))
      .send({ idempotency_key: 'k1', input: { a: 1 } });
    expect(replay.status).toBe(200);
    expect(replay.body.instance.id).toBe(id);

    const conflict = await request(app)
      .post('/api/workflows/idem/run')
      .set(as(token))
      .send({ idempotency_key: 'k1', input: { a: 2 } });
    expect(conflict.status).toBe(409);
  });
});

describe('append-only instances & transitions', () => {
  it('folds current step and rejects illegal transitions', async () => {
    const token = await adminToken();
    await request(app).post('/api/workflows').set(as(token)).send({ key: 'flow', name: 'Flow', definition: SIMPLE });
    const run = await request(app).post('/api/workflows/flow/run').set(as(token)).send({});
    const id = run.body.instance.id;
    expect(run.body.instance.current_step).toBe('a');
    expect(run.body.instance.status).toBe('running');

    // a → c is illegal.
    const illegal = await request(app).post(`/api/instances/${id}/advance`).set(as(token)).send({ to_step: 'c' });
    expect(illegal.status).toBe(422);

    // a → b → c is legal; the event stream only grows.
    await request(app).post(`/api/instances/${id}/advance`).set(as(token)).send({ to_step: 'b' }).expect(200);
    const afterB = await request(app).get(`/api/instances/${id}`).set(as(token));
    expect(afterB.body.instance.current_step).toBe('b');

    await request(app).post(`/api/instances/${id}/advance`).set(as(token)).send({ to_step: 'c' }).expect(200);
    const done = await request(app).get(`/api/instances/${id}`).set(as(token));
    expect(done.body.instance.status).toBe('completed');
    // created, entered a, completed a, entered b, completed b, entered c, completed
    expect(done.body.instance.events.length).toBe(7);
    // advancing a terminal instance conflicts
    expect((await request(app).post(`/api/instances/${id}/advance`).set(as(token)).send({ to_step: 'b' })).status).toBe(409);
  });
});

describe('event ingestion & inbound hooks', () => {
  it('requires the service token and matches event triggers', async () => {
    const token = await adminToken();
    await request(app).post('/api/workflows').set(as(token)).send({ key: 'esc', name: 'Esc', definition: SIMPLE });
    await request(app)
      .post('/api/triggers')
      .set(as(token))
      .send({ workflow_key: 'esc', type: 'event', config: { event: 'thing.happened' } })
      .expect(201);

    expect((await request(app).post('/api/events').send({ type: 'thing.happened' })).status).toBe(401);
    expect(
      (await request(app).post('/api/events').set('X-Service-Token', 'wrong').send({ type: 'thing.happened' })).status,
    ).toBe(403);

    const ok = await request(app)
      .post('/api/events')
      .set('X-Service-Token', 'test-service')
      .send({ type: 'thing.happened', payload: { n: 1 } });
    expect(ok.status).toBe(200);
    expect(ok.body.matched).toBe(1);

    expect((await request(app).post('/api/hooks/wrong').send({ type: 'x' })).status).toBe(403);
    expect((await request(app).post('/api/hooks/test-service').send({ type: 'thing.happened' })).status).toBe(202);
  });
});

describe('scheduler tick (no backfill)', () => {
  it('fires a due schedule once and never backfills missed intervals', async () => {
    const token = await adminToken();
    await request(app).post('/api/workflows').set(as(token)).send({ key: 'sched', name: 'Sched', definition: SIMPLE });
    await request(app)
      .post('/api/triggers')
      .set(as(token))
      .send({ workflow_key: 'sched', type: 'schedule', config: { interval_seconds: 3600 } });

    const tick = async () => (await request(app).post('/api/tick').set(as(token))).body.scheduled as number;
    const count = async () => (await request(app).get('/api/instances?workflow=sched').set(as(token))).body.instances.length;

    expect(await tick()).toBe(1); // first tick fires
    expect(await tick()).toBe(0); // same clock, not due
    clock += 100 * 1000; // 100s later, still not due
    expect(await tick()).toBe(0);
    clock += 4 * 3600 * 1000; // jump 4 hours (skipping 3 intervals)
    expect(await tick()).toBe(1); // fires exactly once, no backfill
    expect(await count()).toBe(2);
  });
});

describe('webhook delivery: backoff & dead-letter', () => {
  it('retries with backoff and dead-letters after MAX_ATTEMPTS', async () => {
    const token = await adminToken();
    await request(app)
      .post('/api/webhooks')
      .set(as(token))
      .send({ event_type: 'evt.retry', url: 'https://example.invalid/hook' })
      .expect(201);

    // Enqueue one delivery via an ingested event (no trigger needed).
    await request(app).post('/api/events').set('X-Service-Token', 'test-service').send({ type: 'evt.retry' });

    fetchOutcome = 'fail';
    const delivery = async () =>
      (await request(app).get('/api/deliveries').set(as(token))).body.deliveries[0];

    let guard = 0;
    // Drive ticks, always jumping the clock to the next due time.
    while ((await delivery()).status !== 'dead' && guard++ < 20) {
      const current = await delivery();
      clock = Date.parse(current.next_attempt_at) + 1000;
      await request(app).post('/api/tick').set(as(token));
    }
    const d = await delivery();
    expect(d.status).toBe('dead');
    expect(d.attempts).toBe(MAX_ATTEMPTS);

    // A retry resets it to pending; a successful tick then delivers it.
    await request(app).post(`/api/deliveries/${d.id}/retry`).set(as(token)).expect(200);
    fetchOutcome = 'ok';
    await request(app).post('/api/tick').set(as(token));
    expect((await delivery()).status).toBe('delivered');
  });
});
