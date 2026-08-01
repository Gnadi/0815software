import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { SessionConfig } from '../server/auth.js';

/**
 * "Give me everything you hold about me" (GDPR Art. 15/20) had no answer here
 * but a manual read of the SQLite file — under a one-month deadline. These
 * cover that the answer is complete, scoped, and does not leak a credential.
 */

const session: SessionConfig = { secret: 'test-secret', ttlHours: 12, secureCookie: false };

let db: Database.Database;
let app: Express;

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, session });
});

const login = async (email: string, password: string, org = 'acme'): Promise<string> => {
  const res = await request(app).post('/api/login').send({ org_slug: org, email, password });
  expect(res.status).toBe(200);
  return res.body.token as string;
};

describe('subject export', () => {
  it('returns the user, their roles and their auth events', async () => {
    const owner = await login('owner@acme.test', 'demo-owner');
    const res = await request(app)
      .get('/api/export?subject=owner@acme.test')
      .set('Authorization', `Bearer ${owner}`);

    expect(res.status).toBe(200);
    expect(res.body.service).toBe('ps-01-identity');
    expect(res.body.records.user[0].email).toBe('owner@acme.test');
    expect(res.body.records.roles.map((r: { key: string }) => r.key)).toContain('owner');
    // Logging in just now is itself a record about them.
    expect(res.body.records.auth_events.length).toBeGreaterThan(0);
  });

  it('never hands over the password hash', async () => {
    const owner = await login('owner@acme.test', 'demo-owner');
    const res = await request(app)
      .get('/api/export?subject=owner@acme.test')
      .set('Authorization', `Bearer ${owner}`);
    // Art. 15 is a right to your data, not to a credential derived from it.
    expect(JSON.stringify(res.body)).not.toContain('scrypt:');
    expect(res.body.records.user[0]).not.toHaveProperty('password_hash');
  });

  it('includes failed logins recorded under an address with no account', async () => {
    await request(app).post('/api/login').send({ org_slug: 'acme', email: 'ghost@acme.test', password: 'nope' });
    const owner = await login('owner@acme.test', 'demo-owner');

    const res = await request(app)
      .get('/api/export?subject=ghost@acme.test')
      .set('Authorization', `Bearer ${owner}`);
    expect(res.status).toBe(200);
    expect(res.body.records.user).toBeUndefined(); // there is no account…
    expect(res.body.records.failed_logins.length).toBeGreaterThan(0); // …but there is a trace
  });

  it('answers honestly when it holds nothing', async () => {
    const owner = await login('owner@acme.test', 'demo-owner');
    const res = await request(app)
      .get('/api/export?subject=nobody@nowhere.test')
      .set('Authorization', `Bearer ${owner}`);
    expect(res.status).toBe(200);
    expect(res.body.records).toEqual({});
  });

  it('stays inside the caller organization', async () => {
    // A Globex owner must not be able to export an Acme user.
    const globex = await login('owner@globex.test', 'demo-owner', 'globex');
    const res = await request(app)
      .get('/api/export?subject=owner@acme.test')
      .set('Authorization', `Bearer ${globex}`);
    expect(res.status).toBe(200);
    expect(res.body.records.user).toBeUndefined();
  });

  it('needs a session, and more than the directory permission', async () => {
    expect((await request(app).get('/api/export?subject=x@y.test')).status).toBe(401);

    // A member holds `user:read` — every role down to viewer does, because
    // that is the directory. An export is not directory data.
    const member = await login('member@acme.test', 'demo-member');
    const forbidden = await request(app)
      .get('/api/export?subject=owner@acme.test')
      .set('Authorization', `Bearer ${member}`);
    expect(forbidden.status).toBe(403);

    const admin = await login('admin@acme.test', 'demo-admin');
    const allowed = await request(app)
      .get('/api/export?subject=owner@acme.test')
      .set('Authorization', `Bearer ${admin}`);
    expect(allowed.status).toBe(200);
  });

  it('requires a subject', async () => {
    const owner = await login('owner@acme.test', 'demo-owner');
    const res = await request(app).get('/api/export').set('Authorization', `Bearer ${owner}`);
    expect(res.status).toBe(422);
  });
});
