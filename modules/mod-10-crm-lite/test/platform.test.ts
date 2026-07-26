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
const appWith = (platform: PlatformHooks): Express => createApp({ db, auth, platform });
async function cookie(app: Express): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}
beforeEach(() => { db = openDb(':memory:'); seed(db); });

describe('PS-07 audit integration', () => {
  it('records an audit event when a company is created', async () => {
    const events: AuditInfo[] = [];
    const app = appWith({ ...noopPlatform, async audit(info) { events.push(info); } });
    const c = await cookie(app);
    await request(app).post('/api/companies').set('Cookie', c).send({ name: 'Acme Co' }).expect(201);
    await new Promise((r) => setImmediate(r));
    expect(events.map((e) => e.action)).toContain('company.created');
  });

  it('is a no-op when AUDIT_URL is unset (standalone)', async () => {
    expect(buildPlatform({})).toBe(noopPlatform);
    const app = createApp({ db, auth });
    const c = await cookie(app);
    await request(app).post('/api/companies').set('Cookie', c).send({ name: 'X' }).expect(201);
  });
});

describe('PS-11 Customers integration', () => {
  it('registers a new company as a party and stores the master id', async () => {
    const seen: { name: string; localId: number }[] = [];
    const app = appWith({
      ...noopPlatform,
      async resolveParty(info) {
        seen.push({ name: info.name, localId: info.localId });
        return 4711;
      },
    });
    const c = await cookie(app);
    const res = await request(app).post('/api/companies').set('Cookie', c).send({ name: 'Acme Co' }).expect(201);
    await new Promise((r) => setImmediate(r));

    expect(seen).toEqual([{ name: 'Acme Co', localId: res.body.id }]);
    const row = db.prepare('SELECT party_id FROM companies WHERE id = ?').get(res.body.id) as {
      party_id: number | null;
    };
    expect(row.party_id).toBe(4711);
  });

  it('leaves party_id null when PS-11 is unconfigured — the standalone posture', async () => {
    const app = createApp({ db, auth });
    const c = await cookie(app);
    const res = await request(app).post('/api/companies').set('Cookie', c).send({ name: 'Acme Co' }).expect(201);
    await new Promise((r) => setImmediate(r));
    const row = db.prepare('SELECT party_id FROM companies WHERE id = ?').get(res.body.id) as {
      party_id: number | null;
    };
    expect(row.party_id).toBeNull();
  });

  it('still creates the company when the master service fails', async () => {
    const app = appWith({
      ...noopPlatform,
      async resolveParty() {
        throw new Error('ECONNREFUSED');
      },
    });
    const c = await cookie(app);
    await request(app).post('/api/companies').set('Cookie', c).send({ name: 'Acme Co' }).expect(201);
    await new Promise((r) => setImmediate(r));
    expect((db.prepare('SELECT COUNT(*) AS n FROM companies').get() as { n: number }).n).toBeGreaterThan(0);
  });
});


describe('SSO login-exchange', () => {
  it('lets PS-01 decide the login, bypassing local credentials', async () => {
    // The injected verifier stands in for a configured PS-01: it approves
    // despite a wrong local password, so the module must still issue a session.
    const app = createApp({ db, auth, verifyLogin: async () => 'ok' });
    await request(app).post('/api/login').send({ username: 'admin', password: 'wrong-password' }).expect(200);
  });

  it('rejects when PS-01 rejects, even with correct local credentials', async () => {
    const app = createApp({ db, auth, verifyLogin: async () => 'fail' });
    await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' }).expect(401);
  });

  it('falls back to local credentials when SSO is unconfigured (null)', async () => {
    const app = createApp({ db, auth, verifyLogin: async () => null });
    await request(app).post('/api/login').send({ username: 'admin', password: 'nope' }).expect(401);
    await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' }).expect(200);
  });
});
