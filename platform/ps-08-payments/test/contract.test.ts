import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
// Drive the *real* client source against the *real* service over HTTP — the
// one test that catches client↔service drift (see ps-02 contract test).
import { PaymentsClient } from '../../clients/src/index.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};

let server: Server;
let baseUrl: string;
let db: Database.Database;

beforeAll(async () => {
  db = openDb(':memory:');
  server = createApp({ db, auth, webhookSecret: 'whsec-test' }).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

describe('PaymentsClient ↔ PS-08 contract', () => {
  it('creates + confirms an intent, refunds part of it, and reads the ledger', async () => {
    const pay = new PaymentsClient({ baseUrl, serviceToken: 'test-service' });

    const intent = await pay.createIntent({ reference: 'order:1', amount_minor: 1000, currency: 'EUR', provider: 'mock', confirm: true });
    expect(intent.reference).toBe('order:1');
    expect(intent.public_id).toContain('pi_');

    const fetched = await pay.getIntent(intent.id);
    expect(fetched.id).toBe(intent.id);

    // The mock PSP confirms to `processing`; a tick settles it to captured,
    // which a refund then requires.
    await fetch(`${baseUrl}/api/tick`, { method: 'POST', headers: { 'X-Service-Token': 'test-service' } });

    const refunded = await pay.refund(intent.id, 400);
    expect(refunded.amount_refunded_minor).toBe(400);

    const ledger = await pay.ledger();
    expect(Array.isArray(ledger.ledger)).toBe(true);
  });
});
