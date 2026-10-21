import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import { moduleSummary } from '../server/summary.js';
import { validateSummary } from '../shared/summary.js';

/**
 * The example domain, end to end through the real app. Replace these cases
 * with the module's own — but keep the two kinds: what the domain guarantees,
 * and who may do what (proven against real routes, not only the policy).
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

let db: Database.Database;
let app: Express;

/** A session for `actor` at `access`, as an SSO login would mint it. */
const as = (access: AccessLevel, actor = 'ada@example') =>
  `${COOKIE_NAME}=${createToken(auth, actor, Date.now(), access)}`;

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth });
});

describe('signing in', () => {
  it('the local admin signs in and manages', async () => {
    const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' }).expect(200);
    expect(res.body).toEqual({ ok: true, username: 'admin', access: 'manage' });
    const me = await request(app).get('/api/me').set('Cookie', res.headers['set-cookie'] as unknown as string[]).expect(200);
    expect(me.body).toEqual({ username: 'admin', access: 'manage' });
  });

  it('a wrong password is a 401 and sets no cookie', async () => {
    const res = await request(app).post('/api/login').send({ username: 'admin', password: 'nope' }).expect(401);
    expect(res.headers['set-cookie']).toBeUndefined();
  });
});

describe('items', () => {
  it('records who did what, append-only', async () => {
    const created = await request(app).post('/api/items').set('Cookie', as('edit')).send({ title: 'Ship it' }).expect(201);
    await request(app).post(`/api/items/${created.body.id}/status`).set('Cookie', as('edit', 'bob@example')).send({ status: 'done' }).expect(200);

    const detail = await request(app).get(`/api/items/${created.body.id}`).set('Cookie', as('view')).expect(200);
    expect(detail.body.item.status).toBe('done');
    expect(detail.body.history.map((e: { type: string; actor: string }) => [e.type, e.actor])).toEqual([
      ['created', 'ada@example'],
      ['status:done', 'bob@example'],
    ]);
  });

  it('refuses an invalid item with field errors', async () => {
    const res = await request(app).post('/api/items').set('Cookie', as('edit')).send({ title: '  ' }).expect(422);
    expect(res.body.details).toEqual([{ field: 'title', message: expect.any(String) }]);
  });

  it('an archived item cannot be changed or reopened', async () => {
    const created = await request(app).post('/api/items').set('Cookie', as('manage')).send({ title: 'Old' }).expect(201);
    await request(app).post(`/api/items/${created.body.id}/archive`).set('Cookie', as('manage')).expect(200);
    await request(app).put(`/api/items/${created.body.id}`).set('Cookie', as('manage')).send({ title: 'New' }).expect(409);
    await request(app).post(`/api/items/${created.body.id}/status`).set('Cookie', as('manage')).send({ status: 'open' }).expect(409);
  });
});

describe('who may do what, on the real routes', () => {
  it('view reads and changes nothing', async () => {
    await request(app).get('/api/items').set('Cookie', as('view')).expect(200);
    await request(app).post('/api/items').set('Cookie', as('view')).send({ title: 'x' }).expect(403);
    await request(app).delete('/api/items/1').set('Cookie', as('view')).expect(403);
  });

  it('edit does the daily work but cannot archive', async () => {
    await request(app).post('/api/items').set('Cookie', as('edit')).send({ title: 'x' }).expect(201);
    await request(app).post('/api/items/1/archive').set('Cookie', as('edit')).expect(403);
  });

  it('manage archives', async () => {
    await request(app).post('/api/items/1/archive').set('Cookie', as('manage')).expect(200);
  });
});

describe('the shell summary', () => {
  it('satisfies the shell contract', () => {
    expect(validateSummary(moduleSummary(db))).toEqual([]);
  });
});
