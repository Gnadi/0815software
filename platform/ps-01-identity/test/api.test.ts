import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { SessionConfig } from '../server/auth.js';

const session: SessionConfig = { secret: 'test-secret', ttlHours: 12, secureCookie: false };

let app: Express;
let db: Database.Database;

beforeAll(() => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, session });
});

interface Login {
  status: number;
  token: string;
  cookie: string;
}

async function login(orgSlug: string, email: string, password: string): Promise<Login> {
  const res = await request(app).post('/api/login').send({ org_slug: orgSlug, email, password });
  const setCookie = res.headers['set-cookie'] as unknown as string[] | undefined;
  return {
    status: res.status,
    token: res.body.token ?? '',
    cookie: setCookie ? setCookie[0]!.split(';')[0]! : '',
  };
}

describe('health & auth', () => {
  it('reports health without a session', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('rejects an unknown email and a wrong password with 401', async () => {
    expect((await login('acme', 'nobody@acme.test', 'demo-owner')).status).toBe(401);
    expect((await login('acme', 'owner@acme.test', 'wrong-password')).status).toBe(401);
    expect((await login('nosuchorg', 'owner@acme.test', 'demo-owner')).status).toBe(401);
  });

  it('logs a valid user in and returns a token', async () => {
    const res = await login('acme', 'owner@acme.test', 'demo-owner');
    expect(res.status).toBe(200);
    expect(res.token).toMatch(/^\d+\.\d+\.\d+\.\d+\./);
  });

  it('requires authentication for protected routes', async () => {
    expect((await request(app).get('/api/me')).status).toBe(401);
  });

  it('returns identity and permissions for the owner', async () => {
    const { token } = await login('acme', 'owner@acme.test', 'demo-owner');
    const res = await request(app).get('/api/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('owner@acme.test');
    expect(res.body.permissions).toContain('user:write');
    expect(res.body.permissions).toContain('org:write');
  });
});

describe('tenant isolation', () => {
  it('returns 404 when reaching for another org\'s user', async () => {
    const { token } = await login('acme', 'owner@acme.test', 'demo-owner');
    const globexUser = db
      .prepare('SELECT id FROM users WHERE email = ?')
      .get('owner@globex.test') as { id: number };
    const res = await request(app)
      .get(`/api/users/${globexUser.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});

describe('RBAC', () => {
  it('forbids a member from creating users but allows an admin', async () => {
    const member = await login('acme', 'member@acme.test', 'demo-member');
    const forbidden = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${member.token}`)
      .send({ email: 'x@acme.test', name: 'X', password: 'password-123' });
    expect(forbidden.status).toBe(403);

    const admin = await login('acme', 'admin@acme.test', 'demo-admin');
    const created = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ email: 'newbie@acme.test', name: 'New Bie', password: 'password-123' });
    expect(created.status).toBe(201);
    expect(created.body.user.email).toBe('newbie@acme.test');
  });
});

describe('self-service password change', () => {
  it('requires the current password, so a stolen token cannot take the account over', async () => {
    const admin = await login('acme', 'admin@acme.test', 'demo-admin');
    const created = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ email: 'selfchange@acme.test', name: 'Self Change', password: 'password-111' });
    const userId = created.body.user.id as number;
    const session = await login('acme', 'selfchange@acme.test', 'password-111');

    const noCurrent = await request(app)
      .post(`/api/users/${userId}/password`)
      .set('Authorization', `Bearer ${session.token}`)
      .send({ new_password: 'password-222' });
    expect(noCurrent.status).toBe(422);

    const wrongCurrent = await request(app)
      .post(`/api/users/${userId}/password`)
      .set('Authorization', `Bearer ${session.token}`)
      .send({ current_password: 'not-it', new_password: 'password-222' });
    expect(wrongCurrent.status).toBe(422);
    // The password is unchanged after both attempts.
    expect((await login('acme', 'selfchange@acme.test', 'password-111')).status).toBe(200);

    const ok = await request(app)
      .post(`/api/users/${userId}/password`)
      .set('Authorization', `Bearer ${session.token}`)
      .send({ current_password: 'password-111', new_password: 'password-222' });
    expect(ok.status).toBe(200);
    expect((await login('acme', 'selfchange@acme.test', 'password-222')).status).toBe(200);
  });
});

