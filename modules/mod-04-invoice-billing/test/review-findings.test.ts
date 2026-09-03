import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import { ServiceError } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { buildLoginVerifier } from '../server/sso.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';

/**
 * Defects found by the platform-wide review (docs/TEST-PLAN-PLATFORM.md).
 * Each test fails against the code as it was before the fix.
 *
 * The SSO verifier is copy-in and byte-identical across the thirteen modules
 * that delegate their login to PS-01, so the case is pinned once, here.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};
const seller: SellerConfig = {
  name: '0815software GmbH',
  addressLines: ['Beispielgasse 8/15', '1010 Wien', 'Austria'],
  vatId: 'ATU00000000',
  iban: 'AT00 0000 0000 0000 0000',
  bic: 'EXAMPLEX',
};

let db: Database.Database;

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
});

/** A PS-01 that answers every call with one status. */
function identityAnswering(status: number, bodyText = '{"error":"boom"}') {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => bodyText,
  });
}

describe('M-1 · A broken identity service is an outage, not a wrong password', () => {
  const cfg = { identityUrl: 'http://ps01:4001', identityOrg: 'acme' };

  it('reports a PS-01 500 as unavailable', async () => {
    // The client is constructed inside buildLoginVerifier, so the seam is the
    // global fetch it falls back to.
    const original = globalThis.fetch;
    globalThis.fetch = identityAnswering(500) as unknown as typeof fetch;
    try {
      const verify = buildLoginVerifier(cfg);
      expect(await verify('ada@acme.test', 'pw')).toEqual({ ok: false, reason: 'unavailable' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('reports a PS-01 429 (its own login throttle) as unavailable', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = identityAnswering(429, '{"error":"Too many requests"}') as unknown as typeof fetch;
    try {
      const verify = buildLoginVerifier(cfg);
      expect(await verify('ada@acme.test', 'pw')).toEqual({ ok: false, reason: 'unavailable' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('still reports a PS-01 401 as a rejected credential', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = identityAnswering(401, '{"error":"Invalid organization, email or password"}') as unknown as typeof fetch;
    try {
      const verify = buildLoginVerifier(cfg);
      expect(await verify('ada@acme.test', 'wrong')).toEqual({ ok: false, reason: 'rejected' });
    } finally {
      globalThis.fetch = original;
    }
  });

  it('surfaces the outage to the operator as 503, not 401', async () => {
    const app = createApp({
      db,
      auth,
      seller,
      verifyLogin: async () => ({ ok: false, reason: 'unavailable' as const }),
    });
    await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' }).expect(503);
  });
});
