import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { listEvents, recordEvent } from '../server/audit.js';
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

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, auth });
  recordEvent(db, { actor: 'ada', action: 'invoice.issued', resource: 'invoice:1' });
});

async function token(): Promise<string> {
  return (await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' })).body.token as string;
}

describe('P7-1 · A malformed limit is a bad request, not a broken service', () => {
  it('answers 422 rather than 500 for a non-numeric limit', async () => {
    const t = await token();
    const res = await request(app).get('/api/events?limit=abc').set('Authorization', `Bearer ${t}`);
    expect(res.status).toBe(422);
    expect((res.body as { details: { field: string }[] }).details[0]?.field).toBe('limit');
  });

  it('answers 422 for a limit outside the supported range', async () => {
    const t = await token();
    for (const limit of ['0', '-1', '100000', '1.5']) {
      const res = await request(app).get(`/api/events?limit=${limit}`).set('Authorization', `Bearer ${t}`);
      expect(res.status, `limit=${limit}`).toBe(422);
    }
  });

  it('still serves a valid and an absent limit', async () => {
    const t = await token();
    expect((await request(app).get('/api/events?limit=1').set('Authorization', `Bearer ${t}`)).status).toBe(200);
    expect((await request(app).get('/api/events').set('Authorization', `Bearer ${t}`)).status).toBe(200);
    expect((await request(app).get('/api/events?limit=').set('Authorization', `Bearer ${t}`)).status).toBe(200);
  });

  it('does not let a NaN reach SQLite from inside the process either', () => {
    expect(() => listEvents(db, { limit: Number.NaN })).not.toThrow();
    expect(listEvents(db, { limit: Number.NaN })).toHaveLength(1);
  });
});
