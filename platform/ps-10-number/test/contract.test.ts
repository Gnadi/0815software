import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
// Drive the *real* client source against the *real* service over HTTP — the
// one test that catches client↔service drift (see ps-02 contract test).
import { NumberClient } from '../../clients/src/index.js';

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

describe('NumberClient ↔ PS-10 contract', () => {
  it('configures a scope, then allocates gapless numbers', async () => {
    const numbers = new NumberClient({ baseUrl, serviceToken: 'test-service' });

    const cfg = await numbers.configure('invoice', 'INV-{YYYY}-{seq:0000}', 'year');
    expect(cfg.scope).toBe('invoice');

    const a = await numbers.next('invoice');
    const b = await numbers.next('invoice');
    expect(b.value).toBe(a.value + 1);
    expect(a.formatted).toContain('INV-');

    const state = await numbers.get('invoice');
    expect(state.current.last_value).toBe(b.value);
  });
});
