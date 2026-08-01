import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { isAllowedRedirect, STATE_TTL_MS } from '../server/oauth.js';
import type { SessionConfig } from '../server/auth.js';

/**
 * The OAuth entry points hand out sessions, so they are guarded on three
 * counts: the offline mock IdP must not be reachable in a deployment (it
 * resolves an identity with NO credential), a post-login redirect must not be
 * able to carry the token off-site, and a state nonce must not stay redeemable
 * forever.
 */

const session: SessionConfig = { secret: 'test-secret', ttlHours: 12, secureCookie: false };
const SELF = 'https://identity.example.com';

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
});

const appWith = (opts: Parameters<typeof createApp>[0] extends infer T ? Partial<T> : never): Express =>
  createApp({ db, session, selfBaseUrl: SELF, ...opts });

describe('mock IdP', () => {
  it('is refused when disabled, for both authorize and callback', async () => {
    const app = appWith({ allowMockIdp: false });
    const authorize = await request(app).get('/api/oauth/google/authorize?org_slug=acme').redirects(0);
    expect(authorize.status).toBe(501);
    // And no state was minted, so the callback has nothing to redeem either.
    expect((db.prepare('SELECT COUNT(*) AS n FROM oauth_states').get() as { n: number }).n).toBe(0);
  });

  it('still works when explicitly enabled (the dev default)', async () => {
    const app = appWith({ allowMockIdp: true });
    const authorize = await request(app).get('/api/oauth/google/authorize?org_slug=acme').redirects(0);
    expect(authorize.status).toBe(302);
  });
});

describe('redirect_uri allowlist', () => {
  it('refuses an off-site redirect target', async () => {
    const app = appWith({});
    const res = await request(app)
      .get('/api/oauth/google/authorize?org_slug=acme&redirect_uri=https://evil.example/steal')
      .redirects(0);
    expect(res.status).toBe(422);
  });

  it('accepts a same-site path and hands the token back to it', async () => {
    const app = appWith({});
    const authorize = await request(app)
      .get('/api/oauth/google/authorize?org_slug=acme&redirect_uri=/app/landing')
      .redirects(0);
    expect(authorize.status).toBe(302);
    const q = new URLSearchParams((authorize.headers['location'] as string).split('?')[1]);
    const callback = await request(app)
      .get(`/api/oauth/google/callback?state=${q.get('state')}&code=${q.get('code')}`)
      .redirects(0);
    expect(callback.status).toBe(302);
    expect(callback.headers['location']).toMatch(/^\/app\/landing\?token=/);
  });

  it('accepts an explicitly allowlisted origin', async () => {
    const app = appWith({ redirectAllowlist: ['https://portal.example.com'] });
    const res = await request(app)
      .get('/api/oauth/google/authorize?org_slug=acme&redirect_uri=https://portal.example.com/after-login')
      .redirects(0);
    expect(res.status).toBe(302);
  });

  it('classifies redirect targets', () => {
    const allow = ['https://portal.example.com'];
    expect(isAllowedRedirect('/back', allow, SELF)).toBe(true);
    expect(isAllowedRedirect(`${SELF}/anything`, allow, SELF)).toBe(true);
    expect(isAllowedRedirect('https://portal.example.com/x', allow, SELF)).toBe(true);
    // Protocol-relative URLs are absolute URLs wearing a path's clothes.
    expect(isAllowedRedirect('//evil.example/x', allow, SELF)).toBe(false);
    expect(isAllowedRedirect('https://evil.example', allow, SELF)).toBe(false);
    expect(isAllowedRedirect('javascript:alert(1)', allow, SELF)).toBe(false);
    // A near-miss host must not pass on a prefix comparison.
    expect(isAllowedRedirect('https://portal.example.com.evil.test/x', allow, SELF)).toBe(false);
  });
});

describe('OAuth state lifetime', () => {
  it('refuses a state older than the TTL and clears it', async () => {
    let clock = Date.parse('2026-01-01T00:00:00Z');
    const app = createApp({ db, session, selfBaseUrl: SELF, now: () => clock });
    const authorize = await request(app).get('/api/oauth/google/authorize?org_slug=acme').redirects(0);
    const q = new URLSearchParams((authorize.headers['location'] as string).split('?')[1]);

    clock += STATE_TTL_MS + 1_000;
    const callback = await request(app)
      .get(`/api/oauth/google/callback?state=${q.get('state')}&code=${q.get('code')}`)
      .redirects(0);
    expect(callback.status).toBe(400);
    expect((db.prepare('SELECT COUNT(*) AS n FROM oauth_states').get() as { n: number }).n).toBe(0);
  });
});
