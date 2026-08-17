import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { loginModeOf } from '../server/sso.js';
import { openDb } from '../server/db.js';
import { openSourceDb } from '../server/source-db.js';
import { seedSourceDb, seedMeta } from '../server/seed.js';
import { buildPlatform, noopPlatform, type AuditInfo, type PlatformHooks } from '../server/platform.js';
import type { AuthConfig } from '../server/auth.js';

const auth: AuthConfig = { username: 'admin', password: 'test-password', secret: 'test-secret', ttlHours: 1, secureCookie: false };

let tmp: string;
let db: Database.Database;
let sourceDb: Database.Database;
let exportsDir: string;

function makeApp(platform: PlatformHooks): Express {
  return createApp({ db, sourceDb, auth, exportsDir, platform });
}
async function cookie(app: Express): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mod08-plat-'));
  exportsDir = join(tmp, 'exports');
  const writable = new Database(join(tmp, 'source.db'));
  seedSourceDb(writable);
  writable.close();
  db = openDb(':memory:');
  seedMeta(db, exportsDir);
  sourceDb = openSourceDb(join(tmp, 'source.db'));
});
afterEach(() => {
  sourceDb.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('PS-07 audit integration', () => {
  it('records an audit event when a report is run', async () => {
    const events: AuditInfo[] = [];
    const app = makeApp({ async audit(info) { events.push(info); } });
    const c = await cookie(app);
    const report = await request(app).post('/api/reports').set('Cookie', c).send({ name: 'R', sql: 'SELECT 1 AS n' });
    await request(app).post(`/api/reports/${report.body.id}/run-now`).set('Cookie', c).expect(201);
    await new Promise((r) => setImmediate(r));
    expect(events.map((e) => e.action)).toContain('report.run');
  });

  it('is a no-op when AUDIT_URL is unset (standalone)', async () => {
    expect(buildPlatform({})).toBe(noopPlatform);
    const app = createApp({ db, sourceDb, auth, exportsDir });
    const c = await cookie(app);
    const report = await request(app).post('/api/reports').set('Cookie', c).send({ name: 'R', sql: 'SELECT 1 AS n' });
    await request(app).post(`/api/reports/${report.body.id}/run-now`).set('Cookie', c).expect(201);
  });
});


describe('SSO login-exchange', () => {
  it('tells the login form which credentials this deployment accepts', async () => {
    // Public on purpose: the form reads it before anyone is signed in.
    await request(createApp({ db, sourceDb, auth, exportsDir }))
      .get('/api/auth-mode')
      .expect(200)
      .expect({ sso: false });
    await request(createApp({ db, sourceDb, auth, exportsDir, loginMode: { sso: true, org: 'acme' } }))
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
    const app = createApp({ db, sourceDb, auth, exportsDir, verifyLogin: async () => ({ ok: true, actor: 'ada@acme.test' }) });
    await request(app).post('/api/login').send({ username: 'admin', password: 'wrong-password' }).expect(200);
  });

  it('rejects when PS-01 rejects, even with correct local credentials', async () => {
    const app = createApp({ db, sourceDb, auth, exportsDir, verifyLogin: async () => ({ ok: false }) });
    await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' }).expect(401);
  });

  it('falls back to local credentials when SSO is unconfigured (null)', async () => {
    const app = createApp({ db, sourceDb, auth, exportsDir, verifyLogin: async () => null });
    await request(app).post('/api/login').send({ username: 'admin', password: 'nope' }).expect(401);
    await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' }).expect(200);
  });
});
