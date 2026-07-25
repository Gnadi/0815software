import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { AuthConfig } from '../server/auth.js';
// Drive the *real* client source against the *real* service over HTTP. Unit
// tests inject a fake fetch and so cannot catch client↔service drift (wrong
// path, wrong field name, wrong response envelope); this test can. It stays
// offline and deterministic — everything runs in-process on an ephemeral port.
import { WorkflowClient } from '../../clients/src/index.js';

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
  server = createApp({ db, auth }).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

/** Mint a local admin session token the way a human operator would. */
async function adminToken(): Promise<string> {
  const res = await fetch(`${baseUrl}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'test-pass' }),
  });
  return (await res.json()).token as string;
}

describe('WorkflowClient ↔ PS-02 contract', () => {
  it('runs, reads, advances an instance and emits events end to end', async () => {
    const client = new WorkflowClient({ baseUrl, serviceToken: 'test-service', identityToken: await adminToken() });

    // run() must unwrap the { instance } envelope the service returns.
    const started = await client.run('invoice-approval', { input: { invoice_no: 'INV-1' } });
    expect(started.instance.workflow_key).toBe('invoice-approval');
    expect(typeof started.instance.id).toBe('number');
    expect(Array.isArray(started.instance.allowed_transitions)).toBe(true);

    const fetched = await client.getInstance(started.instance.id);
    expect(fetched.instance.id).toBe(started.instance.id);

    // advance() must send `to_step` (not `step`) — drift the unit test misses.
    const next = fetched.instance.allowed_transitions[0];
    if (next) {
      const advanced = await client.advance(started.instance.id, next);
      expect(advanced.instance.current_step).toBe(next);
    }

    // emit() returns the IngestResult envelope; the seed wires a
    // ticket.created trigger, so at least one workflow matches.
    const result = await client.emit({ type: 'ticket.created', payload: { ref: 'T-1' } });
    expect(result.matched).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(result.instance_ids)).toBe(true);
  });
});
