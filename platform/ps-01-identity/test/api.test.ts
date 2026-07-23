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
