/**
 * `signature_valid` is the operator-facing verdict on a delivery's
 * authenticity. Regression cover for it being reported — and stored — as
 * `true` on providers that carry no signature at all, which made an
 * unauthenticated payload anyone could post indistinguishable from one whose
 * HMAC had actually been checked.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { loadKey } from '../server/crypto.js';
import { REGISTRY, providerEntry } from '../server/provider-registry.js';
import { expectedSignature } from '../server/webhooks.js';
import type { AuthConfig } from '../server/auth.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};
const webhookSecret = 'whsec-test';
const as = (t: string) => ({ Authorization: `Bearer ${t}` });

let db: Database.Database;
let app: Express;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, auth, encryptionKey: loadKey('11'.repeat(32)), webhookSecret });
});

const token = async (): Promise<string> =>
  (await request(app).post('/api/login').send({ username: 'admin', password: 'test-pass' })).body.token as string;

describe('inbound webhook trust', () => {
  it('does not claim a signature was verified when the provider has none', async () => {
    const unsigned = REGISTRY.filter((p) => p.signature_scheme === 'none');
    expect(unsigned.length).toBeGreaterThan(0); // google, microsoft

    for (const entry of unsigned) {
      const res = await request(app)
        .post(`/api/webhooks/${entry.key}`)
        .set('content-type', 'application/json')
        .send(JSON.stringify({ type: 'forged.event' }));
      // Still accepted — a real provider cannot hold this stack's token …
      expect(res.status).toBe(202);
      // … but nothing was verified, and the record must say so.
      expect(res.body.signature_valid).toBe(false);
    }

    const events = await request(app).get('/api/webhook-events').set(as(await token()));
    expect(events.body.webhook_events.every((e: { signature_valid: boolean }) => e.signature_valid === false)).toBe(true);
  });

  it('still reports a genuinely verified HMAC as valid', async () => {
    const entry = providerEntry('github')!;
    const payload = JSON.stringify({ ref: 'refs/heads/main' });
    const res = await request(app)
      .post('/api/webhooks/github')
      .set(entry.signature_header!, expectedSignature(entry, webhookSecret, payload))
      .set('content-type', 'application/json')
      .send(payload);
    expect(res.status).toBe(202);
    expect(res.body.signature_valid).toBe(true);
  });
});
