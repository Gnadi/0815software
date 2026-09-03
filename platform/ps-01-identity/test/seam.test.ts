/**
 * `POST /api/tokens/verify` — the cross-service contract.
 *
 * Every other Platform Service authorizes through this one route: PS-02…12 all
 * hand it a credential and act on the verdict, and the twelve modules reach it
 * through their own `sso.ts`. It is public by design (the presented token IS
 * the credential), it is the hottest path in the platform, and until now the
 * only cases on it were the happy ones.
 *
 * What it has to get right is the STATEFUL half: the HMAC proving a token was
 * signed here is not enough, because a signed token stays signed after the
 * account behind it is disabled, erased, or has its password changed. Those are
 * the lines that decide whether revocation actually revokes anything
 * downstream, and they had never been executed.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { createToken, type SessionConfig } from '../server/auth.js';

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

const verify = (token: unknown) => request(app).post('/api/tokens/verify').send({ token });

async function idOf(token: string, email: string): Promise<number> {
  const res = await request(app).get('/api/users').set(as(token));
  return (res.body.users as { id: number; email: string }[]).find((u) => u.email === email)!.id;
}

describe('a session token', () => {
  it('verifies, and reports the claims and permissions a service authorizes on', async () => {
    const token = await login('admin@acme.test', 'demo-admin');
    const res = await verify(token).expect(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.claims).toMatchObject({ orgId: expect.any(Number), userId: expect.any(Number) });
    expect(res.body.permissions).toContain('platform:admin');
    expect(res.body.permissions).not.toContain('org:write'); // an admin, not an owner
  });

  it('stops verifying the moment the account is disabled', async () => {
    const owner = await login('owner@acme.test', 'demo-owner');
    const member = await login('member@acme.test', 'demo-member');
    await verify(member).expect(200).expect((r) => expect(r.body.valid).toBe(true));

    await request(app)
      .patch(`/api/users/${await idOf(owner, 'member@acme.test')}`)
      .set(as(owner))
      .send({ status: 'disabled' })
      .expect(200);

    // Signed by us, unexpired, and worthless — which is the whole point.
    expect((await verify(member)).body).toEqual({ valid: false });
  });

  it('stops verifying the moment the account is erased', async () => {
    const owner = await login('owner@acme.test', 'demo-owner');
    const member = await login('member@acme.test', 'demo-member');
    await request(app)
      .post(`/api/users/${await idOf(owner, 'member@acme.test')}/erase`)
      .set(as(owner))
      .send({})
      .expect(200);
    expect((await verify(member)).body).toEqual({ valid: false });
  });

  it('stops verifying after a password change — token_version is the revocation', async () => {
    const member = await login('member@acme.test', 'demo-member');
    const memberId = (await verify(member)).body.claims.userId as number;
    await request(app)
      .post(`/api/users/${memberId}/password`)
      .set(as(member))
      .send({ current_password: 'demo-member', new_password: 'a-new-password' })
      .expect(200);
    expect((await verify(member)).body).toEqual({ valid: false });
  });

  it('stops verifying after an explicit session revocation', async () => {
    const member = await login('member@acme.test', 'demo-member');
    await request(app).post('/api/me/sessions/revoke').set(as(member)).expect(200);
    expect((await verify(member)).body).toEqual({ valid: false });
  });

  it('does not verify a token for a user id that no longer exists', async () => {
    // Rows are kept on erasure, so this is the belt to that braces: a claim
    // naming a row that is simply gone must not fall through as valid.
    const orphan = createToken(session, { userId: 9_999, orgId: 1, tokenVersion: 1 });
    expect((await verify(orphan)).body).toEqual({ valid: false });
  });

  it('does not verify an expired token', async () => {
    const stale = createToken(session, { userId: 1, orgId: 1, tokenVersion: 1 }, Date.now() - 13 * 3600_000);
    expect((await verify(stale)).body).toEqual({ valid: false });
  });

  it('does not verify a token signed with another secret', async () => {
    const forged = createToken({ ...session, secret: 'not-our-secret' }, { userId: 1, orgId: 1, tokenVersion: 1 });
    expect((await verify(forged)).body).toEqual({ valid: false });
  });
});

describe('an API key', () => {
  it('verifies and reports the full catalogue when it is unscoped', async () => {
    const owner = await login('owner@acme.test', 'demo-owner');
    const minted = await request(app).post('/api/api-keys').set(as(owner)).send({ name: 'ci' }).expect(201);
    const res = await verify(minted.body.secret as string).expect(200);
    expect(res.body.valid).toBe(true);
    expect(res.body.claims).toBeUndefined(); // a machine credential has no user
    expect(res.body.permissions).toContain('org:write');
  });

  it('reports only its own scopes when it has them', async () => {
    const owner = await login('owner@acme.test', 'demo-owner');
    const minted = await request(app)
      .post('/api/api-keys')
      .set(as(owner))
      .send({ name: 'reader', scopes: ['user:read'] })
      .expect(201);
    const res = await verify(minted.body.secret as string).expect(200);
    expect(res.body.permissions).toEqual(['user:read']);
  });

  it('stops verifying once revoked', async () => {
    const owner = await login('owner@acme.test', 'demo-owner');
    const minted = await request(app).post('/api/api-keys').set(as(owner)).send({ name: 'ci' }).expect(201);
    await request(app).delete(`/api/api-keys/${minted.body.api_key.id}`).set(as(owner)).expect(200);
    expect((await verify(minted.body.secret as string)).body).toEqual({ valid: false });
  });

  it('refuses a malformed key without touching the database', async () => {
    for (const bad of ['psk_', 'psk_nodot', 'psk_.secret-with-empty-prefix', 'psk_abc.wrong-secret']) {
      expect((await verify(bad)).body, bad).toEqual({ valid: false });
    }
  });
});

describe('anything that is not a credential', () => {
  it('is refused rather than throwing', async () => {
    for (const bad of [undefined, null, 42, {}, [], '', 'not.a.token.at.all', 'a.b.c.d.e']) {
      const res = await verify(bad);
      expect(res.status, JSON.stringify(bad)).toBe(200);
      expect(res.body, JSON.stringify(bad)).toEqual({ valid: false });
    }
  });

  it('needs no authentication of its own — downstream services call it cold', async () => {
    const res = await request(app).post('/api/tokens/verify').send({ token: 'nonsense' });
    expect(res.status).toBe(200);
  });
});
