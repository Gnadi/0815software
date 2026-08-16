import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { loginModeOf } from '../server/sso.js';
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
const program = { name: 'Digital Jetzt', funding_body: 'BMWK', category: 'digitalisation', funding_rate: 50, max_grant_cents: 5000000, status: 'open' };
const application = (pid: number) => ({ program_id: pid, title: 'ERP', eligible_costs_cents: 10000000, requested_amount_cents: 4000000 });
beforeEach(() => { db = openDb(':memory:'); seed(db); });

describe('PS-07 audit integration', () => {
  it('records an audit event on application transition', async () => {
    const events: AuditInfo[] = [];
    const app = appWith({ ...noopPlatform, async audit(info) { events.push(info); } });
    const c = await cookie(app);
    const prog = await request(app).post('/api/programs').set('Cookie', c).send(program);
    const appn = await request(app).post('/api/applications').set('Cookie', c).send(application(prog.body.id));
    await request(app).post(`/api/applications/${appn.body.id}/transition`).set('Cookie', c).send({ to: 'submitted' }).expect(200);
    await new Promise((r) => setImmediate(r));
    expect(events.map((e) => e.action)).toContain('application.transitioned');
  });
  it('is a no-op when unconfigured (standalone)', async () => {
    expect(buildPlatform({})).toBe(noopPlatform);
    const app = createApp({ db, auth });
    const c = await cookie(app);
    const prog = await request(app).post('/api/programs').set('Cookie', c).send(program);
    await request(app).post('/api/applications').set('Cookie', c).send(application(prog.body.id)).expect(201);
  });
});


describe('SSO login-exchange', () => {
  it('tells the login form which credentials this deployment accepts', async () => {
    // Public on purpose: the form reads it before anyone is signed in.
    await request(createApp({ db, auth }))
      .get('/api/auth-mode')
      .expect(200)
      .expect({ sso: false });
    await request(createApp({ db, auth, loginMode: { sso: true, org: 'acme' } }))
      .get('/api/auth-mode')
      .expect(200)
      .expect({ sso: true, org: 'acme' });
  });

  it('reads the login mode off the same config the verifier switches on', () => {
    expect(loginModeOf({})).toEqual({ sso: false });
    expect(loginModeOf({ identityUrl: 'http://ps01:4001' })).toEqual({ sso: false });
    expect(loginModeOf({ identityUrl: 'http://ps01:4001', identityOrg: 'acme' })).toEqual({
      sso: true,
      org: 'acme',
    });
  });

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
