import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildPlatform, noopPlatform, type AuditInfo, type PlatformHooks } from '../server/platform.js';
import type { AuthConfig } from '../server/auth.js';

const auth: AuthConfig = { username: 'admin', password: 'test-password', secret: 'test-secret', ttlHours: 1, secureCookie: false };

let db: Database.Database;

function appWith(platform: PlatformHooks): Express {
  return createApp({ db, auth, platform });
}
async function cookie(app: Express): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
});

describe('PS-07 audit integration', () => {
  it('records an audit event on create', async () => {
    const events: AuditInfo[] = [];
    const app = appWith({ async audit(info) { events.push(info); } });
    const c = await cookie(app);
    const res = await request(app)
      .post('/api/customers')
      .set('Cookie', c)
      .send({ name: 'Test Person', email: 'test@example.com', status: 'prospect' });
    expect(res.status).toBe(201);
    // Fire-and-forget: let the microtask run.
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe('customers.created');
    expect(events[0]!.actor).toBe('admin');
  });

  it('is a no-op when AUDIT_URL is unset (standalone)', async () => {
    expect(buildPlatform({})).toBe(noopPlatform);
    const app = createApp({ db, auth }); // default noop
    const c = await cookie(app);
    await request(app).post('/api/customers').set('Cookie', c).send({ name: 'X', email: 'x@y.z', status: 'prospect' }).expect(201);
  });
});


describe('SSO login-exchange', () => {
  it('lets PS-01 decide the login, bypassing local credentials', async () => {
    // The injected verifier stands in for a configured PS-01: it approves
    // despite a wrong local password, so the module must still issue a session.
    const app = createApp({ db, auth, verifyLogin: async () => ({ ok: true, actor: 'ada@acme.test' }) });
    await request(app).post('/api/login').send({ username: 'admin', password: 'wrong-password' }).expect(200);
  });

  it('rejects when PS-01 rejects, even with correct local credentials', async () => {
    const app = createApp({ db, auth, verifyLogin: async () => ({ ok: false }) });
    await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' }).expect(401);
  });

  it('falls back to local credentials when SSO is unconfigured (null)', async () => {
    const app = createApp({ db, auth, verifyLogin: async () => null });
    await request(app).post('/api/login').send({ username: 'admin', password: 'nope' }).expect(401);
    await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' }).expect(200);
  });
});
