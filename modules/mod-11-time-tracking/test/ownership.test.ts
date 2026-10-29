import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';

/**
 * "Only my own time" (server/ownership.ts): below `manage`, a person records,
 * corrects and submits time for the employee whose email they signed in with,
 * and nobody else.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 'test-secret', ttlHours: 1, secureCookie: false };

let db: Database.Database;
let app: Express;
let anna: number;
let bob: number;
let project: number;

const as = (access: AccessLevel, actor: string) => `${COOKIE_NAME}=${createToken(auth, actor, Date.now(), access)}`;
// A week the seed never touches: it writes the three weeks before the day it
// runs, so a fixed recent week turned into a seeded (submitted) one as the
// calendar caught up with it.
const WEEK = '2025-03-03';
const entry = (employeeId: number) => ({ employee_id: employeeId, project_id: project, entry_date: WEEK, minutes: 60 });

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
  const id = (email: string) => (db.prepare('SELECT id FROM employees WHERE email = ?').get(email) as { id: number }).id;
  anna = id('anna@0815software.example');
  bob = id('bob@0815software.example');
  project = (db.prepare('SELECT id FROM projects WHERE active = 1 ORDER BY id LIMIT 1').get() as { id: number }).id;
  app = createApp({ db, auth });
});

describe('an editor records only their own time', () => {
  const annaEdits = () => as('edit', 'Anna@0815software.example');

  it('knows who they are, whatever the case of the email', async () => {
    const me = await request(app).get('/api/me').set('Cookie', annaEdits()).expect(200);
    expect(me.body).toMatchObject({ access: 'edit', employee_id: anna });
  });

  it('may write their own entry and nobody else’s', async () => {
    await request(app).post('/api/entries').set('Cookie', annaEdits()).send(entry(anna)).expect(201);
    const other = await request(app).post('/api/entries').set('Cookie', annaEdits()).send(entry(bob)).expect(403);
    expect(other.body.error).toMatch(/your own time/);
  });

  it('may not change or delete someone else’s entry, nor move their own onto someone else', async () => {
    const bobs = await request(app).post('/api/entries').set('Cookie', as('manage', 'office@example')).send(entry(bob)).expect(201);
    await request(app).put(`/api/entries/${bobs.body.id}`).set('Cookie', annaEdits()).send(entry(anna)).expect(403);
    await request(app).delete(`/api/entries/${bobs.body.id}`).set('Cookie', annaEdits()).expect(403);

    const own = await request(app).post('/api/entries').set('Cookie', annaEdits()).send(entry(anna)).expect(201);
    await request(app).put(`/api/entries/${own.body.id}`).set('Cookie', annaEdits()).send(entry(bob)).expect(403);
  });

  it('submits only their own week', async () => {
    await request(app).post('/api/entries').set('Cookie', annaEdits()).send(entry(anna)).expect(201);
    await request(app).post('/api/timesheets/submit').set('Cookie', annaEdits()).send({ employee_id: bob, week_start: WEEK }).expect(403);
    await request(app).post('/api/timesheets/submit').set('Cookie', annaEdits()).send({ employee_id: anna, week_start: WEEK }).expect(200);
  });

  it('is told, not guessed, when no employee carries their email', async () => {
    const res = await request(app).post('/api/entries').set('Cookie', as('edit', 'stranger@example')).send(entry(anna)).expect(403);
    expect(res.body.error).toMatch(/No employee record carries stranger@example/);
  });

  it('leaves people and projects to managers', async () => {
    await request(app).post('/api/employees').set('Cookie', annaEdits()).send({ name: 'New' }).expect(403);
    await request(app).post('/api/projects').set('Cookie', annaEdits()).send({ name: 'New' }).expect(403);
  });
});

describe('a manager corrects anyone’s time', () => {
  it('writes for any employee, without an employee record of their own', async () => {
    await request(app).post('/api/entries').set('Cookie', as('manage', 'office@example')).send(entry(bob)).expect(201);
  });
});
