import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { loadKey } from '../server/crypto.js';
import type { AuthConfig } from '../server/auth.js';
// Drive the *real* client source against the *real* service over HTTP — the
// one test that catches client↔service drift (see ps-02 contract test).
import { IntegrationClient } from '../../clients/src/index.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};
const encKey = loadKey('11'.repeat(32));

let server: Server;
let baseUrl: string;
let db: Database.Database;

beforeAll(async () => {
  db = openDb(':memory:');
  seed(db, encKey);
  server = createApp({ db, auth, encryptionKey: encKey, webhookSecret: 'whsec-test' }).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

async function adminToken(): Promise<string> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pass' }),
  });
  return (await res.json()).token as string;
}

describe('IntegrationClient ↔ PS-05 contract', () => {
  it('lists connections and enqueues a sync job (both admin-gated)', async () => {
    const client = new IntegrationClient({ baseUrl, identityToken: await adminToken() });

    const listed = await client.listConnections();
    expect(listed.connections.length).toBeGreaterThanOrEqual(1);

    // sync() must read the { sync_job } envelope, not a flat { id, status }.
    const job = await client.sync(1, 'pull');
    expect(job.sync_job.connection_id).toBe(1);
    expect(job.sync_job.status).toBeDefined();
  });
});
