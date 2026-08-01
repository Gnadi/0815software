import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';

/**
 * A subject access request has to be answerable from the audit trail too: it
 * holds both what a person did and what was done to them, and a before/after
 * snapshot can embed their data without their name ever being the actor.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};
const svc = { 'X-Service-Token': 'test-service' };

let db: Database.Database;
let app: Express;

const token = async (): Promise<string> =>
  (await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' })).body.token as string;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, auth });
});

describe('subject export', () => {
  it('finds events they caused and events that merely mention them', async () => {
    await request(app)
      .post('/api/events')
      .set(svc)
      .send({ actor: 'ada@acme.test', action: 'invoice.issued', resource: 'invoice:2026-0001' })
      .expect(201);
    // Someone else acted; the snapshot is about Ada.
    await request(app)
      .post('/api/events')
      .set(svc)
      .send({
        actor: 'bob@acme.test',
        action: 'customer.updated',
        resource: 'customer:7',
        after: { email: 'ada@acme.test', name: 'Ada Lovelace' },
      })
      .expect(201);
    await request(app)
      .post('/api/events')
      .set(svc)
      .send({ actor: 'bob@acme.test', action: 'offer.sent', resource: 'offer:9' })
      .expect(201);

    const res = await request(app)
      .get('/api/export?subject=ada@acme.test')
      .set({ Authorization: `Bearer ${await token()}` });

    expect(res.status).toBe(200);
    expect(res.body.records.events_as_actor).toHaveLength(1);
    expect(res.body.records.events_mentioning).toHaveLength(1);
    expect(res.body.records.events_mentioning[0].action).toBe('customer.updated');
  });

  it('does not let a wildcard subject drain the whole log', async () => {
    await request(app)
      .post('/api/events')
      .set(svc)
      .send({ actor: 'ada@acme.test', action: 'x', resource: 'y' })
      .expect(201);

    const res = await request(app).get('/api/export?subject=%25').set({ Authorization: `Bearer ${await token()}` });
    expect(res.status).toBe(200);
    expect(res.body.records).toEqual({});
  });

  it('requires a session and a subject', async () => {
    expect((await request(app).get('/api/export?subject=x')).status).toBe(401);
    const res = await request(app).get('/api/export').set({ Authorization: `Bearer ${await token()}` });
    expect(res.status).toBe(422);
  });

  it('leaves the chain untouched — an export is a read', async () => {
    await request(app)
      .post('/api/events')
      .set(svc)
      .send({ actor: 'ada@acme.test', action: 'x', resource: 'y' })
      .expect(201);
    const t = await token();
    await request(app).get('/api/export?subject=ada@acme.test').set({ Authorization: `Bearer ${t}` });

    const verdict = await request(app).get('/api/verify').set({ Authorization: `Bearer ${t}` });
    expect(verdict.body.valid).toBe(true);
  });
});
