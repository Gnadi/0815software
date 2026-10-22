/**
 * Module permissions — `module:<slug>:<level>` — are how a module learns what
 * a person may do in it. PS-01 stores and returns them, and applies its grant
 * caps to them, but never enforces them itself.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { SessionConfig } from '../server/auth.js';
import { holdsPermission, isModulePermission } from '../shared/module-access.js';

const session: SessionConfig = { secret: 'test-secret', ttlHours: 12, secureCookie: false };
const as = (t: string) => ({ Authorization: `Bearer ${t}` });

let app: Express;
let db: Database.Database;

beforeAll(async () => {
  db = openDb(':memory:');
  await seed(db);
  app = createApp({ db, session });
});

const login = async (email: string, password: string): Promise<string> =>
  (await request(app).post('/api/login').send({ org_slug: 'acme', email, password })).body.token as string;

describe('the grammar', () => {
  it('accepts a slug or *, and exactly three levels', () => {
    expect(isModulePermission('module:crm-lite:view')).toBe(true);
    expect(isModulePermission('module:*:manage')).toBe(true);
    for (const bad of ['module:crm-lite:admin', 'module:CRM:view', 'module::view', 'module:a:b:view', 'mod:crm:view', 'module:-x:view']) {
      expect(isModulePermission(bad)).toBe(false);
    }
  });

  it('a higher level, a wildcard and platform:admin each imply the lower grant', () => {
    expect(holdsPermission(new Set(['module:crm-lite:manage']), 'module:crm-lite:view')).toBe(true);
    expect(holdsPermission(new Set(['module:*:edit']), 'module:crm-lite:edit')).toBe(true);
    expect(holdsPermission(new Set(['platform:admin']), 'module:crm-lite:manage')).toBe(true);
    expect(holdsPermission(new Set(['module:crm-lite:view']), 'module:crm-lite:edit')).toBe(false);
    expect(holdsPermission(new Set(['module:offers:manage']), 'module:crm-lite:view')).toBe(false);
    // Implication runs one way only: a module grant never implies a system one.
    expect(holdsPermission(new Set(['module:*:manage']), 'platform:admin')).toBe(false);
  });
});

describe('roles carrying module permissions', () => {
  it('an Administrator can define and assign one, and verify returns it', async () => {
    const admin = await login('admin@acme.test', 'demo-admin');
    const role = await request(app)
      .post('/api/roles')
      .set(as(admin))
      .send({ key: 'inventory-clerk', name: 'Inventory clerk', permissions: ['module:inventory-management:edit'] })
      .expect(201);
    expect(role.body.role.permissions).toEqual(['module:inventory-management:edit']);

    const users = await request(app).get('/api/users').set(as(admin));
    const member = users.body.users.find((u: { email: string }) => u.email === 'member@acme.test');
    await request(app).post(`/api/users/${member.id}/roles`).set(as(admin)).send({ role_id: role.body.role.id }).expect(200);

    const memberToken = await login('member@acme.test', 'demo-member');
    const verdict = await request(app).post('/api/tokens/verify').send({ token: memberToken }).expect(200);
    expect(verdict.body.valid).toBe(true);
    expect(verdict.body.permissions).toContain('module:inventory-management:edit');
    expect(verdict.body.permissions).not.toContain('platform:admin');
  });

  it('rejects a malformed module permission', async () => {
    const admin = await login('admin@acme.test', 'demo-admin');
    const res = await request(app)
      .post('/api/roles')
      .set(as(admin))
      .send({ key: 'bad', name: 'Bad', permissions: ['module:inventory-management:superuser'] });
    expect(res.status).toBe(422);
  });

  it('a principal cannot grant a module level it does not itself hold', async () => {
    // A custom role holding role:write and view on one module — enough to
    // administer roles, not enough to hand out edit.
    const owner = await login('owner@acme.test', 'demo-owner');
    const delegate = await request(app)
      .post('/api/roles')
      .set(as(owner))
      .send({ key: 'crm-lead', name: 'CRM lead', permissions: ['role:read', 'role:write', 'user:read', 'module:crm-lite:view'] })
      .expect(201);
    await request(app)
      .post('/api/users')
      .set(as(owner))
      .send({ email: 'lead@acme.test', name: 'Lead', password: 'lead-password-1', role_keys: [delegate.body.role.key] })
      .expect(201);

    const lead = await login('lead@acme.test', 'lead-password-1');
    const up = await request(app)
      .post('/api/roles')
      .set(as(lead))
      .send({ key: 'crm-editor', name: 'CRM editor', permissions: ['module:crm-lite:edit'] });
    expect(up.status).toBe(403);
    expect(up.body.error).toMatch(/module:crm-lite:edit/);

    await request(app)
      .post('/api/roles')
      .set(as(lead))
      .send({ key: 'crm-reader', name: 'CRM reader', permissions: ['module:crm-lite:view'] })
      .expect(201);
  });

  it('describes the module grammar in the catalogue', async () => {
    const member = await login('member@acme.test', 'demo-member');
    const res = await request(app).get('/api/permissions').set(as(member)).expect(200);
    expect(res.body.module_permissions.levels).toEqual(['view', 'edit', 'manage']);
  });
});
