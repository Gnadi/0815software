import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { indexDoc, search } from '../server/search.js';
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

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, auth });
  indexDoc(db, { collection: 'invoices', id: '1', title: 'Invoice for Acme', body: 'paid' });
});

describe('P9-1 · A malformed limit or offset is a bad request, not a broken service', () => {
  it('answers 422 rather than 500', async () => {
    for (const qs of ['limit=abc', 'offset=abc', 'limit=0', 'limit=1000', 'offset=-1', 'limit=2.5']) {
      const res = await request(app).get(`/api/search?collection=invoices&q=acme&${qs}`).set(svc);
      expect(res.status, qs).toBe(422);
    }
  });

  it('still serves valid and absent paging', async () => {
    for (const qs of ['', 'limit=5', 'limit=5&offset=0', 'limit=']) {
      const res = await request(app).get(`/api/search?collection=invoices&q=acme&${qs}`).set(svc);
      expect(res.status, qs).toBe(200);
    }
  });

  it('does not let a NaN reach SQLite from inside the process either', () => {
    expect(() => search(db, { collection: 'invoices', q: 'acme', limit: Number.NaN })).not.toThrow();
    expect(search(db, { collection: 'invoices', q: 'acme', offset: Number.NaN }).hits).toHaveLength(1);
  });
});
