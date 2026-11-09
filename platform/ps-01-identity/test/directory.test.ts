import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';

let app: Express;

beforeAll(async () => {
  const db = openDb(':memory:');
  await seed(db);
  app = createApp({ db, session: { secret: 's', ttlHours: 1, secureCookie: false }, serviceToken: 'stack-token' });
  const owner = (await request(app).post('/api/login').send({ org_slug: 'acme', email: 'owner@acme.test', password: 'demo-owner' })).body.token;
  const role = await request(app)
    .post('/api/roles')
    .set('Authorization', `Bearer ${owner}`)
    .send({ key: 'buyer', name: 'Buyer', permissions: ['module:procurement:manage'] });
  const member = (await request(app).get('/api/users').set('Authorization', `Bearer ${owner}`)).body.users.find(
    (u: { email: string }) => u.email === 'member@acme.test',
  );
  await request(app).post(`/api/users/${member.id}/roles`).set('Authorization', `Bearer ${owner}`).send({ role_id: role.body.role.id });
});

const holders = (permission: string, token = 'stack-token') =>
  request(app).get(`/api/directory/holders?org_slug=acme&permission=${encodeURIComponent(permission)}`).set('X-Service-Token', token);

describe('who holds a permission', () => {
  it('needs the stack’s service token', async () => {
    expect((await request(app).get('/api/directory/holders?org_slug=acme&permission=module:procurement:manage')).status).toBe(401);
    expect((await holders('module:procurement:manage', 'wrong')).status).toBe(403);
  });

  it('applies the implications: platform:admin and the granted level both count', async () => {
    const res = await holders('module:procurement:manage');
    expect(res.status).toBe(200);
    // owner and admin hold platform:admin; the member holds the grant itself.
    expect(res.body.holders).toEqual(['admin@acme.test', 'member@acme.test', 'owner@acme.test']);
    // manage implies edit and view.
    expect((await holders('module:procurement:view')).body.holders).toContain('member@acme.test');
    // A grant on one module is not a grant on another.
    expect((await holders('module:offers:manage')).body.holders).not.toContain('member@acme.test');
  });

  it('refuses what is not a permission and an unknown organization', async () => {
    expect((await holders('anything')).status).toBe(422);
    expect((await request(app).get('/api/directory/holders?org_slug=nope&permission=module:x:view').set('X-Service-Token', 'stack-token')).status).toBe(404);
  });
});
