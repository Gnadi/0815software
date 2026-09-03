/**
 * The administrative surface, and the answers nobody had asked for.
 *
 * `api.test.ts` walks the happy paths. This file walks the refusals and the
 * corners beside them — the branches a caller reaches by getting something
 * wrong, which is to say the ones that run in production. Several of these
 * routes had no case at all: `PATCH /api/users/:id`, `GET /api/api-keys`,
 * `GET /api/permissions`, `POST /api/logout`, readiness with a migration
 * outstanding, and the terminal error middleware that decides what a caller
 * sees when something throws that is not a DomainError.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { SessionConfig } from '../server/auth.js';

const session: SessionConfig = { secret: 'test-secret', ttlHours: 12, secureCookie: false };
const as = (t: string) => ({ Authorization: `Bearer ${t}` });

let app: Express;
let db: Database.Database;

beforeEach(async () => {
  db = openDb(':memory:');
  await seed(db);
  app = createApp({ db, session });
});

const login = (email: string, password: string): Promise<string> =>
  request(app)
    .post('/api/login')
    .send({ org_slug: 'acme', email, password })
    .then((r) => r.body.token as string);

const owner = () => login('owner@acme.test', 'demo-owner');

async function idOf(token: string, email: string): Promise<number> {
  const res = await request(app).get('/api/users').set(as(token));
  return (res.body.users as { id: number; email: string }[]).find((u) => u.email === email)!.id;
}

describe('public surface', () => {
  it('logs out by clearing the cookie, whoever asks', async () => {
    const res = await request(app).post('/api/logout').expect(200);
    expect(res.body).toEqual({ ok: true });
    expect(res.headers['set-cookie']![0]).toMatch(/^ps01_session=; /);
    expect(res.headers['set-cookie']![0]).toMatch(/Max-Age=0/);
  });

  it('lists the permission catalogue for an authenticated caller', async () => {
    const t = await owner();
    const res = await request(app).get('/api/permissions').set(as(t)).expect(200);
    expect(res.body.permissions).toContain('platform:admin');
    await request(app).get('/api/permissions').expect(401);
  });

  it('reports itself NOT ready while a migration is outstanding', async () => {
    // What a container looks like in the seconds after an upgrade, and what the
    // generated compose health-check is polling for.
    db.prepare('DELETE FROM schema_migrations WHERE id = (SELECT MAX(id) FROM schema_migrations)').run();
    const res = await request(app).get('/api/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ready: false, pending_migrations: 1 });
  });

  it('reports itself NOT ready when the database is gone', async () => {
    db.close();
    const res = await request(app).get('/api/ready');
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ready: false });
  });

  it('refuses a login missing any of the three fields, before doing any work', async () => {
    for (const body of [
      {},
      { org_slug: 'acme' },
      { org_slug: 'acme', email: 'owner@acme.test' },
      { org_slug: 'acme', password: 'demo-owner' },
      { org_slug: '', email: 'owner@acme.test', password: 'demo-owner' },
      { org_slug: 'acme', email: 'owner@acme.test', password: '' },
    ]) {
      const res = await request(app).post('/api/login').send(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
    // Nothing was recorded against the account: a malformed request is not a
    // failed guess, and must not push a real user towards the backoff.
    expect((db.prepare('SELECT COUNT(*) AS n FROM login_throttle').get() as { n: number }).n).toBe(0);
  });

  it('refuses a login against a suspended organization exactly like a wrong password', async () => {
    db.prepare("UPDATE organizations SET status = 'suspended' WHERE slug = 'acme'").run();
    const res = await request(app)
      .post('/api/login')
      .send({ org_slug: 'acme', email: 'owner@acme.test', password: 'demo-owner' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid organization, email or password');
  });
});

describe('creating an organization', () => {
  it('refuses a slug that is not a slug', async () => {
    const t = await owner();
    for (const slug of ['Not Lower', '-leading-dash', 'has_underscore', 'ümlaut']) {
      const res = await request(app).post('/api/orgs').set(as(t)).send({ slug, name: 'X' });
      expect(res.status, slug).toBe(422);
      expect(res.body.details[0].field).toBe('slug');
    }
  });

  it('refuses a slug that already exists', async () => {
    const t = await owner();
    await request(app).post('/api/orgs').set(as(t)).send({ slug: 'acme', name: 'Again' }).expect(409);
  });

  it('refuses an owner block that is not an object, or whose password is too short', async () => {
    const t = await owner();
    const notObject = await request(app)
      .post('/api/orgs')
      .set(as(t))
      .send({ slug: 'blue', name: 'Blue', owner: 'ada@blue.test' });
    expect(notObject.status).toBe(422);
    expect(notObject.body.details[0].field).toBe('owner');

    const shortPassword = await request(app)
      .post('/api/orgs')
      .set(as(t))
      .send({ slug: 'blue', name: 'Blue', owner: { email: 'ada@blue.test', name: 'Ada', password: 'short' } });
    expect(shortPassword.status).toBe(422);
    expect(shortPassword.body.details[0].field).toBe('owner.password');
  });

  it('creates one with an owner who can then log in', async () => {
    const t = await owner();
    const res = await request(app)
      .post('/api/orgs')
      .set(as(t))
      .send({ slug: 'blue', name: 'Blue', owner: { email: 'ada@blue.test', name: 'Ada', password: 'blue-password' } })
      .expect(201);
    expect(res.body.owner.email).toBe('ada@blue.test');
    expect(res.body.warning).toBeUndefined();

    const login = await request(app)
      .post('/api/login')
      .send({ org_slug: 'blue', email: 'ada@blue.test', password: 'blue-password' });
    expect(login.status).toBe(200);
  });

  it('warns out loud when one is created with nobody in it', async () => {
    const t = await owner();
    const res = await request(app).post('/api/orgs').set(as(t)).send({ slug: 'empty', name: 'Empty' }).expect(201);
    expect(res.body.owner).toBeNull();
    expect(res.body.warning).toMatch(/nobody can log into this organization/);
  });
});

describe('creating and editing a user', () => {
  it('refuses a short password and an address already in use', async () => {
    const t = await owner();
    const short = await request(app)
      .post('/api/users')
      .set(as(t))
      .send({ email: 'new@acme.test', name: 'New', password: 'short' });
    expect(short.status).toBe(422);
    expect(short.body.details[0].field).toBe('password');

    const taken = await request(app)
      .post('/api/users')
      .set(as(t))
      .send({ email: 'member@acme.test', name: 'Dup', password: 'long-enough' });
    expect(taken.status).toBe(422);
    expect(taken.body.details[0].field).toBe('email');
  });

  it('refuses an unknown role key before writing anything', async () => {
    const t = await owner();
    const res = await request(app)
      .post('/api/users')
      .set(as(t))
      .send({ email: 'new@acme.test', name: 'New', password: 'long-enough', role_keys: ['sorcerer'] });
    expect(res.status).toBe(422);
    expect(res.body.details[0].message).toMatch(/unknown role "sorcerer"/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = 'new@acme.test'").get()).toEqual({ n: 0 });
  });

  it('renames without touching the status, and refuses a status that is neither', async () => {
    const t = await owner();
    const id = await idOf(t, 'member@acme.test');

    const renamed = await request(app).patch(`/api/users/${id}`).set(as(t)).send({ name: 'Mona M.' }).expect(200);
    expect(renamed.body.user.name).toBe('Mona M.');
    expect(renamed.body.user.status).toBe('active');

    // A blank name is "leave it alone", not "erase it".
    const blank = await request(app).patch(`/api/users/${id}`).set(as(t)).send({ name: '   ' }).expect(200);
    expect(blank.body.user.name).toBe('Mona M.');

    const bad = await request(app).patch(`/api/users/${id}`).set(as(t)).send({ status: 'paused' });
    expect(bad.status).toBe(422);
    expect(bad.body.details[0].field).toBe('status');
  });

  it('404s on a user from another organization, rather than saying it exists', async () => {
    const t = await owner();
    const globex = db.prepare("SELECT id FROM users WHERE email = 'owner@globex.test'").get() as { id: number };
    await request(app).get(`/api/users/${globex.id}`).set(as(t)).expect(404);
    await request(app).patch(`/api/users/${globex.id}`).set(as(t)).send({ name: 'x' }).expect(404);
    await request(app).post(`/api/users/${globex.id}/erase`).set(as(t)).send({}).expect(404);
    await request(app).get('/api/users/not-a-number').set(as(t)).expect(404);
  });

  it('refuses a new password that is too short, on both paths', async () => {
    const t = await owner();
    const selfId = await idOf(t, 'owner@acme.test');
    const other = await idOf(t, 'member@acme.test');

    const own = await request(app)
      .post(`/api/users/${selfId}/password`)
      .set(as(t))
      .send({ current_password: 'demo-owner', new_password: 'short' });
    expect(own.status).toBe(422);
    expect(own.body.details[0].field).toBe('new_password');

    const reset = await request(app).post(`/api/users/${other}/password`).set(as(t)).send({ new_password: 'short' });
    expect(reset.status).toBe(422);
  });

  it('records a denied self-service password change on the trail', async () => {
    const t = await owner();
    const selfId = await idOf(t, 'owner@acme.test');
    await request(app)
      .post(`/api/users/${selfId}/password`)
      .set(as(t))
      .send({ current_password: 'wrong', new_password: 'long-enough-password' })
      .expect(422);
    const n = db
      .prepare("SELECT COUNT(*) AS n FROM auth_events WHERE type = 'password_change_denied'")
      .get() as { n: number };
    expect(n.n).toBe(1);
  });
});

describe('roles', () => {
  it('refuses an unknown permission and a duplicate key', async () => {
    const t = await owner();
    const unknown = await request(app)
      .post('/api/roles')
      .set(as(t))
      .send({ key: 'ops', name: 'Ops', permissions: ['org:destroy'] });
    expect(unknown.status).toBe(422);
    expect(unknown.body.details[0].message).toMatch(/unknown permission/);

    await request(app)
      .post('/api/roles')
      .set(as(t))
      .send({ key: 'ops', name: 'Ops', permissions: ['org:read'] })
      .expect(201);
    await request(app)
      .post('/api/roles')
      .set(as(t))
      .send({ key: 'ops', name: 'Ops again', permissions: ['org:read'] })
      .expect(409);
  });

  it('refuses an assignment with no role_id, or one from another organization', async () => {
    const t = await owner();
    const id = await idOf(t, 'member@acme.test');

    const missing = await request(app).post(`/api/users/${id}/roles`).set(as(t)).send({});
    expect(missing.status).toBe(422);
    expect(missing.body.details[0].field).toBe('role_id');

    // A custom role belonging to globex is not assignable inside acme.
    db.prepare(
      `INSERT INTO roles (org_id, key, name, is_system, created_at)
       VALUES ((SELECT id FROM organizations WHERE slug = 'globex'), 'theirs', 'Theirs', 0, '2026-01-01T00:00:00Z')`,
    ).run();
    const foreign = db.prepare("SELECT id FROM roles WHERE key = 'theirs'").get() as { id: number };
    await request(app).post(`/api/users/${id}/roles`).set(as(t)).send({ role_id: foreign.id }).expect(404);
  });

  it('unassigns a role, and treats an unparseable role id as not found', async () => {
    const t = await owner();
    const id = await idOf(t, 'member@acme.test');
    const member = db.prepare("SELECT id FROM roles WHERE key = 'member'").get() as { id: number };

    const after = await request(app).delete(`/api/users/${id}/roles/${member.id}`).set(as(t)).expect(200);
    expect(after.body.roles).toEqual([]);
    await request(app).delete(`/api/users/${id}/roles/not-a-number`).set(as(t)).expect(404);
  });
});

describe('API keys', () => {
  it('lists them without ever showing a secret', async () => {
    const t = await owner();
    await request(app).post('/api/api-keys').set(as(t)).send({ name: 'ci' }).expect(201);
    const res = await request(app).get('/api/api-keys').set(as(t)).expect(200);
    expect(res.body.api_keys.length).toBeGreaterThan(0);
    for (const key of res.body.api_keys as Record<string, unknown>[]) {
      expect(key).not.toHaveProperty('key_hash');
      expect(key).not.toHaveProperty('secret');
      expect(key.prefix).toMatch(/^psk_[0-9a-f]{12}$/);
    }
  });

  it('refuses a scope that is not a permission', async () => {
    const t = await owner();
    const res = await request(app).post('/api/api-keys').set(as(t)).send({ name: 'x', scopes: ['org:destroy'] });
    expect(res.status).toBe(422);
    expect(res.body.details[0].field).toBe('scopes');
  });

  it('revokes once and stays idempotent, and 404s on another organization key', async () => {
    const t = await owner();
    const minted = await request(app).post('/api/api-keys').set(as(t)).send({ name: 'ci' }).expect(201);
    await request(app).delete(`/api/api-keys/${minted.body.api_key.id}`).set(as(t)).expect(200);
    // A second delete is a no-op, not a second audit entry.
    await request(app).delete(`/api/api-keys/${minted.body.api_key.id}`).set(as(t)).expect(200);
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM auth_events WHERE type = 'apikey_revoked'").get() as { n: number }).n,
    ).toBe(1);

    await request(app).delete('/api/api-keys/9999').set(as(t)).expect(404);
    await request(app).delete('/api/api-keys/not-a-number').set(as(t)).expect(404);
  });

  it('refuses a key that is presented but invalid, rather than falling through to the cookie', async () => {
    const res = await request(app).get('/api/users').set(as('psk_deadbeefcafe.not-the-secret'));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid API key');
  });
});

describe('the terminal error middleware', () => {
  it('answers 500 and says nothing else when something unexpected throws', async () => {
    // A configured provider whose token exchange throws: the failure reaches
    // `next` as a plain Error, not a DomainError.
    const boom = createApp({
      db,
      session,
      oauth: {
        google: {
          clientId: 'id',
          clientSecret: 'secret',
          authorizeUrl: 'https://accounts.example/auth',
          tokenUrl: 'https://accounts.example/token',
          userInfoUrl: 'https://accounts.example/me',
          scope: 'openid',
        },
      },
      fetch: () => Promise.reject(new Error('the provider is on fire')),
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const authorize = await request(boom).get('/api/oauth/google/authorize?org_slug=acme').redirects(0);
    const state = new URLSearchParams((authorize.headers['location'] as string).split('?')[1]).get('state');
    // The provider is real here, so the callback needs a code of its own.
    const res = await request(boom).get(`/api/oauth/google/callback?state=${state}&code=whatever`).redirects(0);

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: 'Internal server error' });
    // The detail went to the log, not to the caller.
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
