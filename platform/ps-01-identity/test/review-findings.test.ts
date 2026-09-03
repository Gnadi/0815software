import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { SessionConfig } from '../server/auth.js';

/**
 * Defects found by the platform-wide review (docs/TEST-PLAN-PLATFORM.md).
 * Each test fails against the code as it was before the fix.
 */

const session: SessionConfig = { secret: 'test-secret', ttlHours: 12, secureCookie: false };
const SELF = 'https://identity.example.com';

let db: Database.Database;
let app: Express;

beforeEach(async () => {
  db = openDb(':memory:');
  await seed(db);
  app = createApp({ db, session, selfBaseUrl: SELF });
});

/** Drive the offline mock IdP end to end and return the callback response. */
async function oauthLogin(orgSlug = 'acme') {
  const authorize = await request(app).get(`/api/oauth/google/authorize?org_slug=${orgSlug}`).redirects(0);
  const q = new URLSearchParams((authorize.headers['location'] as string).split('?')[1]);
  return request(app).get(`/api/oauth/google/callback?state=${q.get('state')}&code=${q.get('code')}`).redirects(0);
}

describe('P1-1 · OAuth never signs in an account that may not sign in', () => {
  it('refuses a linked user who has been disabled', async () => {
    const first = await oauthLogin();
    expect(first.status).toBe(200);
    const email = (first.body as { user: { email: string } }).user.email;

    db.prepare("UPDATE users SET status = 'disabled' WHERE email = ?").run(email);

    const second = await oauthLogin();
    expect(second.status).toBe(403);
    expect(second.body).not.toHaveProperty('token');
    // And the trail must not claim the sign-in succeeded.
    const types = (db.prepare('SELECT type FROM auth_events ORDER BY id').all() as { type: string }[]).map((r) => r.type);
    expect(types.filter((t) => t === 'login_ok')).toHaveLength(1);
    expect(types).toContain('login_fail');
  });

  it('refuses an erased user rather than re-linking them', async () => {
    const first = await oauthLogin();
    const email = (first.body as { user: { email: string } }).user.email;
    const id = (db.prepare('SELECT id FROM users WHERE email = ?').get(email) as { id: number }).id;
    // Erasure renames the address, so the mock identity would otherwise create
    // a fresh account under the old one — which is the account coming back.
    db.prepare("UPDATE users SET status = 'disabled', email = ? WHERE id = ?").run(`erased+${id}@invalid.example`, id);

    const second = await oauthLogin();
    // A brand-new account for the same subject is acceptable; a session for
    // the disabled row is not.
    if (second.status === 200) {
      const user = (second.body as { user: { id: number; status: string } }).user;
      expect(user.id).not.toBe(id);
      expect(user.status).toBe('active');
    } else {
      expect(second.status).toBe(403);
    }
  });

  it('does not hand a token to the redirect target for a disabled user', async () => {
    const first = await oauthLogin();
    const email = (first.body as { user: { email: string } }).user.email;
    db.prepare("UPDATE users SET status = 'disabled' WHERE email = ?").run(email);

    const authorize = await request(app)
      .get('/api/oauth/google/authorize?org_slug=acme&redirect_uri=/app/landing')
      .redirects(0);
    const q = new URLSearchParams((authorize.headers['location'] as string).split('?')[1]);
    const callback = await request(app)
      .get(`/api/oauth/google/callback?state=${q.get('state')}&code=${q.get('code')}`)
      .redirects(0);
    expect(callback.status).toBe(403);
    expect(callback.headers['location']).toBeUndefined();
  });
});

describe('P1-2 · A subject export stays inside the caller organization', () => {
  it('does not report another organization failed logins', async () => {
    // Two orgs; the seed provides `acme`. Add a second one directly.
    db.prepare(`INSERT INTO organizations (slug, name, status, created_at) VALUES ('other2', 'Other', 'active', '2026-01-01T00:00:00Z')`).run();

    // A failed login against `other` for an address that has no account there.
    await request(app).post('/api/login').send({ org_slug: 'other2', email: 'victim@example.com', password: 'nope' });

    const login = await request(app).post('/api/login').send({ org_slug: 'acme', email: 'owner@acme.test', password: 'demo-owner' });
    expect(login.status).toBe(200);
    const token = (login.body as { token: string }).token;

    const res = await request(app)
      .get('/api/export?subject=victim@example.com')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    // The acme administrator holds nothing about this person.
    expect((res.body as { records: Record<string, unknown[]> }).records).toEqual({});
  });
});
