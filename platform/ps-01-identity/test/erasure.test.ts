import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { SessionConfig } from '../server/auth.js';

const session: SessionConfig = { secret: 'test-secret', ttlHours: 12, secureCookie: false };

let app: Express;
let db: Database.Database;

const as = (t: string) => ({ Authorization: `Bearer ${t}` });
const login = (email: string, password: string) =>
  request(app).post('/api/login').send({ org_slug: 'acme', email, password });

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, session });
});

describe('GDPR erasure', () => {
  it('anonymizes PII, blocks login, and keeps the row for referential integrity', async () => {
    const ownerToken = (await login('owner@acme.test', 'demo-owner').expect(200)).body.token as string;

    // Find the member to erase.
    const users = (await request(app).get('/api/users').set(as(ownerToken)).expect(200)).body.users as {
      id: number;
      email: string;
    }[];
    const member = users.find((u) => u.email === 'member@acme.test')!;
    expect(member).toBeDefined();

    const erased = await request(app).post(`/api/users/${member.id}/erase`).set(as(ownerToken)).expect(200);
    expect(erased.body.erased).toBe(true);
    expect(erased.body.user.email).toBe(`erased+${member.id}@invalid.example`);
    expect(erased.body.user.name).toBe('Erased User');

    // The erased user can no longer authenticate with the old credentials.
    await login('member@acme.test', 'demo-member').expect(401);

    // The row still exists (id preserved) — reads succeed and show anonymized PII.
    const fetched = await request(app).get(`/api/users/${member.id}`).set(as(ownerToken)).expect(200);
    expect(fetched.body.user.name).toBe('Erased User');

    // An erasure was recorded on the audit trail.
    const events = db.prepare("SELECT COUNT(*) AS n FROM auth_events WHERE type = 'user_erased'").get() as { n: number };
    expect(events.n).toBe(1);
  });

  it('requires user:write — a member cannot erase anyone', async () => {
    const memberToken = (await login('member@acme.test', 'demo-member').expect(200)).body.token as string;
    const users = (await request(app).get('/api/users').set(as(memberToken))).body.users as { id: number }[] | undefined;
    // member may not even list users; erase must be forbidden regardless.
    await request(app).post('/api/users/1/erase').set(as(memberToken)).expect(403);
    expect(users === undefined || Array.isArray(users)).toBe(true);
  });
});
