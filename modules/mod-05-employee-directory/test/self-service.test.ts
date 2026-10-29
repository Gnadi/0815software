import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import { createDepartment, createEmployee, offboardEmployee } from '../server/directory.js';
import type { AuditInfo, PlatformHooks } from '../server/platform.js';
import { noopPlatform } from '../server/platform.js';
import type { OwnProfile, ProfileRequest } from '../shared/types.js';

/**
 * Self-service (server/profile.ts): a person keeps their own record current.
 * Phone and emergency contact directly; name and private address through a
 * request HR (`edit`) approves; private data seen only by the person and HR;
 * the history names fields and people, never values.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 'test-secret', ttlHours: 1, secureCookie: false };
const as = (access: AccessLevel, actor: string) => `${COOKIE_NAME}=${createToken(auth, actor, Date.now(), access)}`;
// Anna is staff: she can read the directory (`view`) — and keep her own record.
const ANNA = as('view', 'Anna@Example.com');
const BOB = as('view', 'bob@example.com');
const HR = as('edit', 'hr@example.com');

let db: Database.Database;
let app: Express;
let anna: number;
let audit: AuditInfo[];

beforeEach(() => {
  db = openDb(':memory:');
  audit = [];
  const platform: PlatformHooks = { ...noopPlatform, async audit(info) { audit.push(info); } };
  app = createApp({ db, auth, platform });
  const dept = createDepartment(db, { name: 'Engineering', code: 'ENG', parentId: null });
  const base = { jobTitle: 'Engineer', departmentId: dept, managerId: null, location: 'Vienna', startDate: '2025-01-01' };
  anna = createEmployee(db, { ...base, name: 'Anna Huber', email: 'anna@example.com', phone: '+43 1 111' });
  createEmployee(db, { ...base, name: 'Bob', email: 'bob@example.com', phone: null });
  createEmployee(db, { ...base, name: 'HR Person', email: 'hr@example.com', phone: null });
});

const mine = (cookie = ANNA) => request(app).get('/api/me/profile').set('Cookie', cookie);

describe('what a person changes themselves', () => {
  it('phone, private phone and emergency contact — on their own record only, and the log names fields, not values', async () => {
    const res = (await request(app)
      .put('/api/me/profile')
      .set('Cookie', ANNA)
      .send({ phone: '+43 1 222', private_phone: '+43 664 123', emergency_name: 'Max Huber', emergency_relation: 'Partner', emergency_phone: '+43 664 999' })
      .expect(200)).body as OwnProfile;
    expect(res.employee).toMatchObject({ id: anna, phone: '+43 1 222' });
    expect(res.private).toMatchObject({ private_phone: '+43 664 123', emergency_name: 'Max Huber', updated_by: 'Anna@Example.com' });
    expect(res.changes.map((c) => [c.field, c.via])).toEqual([
      ['emergency_phone', 'self'],
      ['emergency_relation', 'self'],
      ['emergency_name', 'self'],
      ['private_phone', 'self'],
      ['phone', 'self'],
    ]);
    expect(JSON.stringify(db.prepare('SELECT * FROM profile_changes').all())).not.toMatch(/664|Max/);
    expect(audit[0]).toMatchObject({ action: 'employee.profile_updated', metadata: { via: 'self' } });
    expect(JSON.stringify(audit)).not.toMatch(/664|Max/);
    // Nothing changed, nothing logged.
    await request(app).put('/api/me/profile').set('Cookie', ANNA).send({ phone: '+43 1 222' }).expect(200);
    expect((await mine()).body.changes).toHaveLength(5);
  });

  it('name and address are not changed directly; nor are fields that are not theirs; bad numbers are refused', async () => {
    const r = await request(app).put('/api/me/profile').set('Cookie', ANNA).send({ name: 'Anna Berger', job_title: 'CTO', private_phone: 'call me' }).expect(422);
    expect(r.body.details.map((d: { field: string }) => d.field)).toEqual(['name', 'job_title', 'private_phone']);
    expect((await mine()).body.employee.name).toBe('Anna Huber');
  });

  it('a login without a record is told so; an offboarded record is read-only', async () => {
    expect((await mine(as('view', 'stranger@example.com')).expect(404)).body.error).toMatch(/No employee record carries stranger@example.com/);
    offboardEmployee(db, anna);
    await request(app).put('/api/me/profile').set('Cookie', ANNA).send({ phone: '1234' }).expect(409);
    await request(app).post('/api/me/profile/requests').set('Cookie', ANNA).send({ field: 'name', value: 'X' }).expect(409);
  });
});

describe('name and address, through HR', () => {
  const ask = (field: string, value: string, cookie = ANNA) => request(app).post('/api/me/profile/requests').set('Cookie', cookie).send({ field, value, reason: 'Married' });

  it('a request waits for HR, who approves it — then the record changes', async () => {
    const req = (await ask('name', 'Anna Berger').expect(201)).body as ProfileRequest;
    expect(req).toMatchObject({ status: 'pending', current: 'Anna Huber', proposed: 'Anna Berger', requested_by: 'Anna@Example.com' });
    await ask('name', 'Anna Maier').expect(409); // one at a time
    // Colleagues neither see nor decide it; HR does.
    await request(app).get('/api/profile-requests').set('Cookie', BOB).expect(403);
    await request(app).post(`/api/profile-requests/${req.id}/approve`).set('Cookie', BOB).send({}).expect(403);
    const pending = (await request(app).get('/api/profile-requests?status=pending').set('Cookie', HR).expect(200)).body.requests as ProfileRequest[];
    expect(pending.map((p) => p.id)).toEqual([req.id]);
    const done = (await request(app).post(`/api/profile-requests/${req.id}/approve`).set('Cookie', HR).send({}).expect(200)).body as ProfileRequest;
    expect(done).toMatchObject({ status: 'approved', decided_by: 'hr@example.com', current: 'Anna Berger' });
    const after = (await mine()).body as OwnProfile;
    expect(after.employee.name).toBe('Anna Berger');
    expect(after.changes[0]).toMatchObject({ field: 'name', via: 'request', request_id: req.id, actor: 'hr@example.com' });
    await request(app).post(`/api/profile-requests/${req.id}/reject`).set('Cookie', HR).send({ note: 'x' }).expect(409);
  });

  it('a rejection says why; a request can be withdrawn; nobody decides their own', async () => {
    const addr = (await ask('address', 'Hauptplatz 1\n8010 Graz').expect(201)).body as ProfileRequest;
    await request(app).post(`/api/profile-requests/${addr.id}/reject`).set('Cookie', HR).send({}).expect(422);
    await request(app).post(`/api/profile-requests/${addr.id}/reject`).set('Cookie', HR).send({ note: 'Please add the door number' }).expect(200);
    expect((await mine()).body.private.address).toBeNull();
    const again = (await ask('address', 'Hauptplatz 1/4\n8010 Graz').expect(201)).body as ProfileRequest;
    await request(app).post(`/api/me/profile/requests/${again.id}/withdraw`).set('Cookie', BOB).send({}).expect(404);
    expect((await request(app).post(`/api/me/profile/requests/${again.id}/withdraw`).set('Cookie', ANNA).send({}).expect(200)).body.status).toBe('withdrawn');
    // HR's own request goes to another HR person, not to themselves.
    const own = (await ask('name', 'HR P.', HR).expect(201)).body as ProfileRequest;
    expect((await request(app).post(`/api/profile-requests/${own.id}/approve`).set('Cookie', HR).send({}).expect(403)).body.error).toBe('Nobody decides their own change request');
    await request(app).post(`/api/profile-requests/${own.id}/approve`).set('Cookie', as('manage', 'admin')).send({}).expect(200);
  });

  it('the same value is no change; an unknown field is refused', async () => {
    await ask('name', 'Anna Huber').expect(422);
    await ask('job_title', 'CTO').expect(422);
  });
});

describe('private stays private', () => {
  it('colleagues never see it; HR sees, maintains and — when nothing needs it any more — erases it', async () => {
    await request(app).put('/api/me/profile').set('Cookie', ANNA).send({ private_phone: '+43 664 123' }).expect(200);
    await request(app).get(`/api/employees/${anna}/private`).set('Cookie', BOB).expect(403);
    // The directory itself carries none of it.
    expect(JSON.stringify((await request(app).get(`/api/employees/${anna}`).set('Cookie', BOB).expect(200)).body)).not.toMatch(/664/);
    expect((await request(app).get(`/api/employees/${anna}/private`).set('Cookie', HR).expect(200)).body.private.private_phone).toBe('+43 664 123');
    await request(app).put(`/api/employees/${anna}/private`).set('Cookie', BOB).send({ address: 'x' }).expect(403);
    const hr = (await request(app).put(`/api/employees/${anna}/private`).set('Cookie', HR).send({ address: 'Ring 1\n1010 Wien' }).expect(200)).body;
    expect(hr.changes[0]).toMatchObject({ field: 'address', via: 'hr' });
    await request(app).post('/api/me/profile/requests').set('Cookie', ANNA).send({ field: 'address', value: 'Gasse 2' }).expect(201);
    const erased = (await request(app).delete(`/api/employees/${anna}/private`).set('Cookie', HR).expect(200)).body;
    expect(erased.private).toMatchObject({ private_phone: null, address: null });
    expect(erased.changes[0]).toMatchObject({ field: 'private_data', via: 'erased' });
    expect(JSON.stringify(db.prepare('SELECT * FROM profile_requests').all())).not.toMatch(/Gasse/);
  });

  it('/api/me knows who the person is', async () => {
    expect((await request(app).get('/api/me').set('Cookie', ANNA).expect(200)).body).toMatchObject({ employee_id: anna, access: 'view' });
  });
});
