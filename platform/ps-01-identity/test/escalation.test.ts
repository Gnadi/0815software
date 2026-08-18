/**
 * A principal may administer grants; it may not invent authority for itself.
 *
 * The Administrator role deliberately stops short of `org:write` — that is the
 * one thing separating it from Owner. Regression cover for the four routes
 * that each handed it over anyway: minting an unscoped API key (which carried
 * the whole permission catalogue regardless of the creator), defining a custom
 * role, assigning an existing higher role, and creating a new user already
 * holding one. Each turned `role:write`, `apikey:write` or `user:write` into a
 * path to Owner.
 */
import { beforeAll, describe, expect, it } from 'vitest';
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

// Seeded once, not per test: `seed()` scrypt-hashes five credentials, and
// re-running it for every case loads the same libuv threadpool that
// event-loop.test.ts measures — the two files run in parallel. No case here
// changes what another case asserts on: the escalation attempts are all
// refused, and the two positive cases touch only the Owner and the Member.
beforeAll(async () => {
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

  /**
   * The fourth door, and the one that had no lock.
   *
   * Assigning the Owner role to an EXISTING user is refused above. Creating a
   * NEW user with it was not — and it is the same grant with a shortcut, since
   * the caller also chooses the password and can therefore log straight in.
   * `POST /api/users` needs `user:write`, which an Administrator holds by
   * design, so this was reachable by exactly the principal the role split
   * exists to hold below `org:write`.
   */
  it('cannot create a user holding a role it could not assign', async () => {
    const t = await adminToken();

    await request(app)
      .post('/api/users')
      .set(as(t))
      .send({
        email: 'backdoor@acme.test',
        name: 'Backdoor',
        password: 'a-password-the-admin-chose',
        role_keys: ['owner'],
      })
      .expect(403);

    // Refused before the INSERT, not cleaned up after it: a created-then-
    // stripped account would still have a password the Administrator knows.
    const users = await request(app).get('/api/users').set(as(t));
    expect(users.body.users.map((u: { email: string }) => u.email)).not.toContain('backdoor@acme.test');

    // And the account cannot be logged into, which is the step that would have
    // turned the row into `org:write`.
    const login = await request(app)
      .post('/api/login')
      .send({ org_slug: 'acme', email: 'backdoor@acme.test', password: 'a-password-the-admin-chose' });
    expect(login.status).toBe(401);
  });

  it('can still create a user at or below its own authority', async () => {
    // The cap is on EXCESS, not on the act — an Administrator managing members
    // is the whole point of the role, and every permission a Member holds is
    // one an Administrator holds too.
    const t = await adminToken();
    await request(app)
      .post('/api/users')
      .set(as(t))
      .send({ email: 'newbie@acme.test', name: 'Newbie', password: 'a-fine-password', role_keys: ['member'] })
      .expect(201);
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

  it('can still grant a user a role it holds itself', async () => {
    const t = await ownerToken();
    const users = await request(app).get('/api/users').set(as(t));
    const member = users.body.users.find((u: { email: string }) => u.email === 'member@acme.test');
    const roles = await request(app).get('/api/roles').set(as(t));
    const viewer = roles.body.roles.find((r: { key: string }) => r.key === 'viewer');
    await request(app).post(`/api/users/${member.id}/roles`).set(as(t)).send({ role_id: viewer.id }).expect(200);
  });
});
