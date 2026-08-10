/**
 * A principal may administer grants; it may not invent authority for itself.
 *
 * The Administrator role deliberately stops short of `org:write` — that is the
 * one thing separating it from Owner. Regression cover for the three routes
 * that each handed it over anyway: minting an unscoped API key (which carried
 * the whole permission catalogue regardless of the creator), defining a custom
 * role, and assigning an existing higher role. Each turned `role:write` /
 * `apikey:write` into a path to Owner.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
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

const login = async (email: string, password: string): Promise<string> =>
  (await request(app).post('/api/login').send({ org_slug: 'acme', email, password })).body.token as string;

const adminToken = () => login('admin@acme.test', 'demo-admin');
const ownerToken = () => login('owner@acme.test', 'demo-owner');

describe('an Administrator cannot become an Owner', () => {
  it('cannot mint an API key that outranks itself', async () => {
    const t = await adminToken();
    const mint = await request(app).post('/api/api-keys').set(as(t)).send({ name: 'ci' }).expect(201);

    // The key is capped to the creator's own set …
    const keyPerms = (await request(app).get('/api/me').set(as(mint.body.secret))).body.permissions as string[];
    expect(keyPerms).not.toContain('org:write');
    expect(keyPerms).toContain('platform:admin'); // the admin's own grants survive

    // … so it cannot reach what the creator could not reach.
    await request(app).post('/api/orgs').set(as(mint.body.secret)).send({ slug: 'pwned', name: 'Pwned' }).expect(403);
  });

  it('cannot request a scope it does not hold', async () => {
    const t = await adminToken();
    const res = await request(app).post('/api/api-keys').set(as(t)).send({ name: 'ci', scopes: ['org:write'] });
    expect(res.status).toBe(403);
  });

  it('cannot define a role granting a permission it lacks', async () => {
    const t = await adminToken();
    const res = await request(app)
      .post('/api/roles')
      .set(as(t))
      .send({ key: 'superadmin', name: 'Super', permissions: ['user:read', 'org:write'] });
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/org:write/);
  });

  it('cannot assign itself the Owner role', async () => {
    const t = await adminToken();
    const me = await request(app).get('/api/me').set(as(t));
    const roles = await request(app).get('/api/roles').set(as(t));
    const owner = roles.body.roles.find((r: { key: string }) => r.key === 'owner');

    await request(app).post(`/api/users/${me.body.user.id}/roles`).set(as(t)).send({ role_id: owner.id }).expect(403);

    const after = (await request(app).get('/api/me').set(as(t))).body.permissions as string[];
    expect(after).not.toContain('org:write');
  });
});

describe('an Owner is unaffected', () => {
  it('still mints a fully unscoped key and still delegates every permission', async () => {
    const t = await ownerToken();
    const mint = await request(app).post('/api/api-keys').set(as(t)).send({ name: 'ops' }).expect(201);
    const keyPerms = (await request(app).get('/api/me').set(as(mint.body.secret))).body.permissions as string[];
    expect(keyPerms).toContain('org:write');

    await request(app)
      .post('/api/roles')
      .set(as(t))
      .send({ key: 'delegate', name: 'Delegate', permissions: ['org:write'] })
      .expect(201);
  });

  it('can still grant an Administrator a role it holds itself', async () => {
    const t = await ownerToken();
    const users = await request(app).get('/api/users').set(as(t));
    const admin = users.body.users.find((u: { email: string }) => u.email === 'admin@acme.test');
    const roles = await request(app).get('/api/roles').set(as(t));
    const member = roles.body.roles.find((r: { key: string }) => r.key === 'member');
    await request(app).post(`/api/users/${admin.id}/roles`).set(as(t)).send({ role_id: member.id }).expect(200);
  });
});
