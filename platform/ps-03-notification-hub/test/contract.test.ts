import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { AuthConfig } from '../server/auth.js';
// Drive the *real* client source against the *real* service over HTTP — the
// one test that catches client↔service drift (see ps-02 contract test).
import { NotificationClient } from '../../clients/src/index.js';

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
  seed(db);
  server = createApp({ db, auth, resendApiKey: null }).listen(0);
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

describe('NotificationClient ↔ PS-03 contract', () => {
  it('sends a message and reads it back through the { message } envelope', async () => {
    const svc = new NotificationClient({ baseUrl, serviceToken: 'test-service' });
    // The seed provisions a 'transactional-email' channel on the console provider.
    const sent = await svc.send({ channel: 'transactional-email', to: 'a@b.test', subject: 'Hi', body: 'hello' });
    expect(sent.message.status).toBeDefined();
    expect(sent.message.id).toBeDefined();

    const admin = new NotificationClient({ baseUrl, serviceToken: 'test-service', identityToken: await adminToken() });
    const fetched = await admin.getMessage(sent.message.id);
    expect(fetched.message.id).toBe(sent.message.id);
    expect(Array.isArray(fetched.events)).toBe(true);
  });
});