describe('password reset revokes prior tokens', () => {
  it('invalidates an old token after the password changes', async () => {
    // Seed a dedicated user so other tests are unaffected.
    const admin = await login('acme', 'admin@acme.test', 'demo-admin');
    await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ email: 'rotate@acme.test', name: 'Rotate', password: 'password-111' });

    const before = await login('acme', 'rotate@acme.test', 'password-111');
    expect(before.status).toBe(200);
    const oldToken = before.token;

    const rotateUser = db
      .prepare('SELECT id FROM users WHERE email = ?')
      .get('rotate@acme.test') as { id: number };
    const reset = await request(app)
      .post(`/api/users/${rotateUser.id}/password`)
      .set('Authorization', `Bearer ${admin.token}`)
      .send({ new_password: 'password-222' });
    expect(reset.status).toBe(200);

    // Old token no longer works; new password does.
    const withOld = await request(app).get('/api/me').set('Authorization', `Bearer ${oldToken}`);
    expect(withOld.status).toBe(401);
    expect((await login('acme', 'rotate@acme.test', 'password-222')).status).toBe(200);
  });
});

describe('API keys', () => {
  it('mints a working key and rejects it once revoked', async () => {
    const owner = await login('acme', 'owner@acme.test', 'demo-owner');
    const minted = await request(app)
      .post('/api/api-keys')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'test-key' });
    expect(minted.status).toBe(201);
    const secret: string = minted.body.secret;
    expect(secret.startsWith('psk_')).toBe(true);

    const withKey = await request(app).get('/api/me').set('Authorization', `Bearer ${secret}`);
    expect(withKey.status).toBe(200);
    expect(withKey.body.user).toBeNull(); // machine principal

    const keyId: number = minted.body.api_key.id;
    const revoke = await request(app)
      .delete(`/api/api-keys/${keyId}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(revoke.status).toBe(200);

    const afterRevoke = await request(app).get('/api/me').set('Authorization', `Bearer ${secret}`);
    expect(afterRevoke.status).toBe(401);
  });
});

describe('token verification (cross-service contract)', () => {
  it('round-trips a valid token and rejects a tampered one', async () => {
    const owner = await login('acme', 'owner@acme.test', 'demo-owner');
    const good = await request(app)
      .post('/api/tokens/verify')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ token: owner.token });
    expect(good.status).toBe(200);
    expect(good.body.valid).toBe(true);
    expect(good.body.claims.orgId).toBeGreaterThan(0);

    const tampered = owner.token.slice(0, -1) + (owner.token.endsWith('a') ? 'b' : 'a');
    const bad = await request(app)
      .post('/api/tokens/verify')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ token: tampered });
    expect(bad.body.valid).toBe(false);
  });
});

// ── OAuth (mock IdP + configured provider) ─────────────────────────────

/** Parse the query string of a redirect Location header. */
function locationQuery(location: string): URLSearchParams {
  const qIdx = location.indexOf('?');
  return new URLSearchParams(qIdx >= 0 ? location.slice(qIdx + 1) : '');
}

describe('OAuth authorization-code flow', () => {
  it('rejects an unknown provider', async () => {
    const res = await request(app).get('/api/oauth/nope/authorize?org_slug=acme').redirects(0);
    expect(res.status).toBe(404);
  });

  it('requires org_slug on authorize', async () => {
    const res = await request(app).get('/api/oauth/google/authorize').redirects(0);
    expect(res.status).toBe(422);
  });

  it('completes the mock-IdP flow: authorize → callback → session', async () => {
    const authorize = await request(app).get('/api/oauth/google/authorize?org_slug=acme').redirects(0);
    expect(authorize.status).toBe(302);
    const loc = authorize.headers['location'] as string;
    // Unconfigured provider bounces to our own callback with a mock code.
    expect(loc).toContain('/api/oauth/google/callback');
    const q = locationQuery(loc);
    const state = q.get('state')!;
    const code = q.get('code')!;
    expect(state).toBeTruthy();
    expect(code).toBe(`mock-${state}`);

    const callback = await request(app)
      .get(`/api/oauth/google/callback?state=${state}&code=${code}`)
      .redirects(0);
    expect(callback.status).toBe(200);
    expect(callback.body.token).toBeTruthy();
    expect(callback.body.user.email).toMatch(/^oauth-google-[0-9a-f]+@mock\.local$/);
    // The freshly provisioned user is now a real, verifiable principal.
    const verify = await request(app)
      .post('/api/tokens/verify')
      .set('Authorization', `Bearer ${callback.body.token}`)
      .send({ token: callback.body.token });
    expect(verify.body.valid).toBe(true);
  });

  it('rejects a callback with an unknown/replayed state', async () => {
    const res = await request(app)
      .get('/api/oauth/google/callback?state=deadbeef&code=x')
      .redirects(0);
    expect(res.status).toBe(400);
  });

  it('links the same identity to one user on repeat logins', async () => {
    const first = await request(app).get('/api/oauth/github/authorize?org_slug=acme').redirects(0);
    const q1 = locationQuery(first.headers['location'] as string);
    const cb1 = await request(app)
      .get(`/api/oauth/github/callback?state=${q1.get('state')}&code=${q1.get('code')}`)
      .redirects(0);
    const second = await request(app).get('/api/oauth/github/authorize?org_slug=acme').redirects(0);
    const q2 = locationQuery(second.headers['location'] as string);
    const cb2 = await request(app)
      .get(`/api/oauth/github/callback?state=${q2.get('state')}&code=${q2.get('code')}`)
      .redirects(0);
    // Deterministic mock identity → same email → same user id both times.
    expect(cb2.body.user.email).toBe(cb1.body.user.email);
    expect(cb2.body.user.id).toBe(cb1.body.user.id);
  });

  it('uses a configured provider (real token + userinfo exchange, injected fetch)', async () => {
    const calls: string[] = [];
    const fakeFetch = async (url: string) => {
      calls.push(url);
      if (url.includes('token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'at-123' }), text: async () => '' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ sub: 'g-1', email: 'real.user@example.com', name: 'Real User' }),
        text: async () => '',
      };
    };
    const oauthDb = openDb(':memory:');
    seed(oauthDb);
    const oauthApp = createApp({
      db: oauthDb,
      session,
      oauth: {
        google: {
          clientId: 'cid',
          clientSecret: 'secret',
          authorizeUrl: 'https://idp.example/auth',
          tokenUrl: 'https://idp.example/token',
          userInfoUrl: 'https://idp.example/userinfo',
          scope: 'openid email',
        },
      },
      fetch: fakeFetch,
    });
    const authorize = await request(oauthApp).get('/api/oauth/google/authorize?org_slug=acme').redirects(0);
    const loc = authorize.headers['location'] as string;
    // Configured provider → redirect to the real authorize endpoint.
    expect(loc).toContain('https://idp.example/auth');
    const state = locationQuery(loc).get('state')!;
    const callback = await request(oauthApp)
      .get(`/api/oauth/google/callback?state=${state}&code=auth-code`)
      .redirects(0);
    expect(callback.status).toBe(200);
    expect(callback.body.user.email).toBe('real.user@example.com');
    expect(calls.some((u) => u.includes('/token'))).toBe(true);
    expect(calls.some((u) => u.includes('/userinfo'))).toBe(true);
  });
});

describe('organizations & roles endpoints', () => {
  it('returns the caller org and lists roles', async () => {
    const owner = await login('acme', 'owner@acme.test', 'demo-owner');
    const orgs = await request(app).get('/api/orgs').set('Authorization', `Bearer ${owner.token}`);
    expect(orgs.status).toBe(200);
    expect(orgs.body.organizations[0].slug).toBe('acme');

    const roles = await request(app).get('/api/roles').set('Authorization', `Bearer ${owner.token}`);
    expect(roles.status).toBe(200);
    expect(roles.body.roles.map((r: { key: string }) => r.key)).toContain('member');
  });

  it('assigns and unassigns a role', async () => {
    const owner = await login('acme', 'owner@acme.test', 'demo-owner');
    const members = await request(app).get('/api/users').set('Authorization', `Bearer ${owner.token}`);
    const member = members.body.users.find((u: { email: string }) => u.email === 'member@acme.test');
    const roles = await request(app).get('/api/roles').set('Authorization', `Bearer ${owner.token}`);
    const adminRole = roles.body.roles.find((r: { key: string }) => r.key === 'admin');

    const assign = await request(app)
      .post(`/api/users/${member.id}/roles`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ role_id: adminRole.id });
    expect(assign.status).toBe(200);
    expect(assign.body.roles.map((r: { key: string }) => r.key)).toContain('admin');

    const unassign = await request(app)
      .delete(`/api/users/${member.id}/roles/${adminRole.id}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(unassign.status).toBe(200);
    expect(unassign.body.roles.map((r: { key: string }) => r.key)).not.toContain('admin');
  });
});

