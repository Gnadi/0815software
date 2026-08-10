import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { SessionConfig } from '../server/auth.js';
// Drive the *real* client source against the *real* service over HTTP — the
// one test that catches client↔service drift (see ps-02 contract test).
import { IdentityClient } from '../../clients/src/index.js';

const session: SessionConfig = { secret: 'test-secret', ttlHours: 12, secureCookie: false };

let server: Server;
let baseUrl: string;
let db: Database.Database;

beforeAll(async () => {
  db = openDb(':memory:');
  await seed(db);
  server = createApp({ db, session }).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

describe('IdentityClient ↔ PS-01 contract', () => {
  it('logs in, verifies the token, and reads me + users', async () => {
    const anon = new IdentityClient({ baseUrl });
    const login = await anon.login('acme', 'owner@acme.test', 'demo-owner');
    expect(typeof login.token).toBe('string');

    const verdict = await anon.verify(login.token);
    expect(verdict.valid).toBe(true);

    const asOwner = new IdentityClient({ baseUrl, identityToken: login.token });
    const me = await asOwner.me();
    expect(Array.isArray(me.permissions)).toBe(true);
    expect(me.permissions).toContain('platform:admin');

    const users = await asOwner.listUsers();
    // The owner holds user:read; the seed creates three acme users.
    expect((users as { users: unknown[] }).users.length).toBeGreaterThanOrEqual(3);
  });
});
