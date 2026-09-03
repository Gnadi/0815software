import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { STATE_TTL_MS } from '../server/oauth.js';
import type { AuthConfig } from '../server/auth.js';

/**
 * Defects found by the platform-wide review (docs/TEST-PLAN-PLATFORM.md).
 * Each test fails against the code as it was before the fix.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};

const encKey = Buffer.alloc(32, 7);
const T0 = Date.parse('2026-07-01T00:00:00Z');

let app: Express;
let db: Database.Database;
let clock: number;

beforeEach(() => {
  db = openDb(':memory:');
  clock = T0;
  app = createApp({ db, auth, encryptionKey: encKey, webhookSecret: 'hook-secret', now: () => clock });
});

const states = (): number => (db.prepare('SELECT COUNT(*) AS n FROM oauth_states').get() as { n: number }).n;

async function token(): Promise<string> {
  return (await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' })).body.token as string;
}

async function authorize(): Promise<URLSearchParams> {
  const t = await token();
  const res = await request(app)
    .get('/api/connections/github/authorize')
    .set('Authorization', `Bearer ${t}`)
    .redirects(0);
  expect(res.status).toBe(302);
  return new URLSearchParams((res.headers['location'] as string).split('?')[1]);
}

async function callback(state: string | null, code: string | null) {
  const t = await token();
  return request(app)
    .get(`/api/connections/github/callback?state=${state ?? ''}&code=${code ?? ''}`)
    .set('Authorization', `Bearer ${t}`);
}

describe('P5-1 · An OAuth state nonce stops being redeemable', () => {
  it('refuses a state older than the window', async () => {
    const q = await authorize();
    clock = T0 + STATE_TTL_MS + 1000;
    const res = await callback(q.get('state'), q.get('code'));
    expect(res.status).toBe(400);
  });

  it('still honours one inside the window', async () => {
    const q = await authorize();
    clock = T0 + STATE_TTL_MS - 1000;
    const res = await callback(q.get('state'), q.get('code'));
    expect(res.status).toBe(201);
  });

  it('does not let abandoned authorize attempts accumulate forever', async () => {
    await authorize();
    await authorize();
    await authorize();
    expect(states()).toBe(3);

    // A later callback — for any state at all — clears what has expired.
    clock = T0 + STATE_TTL_MS + 1000;
    await callback('nothing', 'x');
    expect(states()).toBe(0);
  });
});
