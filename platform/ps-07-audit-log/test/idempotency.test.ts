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

async function token(): Promise<string> {
  return (await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' })).body.token as string;
}

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, auth });
});

describe('event idempotency', () => {
  it('replays the original event for a repeated key without appending', async () => {
    const first = await request(app)
      .post('/api/events')
      .set(svc)
      .send({ actor: 'user:1', action: 'invoice.paid', resource: 'invoice:7', idempotency_key: 'pay-7' });
    expect(first.status).toBe(201);

    const replay = await request(app)
      .post('/api/events')
      .set(svc)
      .send({ actor: 'user:1', action: 'invoice.paid', resource: 'invoice:7', idempotency_key: 'pay-7' });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    expect(replay.body.hash).toBe(first.body.hash);

    const t = await token();
    const verify = await request(app).get('/api/verify').set(as(t));
    expect(verify.body).toEqual({ valid: true, count: 1 });
  });

  it('keeps events without a key non-idempotent', async () => {
    const send = () =>
      request(app).post('/api/events').set(svc).send({ actor: 'user:1', action: 'x', resource: 'y' });
    expect((await send()).status).toBe(201);
    expect((await send()).status).toBe(201);
    const t = await token();
    expect((await request(app).get('/api/verify').set(as(t))).body.count).toBe(2);
  });
});