describe('scoped API keys & extended verify', () => {
  it('mints a scoped key that only carries its scopes', async () => {
    const owner = await login('acme', 'owner@acme.test', 'demo-owner');
    const minted = await request(app)
      .post('/api/api-keys')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'read-only', scopes: ['user:read', 'org:read'] });
    expect(minted.status).toBe(201);
    const key = minted.body.secret as string;

    // The scoped key can read users…
    expect((await request(app).get('/api/users').set('Authorization', `Bearer ${key}`)).status).toBe(200);
    // …but cannot write them (missing user:write).
    const write = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${key}`)
      .send({ email: 'x@y.zz', name: 'X', password: 'longenough' });
    expect(write.status).toBe(403);

    // Unknown scope is rejected at mint time.
    const bad = await request(app)
      .post('/api/api-keys')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'bad', scopes: ['not-a-perm'] });
    expect(bad.status).toBe(422);
  });

  it('tokens/verify returns permissions for sessions and accepts API keys', async () => {
    const owner = await login('acme', 'owner@acme.test', 'demo-owner');
    const session = await request(app)
      .post('/api/tokens/verify')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ token: owner.token });
    expect(session.body.valid).toBe(true);
    expect(session.body.permissions).toContain('platform:admin'); // owner holds it

    const minted = await request(app)
      .post('/api/api-keys')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ name: 'svc', scopes: ['platform:admin'] });
    const verdict = await request(app)
      .post('/api/tokens/verify')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ token: minted.body.secret });
    expect(verdict.body.valid).toBe(true);
    expect(verdict.body.permissions).toEqual(['platform:admin']);

    const revokedCheck = await request(app)
      .delete(`/api/api-keys/${minted.body.api_key.id}`)
      .set('Authorization', `Bearer ${owner.token}`);
    expect(revokedCheck.status).toBe(200);
    const afterRevoke = await request(app)
      .post('/api/tokens/verify')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ token: minted.body.secret });
    expect(afterRevoke.body.valid).toBe(false); // revocation works end to end
  });
});

describe('schema migrations', () => {
  it('upgrades a legacy (pre-runner) database and is idempotent', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ps01-mig-'));
    const path = join(dir, 'legacy.db');
    try {
      // A v1-shaped database: baseline applied, but before the org_slug and
      // scopes columns existed.
      const legacy = new Database(path);
      legacy.exec(`
        CREATE TABLE oauth_states (id INTEGER PRIMARY KEY AUTOINCREMENT, provider TEXT NOT NULL,
          state TEXT NOT NULL UNIQUE, redirect_uri TEXT, created_at TEXT NOT NULL);
        CREATE TABLE api_keys (id INTEGER PRIMARY KEY AUTOINCREMENT, org_id INTEGER NOT NULL,
          name TEXT NOT NULL, prefix TEXT NOT NULL UNIQUE, key_hash TEXT NOT NULL,
          created_by INTEGER, created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT);
        CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
        INSERT INTO schema_migrations VALUES (1, 'baseline', '2026-01-01T00:00:00Z');
      `);
      legacy.close();

      const upgraded = openDb(path);
      const oauthCols = (upgraded.prepare("PRAGMA table_info('oauth_states')").all() as { name: string }[]).map((c) => c.name);
      const keyCols = (upgraded.prepare("PRAGMA table_info('api_keys')").all() as { name: string }[]).map((c) => c.name);
      expect(oauthCols).toContain('org_slug'); // migration 2 applied
      expect(keyCols).toContain('scopes'); // migration 3 applied
      expect((upgraded.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(5);
      upgraded.close();

      // Re-opening applies nothing further.
      const again = openDb(path);
      expect((again.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number }).n).toBe(5);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
