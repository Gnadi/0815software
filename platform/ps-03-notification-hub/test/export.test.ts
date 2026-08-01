import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { AuthConfig } from '../server/auth.js';

/**
 * What this service holds about a person is what was sent TO them, and the
 * body of an invoice mail or a ticket reply is personal data with content —
 * not just a delivery record. So a subject access request has to be able to
 * reach it, keyed on the address the rows already carry.
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
  seed(db);
  app = createApp({ db, auth });
});

async function send(to: string, subject: string): Promise<void> {
  const res = await request(app)
    .post('/api/send')
    .set(svc)
    .send({ channel: 'transactional-email', to, subject, body: `Hello ${to}` });
  expect(res.status).toBe(201);
}

describe('subject export', () => {
  it('returns the messages sent to them, with their bodies and events', async () => {
    await send('ada@acme.test', 'Invoice 2026-0001');
    await send('ada@acme.test', 'Invoice 2026-0002');
    await send('bob@acme.test', 'Not hers');

    const res = await request(app)
      .get('/api/export?subject=ada@acme.test')
      .set({ Authorization: `Bearer ${await token()}` });

    expect(res.status).toBe(200);
    expect(res.body.service).toBe('ps-03-notification-hub');
    expect(res.body.records.messages).toHaveLength(2);
    expect(res.body.records.messages[0].body).toContain('ada@acme.test');
    // The queued/attempted trail belongs to the same person's record.
    expect(res.body.records.message_events.length).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain('bob@acme.test');
  });

  it('matches the address however it was capitalised', async () => {
    await send('Ada@Acme.Test', 'Mixed case');
    const res = await request(app)
      .get('/api/export?subject=ada@acme.test')
      .set({ Authorization: `Bearer ${await token()}` });
    expect(res.body.records.messages).toHaveLength(1);
  });

  it('answers honestly when it holds nothing, and needs a session', async () => {
    const empty = await request(app)
      .get('/api/export?subject=nobody@nowhere.test')
      .set({ Authorization: `Bearer ${await token()}` });
    expect(empty.status).toBe(200);
    expect(empty.body.records).toEqual({});

    expect((await request(app).get('/api/export?subject=x@y.test')).status).toBe(401);
  });
});
