import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildLoginVerifier } from '../server/sso.js';
import type { AuthConfig } from '../server/auth.js';
// Boot the REAL PS-01 Identity in-process and log into mod-02 through it — the
// end-to-end proof that the SSO seam (module → IdentityClient → PS-01 verify →
// platform:admin check) works against the real service, not just a stub.
import { createApp as createIdentityApp } from '../../../platform/ps-01-identity/server/app.js';
import { openDb as openIdentityDb } from '../../../platform/ps-01-identity/server/db.js';
import { seed as seedIdentity } from '../../../platform/ps-01-identity/server/seed.js';
import { base32Decode, totp } from '../../../platform/ps-01-identity/server/totp.js';

const auth: AuthConfig = { username: 'admin', password: 'local-only', secret: 'test-secret', ttlHours: 1, secureCookie: false };

let identityServer: Server;
let identityUrl: string;
let app: Express;

beforeAll(async () => {
  const idDb = openIdentityDb(':memory:');
  await seedIdentity(idDb);
  identityServer = createIdentityApp({ db: idDb, session: { secret: 'id-secret', ttlHours: 12, secureCookie: false } }).listen(0);
  identityUrl = `http://127.0.0.1:${(identityServer.address() as AddressInfo).port}`;

  const db: Database.Database = openDb(':memory:');
  seed(db);
  // A real verifier pointed at the live PS-01, requiring platform:admin.
  const verifyLogin = buildLoginVerifier({ identityUrl, identityOrg: 'acme', identityPermission: 'platform:admin' });
  app = createApp({ db, auth, verifyLogin });
});

afterAll(() => {
  identityServer.close();
});

describe('mod-02 login via real PS-01 identity', () => {
  const login = (username: string, password: string) =>
    request(app).post('/api/login').send({ username, password });

  it('accepts an org owner who holds platform:admin', async () => {
    // Seeded acme owner; the owner role carries platform:admin (Phase 1).
    await login('owner@acme.test', 'demo-owner').expect(200);
  });

  it('rejects a wrong password', async () => {
    await login('owner@acme.test', 'nope').expect(401);
  });

  it('rejects a valid user who lacks platform:admin', async () => {
    // Seeded acme member authenticates at PS-01 but has no platform:admin.
    await login('member@acme.test', 'demo-member').expect(401);
  });

  it('asks for the second factor of an account that has one, and lets the right code in', async () => {
    // Enrol the seeded administrator (who holds platform:admin) at the real
    // PS-01, as they would in their account; no other test here signs them in.
    const ps01 = (path: string, body: unknown, token?: string) =>
      fetch(`${identityUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      }).then((r) => r.json() as Promise<Record<string, unknown>>);
    const { token } = (await ps01('/api/login', { org_slug: 'acme', email: 'admin@acme.test', password: 'demo-admin' })) as {
      token: string;
    };
    const setup = (await ps01('/api/me/mfa/totp/setup', { current_password: 'demo-admin' }, token)) as { secret: string };
    const secret = base32Decode(setup.secret);
    // The previous step's code, so the current one is still unspent for the login.
    await ps01('/api/me/mfa/totp/confirm', { otp: totp(secret, Date.now() - 30_000) }, token);

    const without = await login('admin@acme.test', 'demo-admin').expect(401);
    expect(without.body.details).toEqual([{ field: 'otp', message: 'is required' }]);
    const right = totp(secret, Date.now());
    const wrong = await request(app)
      .post('/api/login')
      .send({ username: 'admin@acme.test', password: 'demo-admin', otp: right === '000000' ? '111111' : '000000' })
      .expect(401);
    expect(wrong.body.details).toEqual([{ field: 'otp', message: 'is invalid' }]);
    await request(app).post('/api/login').send({ username: 'admin@acme.test', password: 'demo-admin', otp: right }).expect(200);
  });

  it('rejects the local admin creds now that SSO is in force', async () => {
    await login('admin', 'local-only').expect(401);
  });

  it('answers 503, not 401, when PS-01 cannot be reached', async () => {
    // A verifier pointed at a port nothing is listening on: the module must
    // still fail closed (no session), but it must not tell the user their
    // password was wrong — nothing ever checked it. 401 here would send
    // someone to reset a working password and would disguise an identity
    // outage as a run of bad logins in the operator's dashboards.
    // A port that really was bound and then released, so the URL is
    // well-formed and the connection is genuinely refused — the shape of a
    // PS-01 that is down, rather than a URL the HTTP client rejects outright.
    const probe = createServer().listen(0);
    await once(probe, 'listening');
    const deadPort = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const offlineDb: Database.Database = openDb(':memory:');
    await seed(offlineDb);
    const offline = createApp({
      db: offlineDb,
      auth,
      verifyLogin: buildLoginVerifier({
        identityUrl: `http://127.0.0.1:${deadPort}`,
        identityOrg: 'acme',
        identityPermission: 'platform:admin',
      }),
    });
    const res = await request(offline).post('/api/login').send({ username: 'owner@acme.test', password: 'demo-owner' });
    expect(res.status).toBe(503);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('mod-02 access levels from real PS-01 module permissions', () => {
  // No IDENTITY_PERMISSION: the level comes from the user's `module:` grants.
  let derived: Express;
  let identity: string;

  const ps01 = () => request(identityUrl);
  const as = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const db: Database.Database = openDb(':memory:');
    seed(db);
    derived = createApp({ db, auth, verifyLogin: buildLoginVerifier({ identityUrl, identityOrg: 'acme' }) });

    identity = (await ps01().post('/api/login').send({ org_slug: 'acme', email: 'owner@acme.test', password: 'demo-owner' })).body
      .token as string;
    const role = await ps01()
      .post('/api/roles')
      .set(as(identity))
      .send({ key: 'admin-dashboard-reader', name: 'Admin dashboard reader', permissions: ['module:admin-dashboard:view'] })
      .expect(201);
    const users = await ps01().get('/api/users').set(as(identity)).expect(200);
    const member = users.body.users.find((u: { email: string }) => u.email === 'member@acme.test');
    await ps01().post(`/api/users/${member.id}/roles`).set(as(identity)).send({ role_id: role.body.role.id }).expect(200);
  });

  it('a member granted view signs in as a viewer: reads pass, writes are refused', async () => {
    const res = await request(derived).post('/api/login').send({ username: 'member@acme.test', password: 'demo-member' }).expect(200);
    expect(res.body.access).toBe('view');
    const cookie = res.headers['set-cookie'] as unknown as string[];

    const config = await request(derived).get('/api/config').set('Cookie', cookie).expect(200);
    expect(config.body.access).toBe('view');
    const write = await request(derived).post('/api/customers').set('Cookie', cookie).send({});
    expect(write.status).toBe(403);
  });

  it('the owner still manages, through platform:admin', async () => {
    const res = await request(derived).post('/api/login').send({ username: 'owner@acme.test', password: 'demo-owner' }).expect(200);
    expect(res.body.access).toBe('manage');
  });
});
