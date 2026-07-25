import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
// Drive the *real* client source against the *real* service over HTTP — the
// one test that catches client↔service drift (see ps-02 contract test).
import { SearchClient } from '../../clients/src/index.js';

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

describe('SearchClient ↔ PS-09 contract', () => {
  it('indexes, searches, and removes a document', async () => {
    const search = new SearchClient({ baseUrl, serviceToken: 'test-service' });

    const ok = await search.index({ collection: 'products', id: 'p1', title: 'Blue widget', body: 'a fine blue widget', facets: { color: 'blue' } });
    expect(ok.indexed).toBe(true);

    const results = await search.search({ collection: 'products', q: 'blue', filters: { color: 'blue' } });
    expect(results.total).toBeGreaterThanOrEqual(1);
    expect(results.hits[0]!.id).toBe('p1');

    const removed = await search.remove('products', 'p1');
    expect(removed.deleted).toBe(true);
  });
});
