/**
 * A principal may administer accounts; it may not seize one that outranks it.
 *
 * `escalation.test.ts` covers the four routes that hand out AUTHORITY —
 * minting a key, defining a role, assigning a role, creating a user. Those are
 * all forms of "grant", and `requireGrantable` caps every one of them at what
 * the caller already holds.
 *
 * This file covers the other half, which had no cap at all: acting ON an
 * account that already holds more than you do. An Administrator deliberately
 * lacks `org:write`, and could reach it by resetting the OWNER's password —
 * `user:write` is the whole authorization for the admin reset path, and the
 * route never looked at whose account it was — and then simply logging in with
 * the password it had just chosen. Four locked doors and an open fifth.
 *
 * The rule is the mirror of `requireGrantable`: you may not take over, disable
 * or erase an account that can do something you cannot. It is expressed as
 * permission containment rather than a role ladder, because a custom role has
 * no rank and an Owner-equivalent custom role must be caught too.
 */
import { beforeEach, describe, expect, it } from 'vitest';
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
    .then((res) => res.body.token as string);

async function idOf(token: string, email: string): Promise<number> {
  const res = await request(app).get('/api/users').set(as(token));
  const user = (res.body.users as { id: number; email: string }[]).find((u) => u.email === email);
  expect(user, `no user ${email}`).toBeDefined();
  return user!.id;
}

describe('an Administrator cannot seize an Owner account', () => {
  it('cannot reset the Owner password — the fifth door to org:write', async () => {
    const admin = await login('admin@acme.test', 'demo-admin');
    const ownerId = await idOf(admin, 'owner@acme.test');

    const reset = await request(app)
      .post(`/api/users/${ownerId}/password`)
      .set(as(admin))
      .send({ new_password: 'admin-chose-this' });
    expect(reset.status).toBe(403);
    expect(reset.body.error).toMatch(/org:write/);

    // And the password really did not change: the Owner still owns the account.
    const stolen = await request(app)
      .post('/api/login')
      .send({ org_slug: 'acme', email: 'owner@acme.test', password: 'admin-chose-this' });
    expect(stolen.status).toBe(401);
    expect(await login('owner@acme.test', 'demo-owner')).toBeTruthy();
  });

  it('cannot disable the Owner', async () => {
    const admin = await login('admin@acme.test', 'demo-admin');
    const ownerId = await idOf(admin, 'owner@acme.test');

    const res = await request(app).patch(`/api/users/${ownerId}`).set(as(admin)).send({ status: 'disabled' });
    expect(res.status).toBe(403);
    expect(await login('owner@acme.test', 'demo-owner')).toBeTruthy();
  });

  it('cannot erase the Owner', async () => {
    const admin = await login('admin@acme.test', 'demo-admin');
    const ownerId = await idOf(admin, 'owner@acme.test');

    const res = await request(app).post(`/api/users/${ownerId}/erase`).set(as(admin)).send({});
    expect(res.status).toBe(403);
    expect(await login('owner@acme.test', 'demo-owner')).toBeTruthy();
  });

  it('cannot reach the Owner through a custom role that has no rank', async () => {
    // A role ladder would not catch this: the target holds a CUSTOM role, so it
    // has no rank at all, and its permissions still exceed the caller's.
    const owner = await login('owner@acme.test', 'demo-owner');
    await request(app)
      .post('/api/roles')
      .set(as(owner))
      .send({ key: 'billing-lead', name: 'Billing Lead', permissions: ['org:read', 'org:write'] })
      .expect(201);
    const created = await request(app)
      .post('/api/users')
      .set(as(owner))
      .send({ email: 'lead@acme.test', name: 'Lea Lead', password: 'lead-password', role_keys: ['billing-lead'] })
      .expect(201);

    const admin = await login('admin@acme.test', 'demo-admin');
    const reset = await request(app)
      .post(`/api/users/${created.body.user.id}/password`)
      .set(as(admin))
      .send({ new_password: 'admin-chose-this' });
    expect(reset.status).toBe(403);
  });

  it('cannot seize an account through a scoped API key either', async () => {
    // The cap reads the PRINCIPAL's permissions, so a key scoped below its
    // creator is capped at the scope, not at whoever minted it.
    const owner = await login('owner@acme.test', 'demo-owner');
    const minted = await request(app)
      .post('/api/api-keys')
      .set(as(owner))
      .send({ name: 'ops', scopes: ['user:read', 'user:write'] })
      .expect(201);
    const ownerId = await idOf(owner, 'owner@acme.test');

    const res = await request(app)
      .post(`/api/users/${ownerId}/password`)
      .set(as(minted.body.secret as string))
      .send({ new_password: 'key-chose-this' });
    expect(res.status).toBe(403);
  });
});

describe('what an Administrator may still do', () => {
  it('resets, disables and erases an account at or below its own authority', async () => {
    const admin = await login('admin@acme.test', 'demo-admin');
    const memberId = await idOf(admin, 'member@acme.test');

    await request(app)
      .post(`/api/users/${memberId}/password`)
      .set(as(admin))
      .send({ new_password: 'reset-by-admin' })
      .expect(200);
    expect(await login('member@acme.test', 'reset-by-admin')).toBeTruthy();

    await request(app).patch(`/api/users/${memberId}`).set(as(admin)).send({ status: 'disabled' }).expect(200);
    await request(app).patch(`/api/users/${memberId}`).set(as(admin)).send({ status: 'active' }).expect(200);
    await request(app).post(`/api/users/${memberId}/erase`).set(as(admin)).send({}).expect(200);
  });

  it('renames an Owner — a rename hands over nothing', async () => {
    const admin = await login('admin@acme.test', 'demo-admin');
    const ownerId = await idOf(admin, 'owner@acme.test');
    const res = await request(app).patch(`/api/users/${ownerId}`).set(as(admin)).send({ name: 'Ada O.' });
    expect(res.status).toBe(200);
    expect(res.body.user.name).toBe('Ada O.');
  });

  it('lets an Owner reset another Owner — equal authority is not "above"', async () => {
    const owner = await login('owner@acme.test', 'demo-owner');
    const second = await request(app)
      .post('/api/users')
      .set(as(owner))
      .send({ email: 'second@acme.test', name: 'Otto Owner', password: 'second-password', role_keys: ['owner'] })
      .expect(201);
    await request(app)
      .post(`/api/users/${second.body.user.id}/password`)
      .set(as(owner))
      .send({ new_password: 'rotated-by-peer' })
      .expect(200);
  });

  it('lets anyone change their OWN password, whatever they hold', async () => {
    const owner = await login('owner@acme.test', 'demo-owner');
    const ownerId = await idOf(owner, 'owner@acme.test');
    await request(app)
      .post(`/api/users/${ownerId}/password`)
      .set(as(owner))
      .send({ current_password: 'demo-owner', new_password: 'chosen-by-owner' })
      .expect(200);
  });
});
