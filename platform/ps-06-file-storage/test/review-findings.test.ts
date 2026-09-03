import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { MAX_SIGN_TTL_SECONDS } from '../server/storage.js';
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

let app: Express;
let db: Database.Database;
const svc = { 'X-Service-Token': 'test-service' };
const NOW = Date.parse('2026-07-01T00:00:00Z');

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, auth, signingSecret: 'sign-secret', now: () => NOW });
  await request(app).post('/api/buckets').set(svc).send({ name: 'docs' }).expect(201);
  await request(app)
    .put('/api/objects/docs/invoice.pdf')
    .set(svc)
    .send({ content_base64: Buffer.from('%PDF-1.4').toString('base64') })
    .expect(201);
});

const sign = (bodyIn: Record<string, unknown>) =>
  request(app).post('/api/objects/docs/invoice.pdf/sign').set(svc).send(bodyIn);

describe('P6-1 · A signed download URL is time-limited, and stays that way', () => {
  it('refuses a TTL beyond the documented ceiling', async () => {
    const res = await sign({ ttl_seconds: MAX_SIGN_TTL_SECONDS + 1 });
    expect(res.status).toBe(422);
    expect((res.body as { details: { field: string }[] }).details[0]?.field).toBe('ttl_seconds');
  });

  it('refuses the three-thousand-year link outright', async () => {
    expect((await sign({ ttl_seconds: 1e11 })).status).toBe(422);
  });

  it('refuses a TTL that is not a representable date, instead of 500ing', async () => {
    for (const ttl of [1e15, 1e308]) {
      const res = await sign({ ttl_seconds: ttl });
      expect(res.status, String(ttl)).toBe(422);
    }
  });

  it('refuses a zero or negative TTL rather than silently making it one second', async () => {
    expect((await sign({ ttl_seconds: 0 })).status).toBe(422);
    expect((await sign({ ttl_seconds: -5 })).status).toBe(422);
  });

  it('still signs at the default, and at the ceiling', async () => {
    const dflt = await sign({});
    expect(dflt.status).toBe(200);
    expect((dflt.body as { expires_at: string }).expires_at).toBe('2026-07-01T00:05:00Z');

    const max = await sign({ ttl_seconds: MAX_SIGN_TTL_SECONDS });
    expect(max.status).toBe(200);
    expect((max.body as { expires_at: string }).expires_at).toBe('2026-07-08T00:00:00Z');
  });

  it('a URL signed at the ceiling still downloads', async () => {
    const signed = await sign({ ttl_seconds: MAX_SIGN_TTL_SECONDS });
    const res = await request(app).get((signed.body as { url: string }).url);
    expect(res.status).toBe(200);
  });
});
