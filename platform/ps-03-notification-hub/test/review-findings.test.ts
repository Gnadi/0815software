import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import type { FetchLike } from '../server/providers/index.js';

/**
 * Defects found by the platform-wide review (docs/TEST-PLAN-PLATFORM.md).
 * Each test fails against the code as it was before the fix.
 */

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
let sends: number;

const okFetch: FetchLike = async () => {
  sends++;
  return { ok: true, status: 200 };
};

const svc = { 'X-Service-Token': 'test-service' };
const as = (t: string) => ({ Authorization: `Bearer ${t}` });

beforeEach(() => {
  db = openDb(':memory:');
  clock = Date.parse('2026-07-01T00:00:00Z');
  sends = 0;
  app = createApp({ db, auth, now: () => clock, resendApiKey: null, fetchImpl: okFetch });
});

async function token(): Promise<string> {
  return (await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' })).body.token as string;
}

describe('P3-1 · A message that reached the recipient is not sent twice', () => {
  it('refuses to re-queue a sent message', async () => {
    const t = await token();
    await request(app).post('/api/channels').set(as(t)).send({ type: 'email', name: 'mail' }).expect(201);
    const queued = await request(app)
      .post('/api/send')
      .set(svc)
      .send({ channel: 'mail', to: 'customer@example.com', subject: 'Invoice 2026-0001', body: 'Attached.' });
    const id = (queued.body as { message: { id: number } }).message.id;

    await request(app).post('/api/tick').set(as(t));
    const sent = await request(app).get(`/api/messages/${id}`).set(as(t));
    expect((sent.body as { message: { status: string } }).message.status).toBe('sent');

    // The operator clicks "retry" on an invoice mail that already went out.
    const retry = await request(app).post(`/api/messages/${id}/retry`).set(as(t));
    expect(retry.status).toBe(409);

    await request(app).post('/api/tick').set(as(t));
    expect(sends).toBe(0); // the console provider is used, so nothing fetched
    const after = await request(app).get(`/api/messages/${id}`).set(as(t));
    const events = (after.body as { events: { type: string }[] }).events.map((e) => e.type);
    expect(events.filter((e) => e === 'sent')).toHaveLength(1);
  });

  it('still re-queues a failed message', async () => {
    const t = await token();
    await request(app).post('/api/channels').set(as(t)).send({ type: 'email', name: 'mail' }).expect(201);
    const queued = await request(app).post('/api/send').set(svc).send({ channel: 'mail', to: 'x@example.com', body: 'B' });
    const id = (queued.body as { message: { id: number } }).message.id;
    db.prepare(`UPDATE messages SET status = 'dead', attempts = 6 WHERE id = ?`).run(id);

    await request(app).post(`/api/messages/${id}/retry`).set(as(t)).expect(200);
    expect((db.prepare('SELECT status FROM messages WHERE id = ?').get(id) as { status: string }).status).toBe('queued');
  });
});
