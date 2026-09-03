/**
 * What happens to the credentials a person leaves behind.
 *
 * Erasure is described — here, in `docs/PII-MAP.md`, and in the response it
 * returns — as ending that person's access: the PII is anonymized, the password
 * is scrambled, `token_version` is bumped so every live session dies, and the
 * account is disabled so it can never log in again.
 *
 * An API key is none of those things. It is verified against its own scrypt
 * hash, checked only for `revoked_at IS NULL`, and carries the permission set
 * its creator held when it was minted — `platform:admin` among them, which is
 * the key to every other Platform Service through the identity seam. So an
 * erased administrator's key kept working, with their authority, after the
 * account that made it had been erased. Every door was locked and the machine
 * credential was still on the mat.
 *
 * A DISABLED account is deliberately different: a suspension is reversible and
 * a service account should not stop mid-pipeline because an operator was
 * suspended for a week. Erasure is terminal, and so is this.
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
    .then((r) => r.body.token as string);

async function idOf(token: string, email: string): Promise<number> {
  const res = await request(app).get('/api/users').set(as(token));
  return (res.body.users as { id: number; email: string }[]).find((u) => u.email === email)!.id;
}

describe('erasing a person takes their machine credentials with it', () => {
  it('revokes every key they minted, and says how many', async () => {
    const owner = await login('owner@acme.test', 'demo-owner');
    const admin = await login('admin@acme.test', 'demo-admin');

    const minted = await request(app).post('/api/api-keys').set(as(admin)).send({ name: 'ci' }).expect(201);
    const secret = minted.body.secret as string;
    // The key works before the erasure, with the administrator's authority.
    await request(app).get('/api/users').set(as(secret)).expect(200);

    const erased = await request(app)
      .post(`/api/users/${await idOf(owner, 'admin@acme.test')}/erase`)
      .set(as(owner))
      .send({})
      .expect(200);
    expect(erased.body.api_keys_revoked).toBe(1);

    // And now it does not.
    await request(app).get('/api/users').set(as(secret)).expect(401);
  });

  it('records the revocation count on the audit trail', async () => {
    const owner = await login('owner@acme.test', 'demo-owner');
    const admin = await login('admin@acme.test', 'demo-admin');
    await request(app).post('/api/api-keys').set(as(admin)).send({ name: 'ci' }).expect(201);

    await request(app)
      .post(`/api/users/${await idOf(owner, 'admin@acme.test')}/erase`)
      .set(as(owner))
      .send({})
      .expect(200);

    const event = db
      .prepare("SELECT meta FROM auth_events WHERE type = 'user_erased' ORDER BY id DESC LIMIT 1")
      .get() as { meta: string };
    expect(JSON.parse(event.meta)).toMatchObject({ api_keys_revoked: 1 });
  });

  it('leaves a key that was already revoked alone', async () => {
    const owner = await login('owner@acme.test', 'demo-owner');
    const admin = await login('admin@acme.test', 'demo-admin');
    const minted = await request(app).post('/api/api-keys').set(as(admin)).send({ name: 'ci' }).expect(201);
    await request(app).delete(`/api/api-keys/${minted.body.api_key.id}`).set(as(owner)).expect(200);

    const erased = await request(app)
      .post(`/api/users/${await idOf(owner, 'admin@acme.test')}/erase`)
      .set(as(owner))
      .send({})
      .expect(200);
    expect(erased.body.api_keys_revoked).toBe(0);
  });

  it('does NOT revoke a key when the account is merely disabled', async () => {
    const owner = await login('owner@acme.test', 'demo-owner');
    const admin = await login('admin@acme.test', 'demo-admin');
    const minted = await request(app).post('/api/api-keys').set(as(admin)).send({ name: 'ci' }).expect(201);

    await request(app)
      .patch(`/api/users/${await idOf(owner, 'admin@acme.test')}`)
      .set(as(owner))
      .send({ status: 'disabled' })
      .expect(200);

    // A suspension is reversible; the pipeline keeps running. Revoking it is
    // one explicit DELETE away, and the list below says which key to pick.
    await request(app).get('/api/users').set(as(minted.body.secret as string)).expect(200);
  });
});

describe('an operator can see whose key a key is', () => {
  it('reports created_by on the list, so a leaver can be traced', async () => {
    const owner = await login('owner@acme.test', 'demo-owner');
    const admin = await login('admin@acme.test', 'demo-admin');
    const adminId = await idOf(owner, 'admin@acme.test');
    await request(app).post('/api/api-keys').set(as(admin)).send({ name: 'ci' }).expect(201);

    const list = await request(app).get('/api/api-keys').set(as(owner)).expect(200);
    const key = (list.body.api_keys as { name: string; created_by: number | null }[]).find((k) => k.name === 'ci');
    expect(key!.created_by).toBe(adminId);
  });

  it('attributes the seeded key too — so erasing its owner revokes it', async () => {
    // The seed mints `acme-ci` as the Owner, which is the honest attribution:
    // that key carries the Owner's authority. It also means erasing the Owner
    // takes the stack's own CI credential with it, which is the right outcome
    // and the reason an operator wants to see `created_by` before erasing.
    const owner = await login('owner@acme.test', 'demo-owner');
    const ownerId = await idOf(owner, 'owner@acme.test');
    const list = await request(app).get('/api/api-keys').set(as(owner)).expect(200);
    const seeded = (list.body.api_keys as { name: string; created_by: number | null }[]).find(
      (k) => k.name === 'acme-ci',
    );
    expect(seeded!.created_by).toBe(ownerId);
  });
});
