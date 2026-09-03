import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { createParty, listParties } from '../server/parties.js';
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
  createParty(db, {
    name: 'ACME GmbH',
    kind: 'customer',
    contact_person: null,
    email: null,
    vat_id: null,
    address_lines: undefined,
    iban: null,
    bic: null,
  });
});

describe('P11-1 · A malformed limit is a bad request, not a broken service', () => {
  it('answers 422 rather than 500', async () => {
    for (const qs of ['limit=abc', 'limit=0', 'limit=501', 'limit=-1', 'limit=1.5']) {
      const res = await request(app).get(`/api/parties?${qs}`).set(svc);
      expect(res.status, qs).toBe(422);
    }
  });

  it('still serves valid and absent paging', async () => {
    for (const qs of ['', 'limit=10', 'limit=']) {
      const res = await request(app).get(`/api/parties?${qs}`).set(svc);
      expect(res.status, qs).toBe(200);
    }
  });

  it('does not let a NaN reach SQLite from inside the process either', () => {
    expect(() => listParties(db, { limit: Number.NaN })).not.toThrow();
    expect(listParties(db, { limit: Number.NaN })).toHaveLength(1);
  });
});
