import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
// Drive the *real* client source against the *real* service over HTTP — the
// one test that catches client↔service drift (see ps-02 contract test).
import { AuditClient } from '../../clients/src/index.js';

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
  server = createApp({ db, auth }).listen(0);
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

describe('AuditClient ↔ PS-07 contract', () => {
  it('records events, replays an idempotency key, lists, and verifies the chain', async () => {
    const svc = new AuditClient({ baseUrl, serviceToken: 'test-service' });

    const first = await svc.record({ actor: 'user:1', action: 'invoice.paid', resource: 'invoice:7', idempotency_key: 'k-7' });
    expect(first.hash).toBeDefined();
    const replay = await svc.record({ actor: 'user:1', action: 'invoice.paid', resource: 'invoice:7', idempotency_key: 'k-7' });
    expect(replay.id).toBe(first.id);

    const admin = new AuditClient({ baseUrl, serviceToken: 'test-service', identityToken: await adminToken() });
    const listed = await admin.list({ actor: 'user:1' });
    expect(listed.events.length).toBe(1);

    const verdict = await admin.verify();
    expect(verdict.valid).toBe(true);
    expect(verdict.count).toBe(1);
  });
});
