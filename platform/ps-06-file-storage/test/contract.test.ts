import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
// Drive the *real* client source against the *real* service over HTTP — the
// one test that catches client↔service drift (see ps-02 contract test).
import { FilesClient } from '../../clients/src/index.js';

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
  server = createApp({ db, auth, signingSecret: 'sign-secret' }).listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
  db.close();
});

describe('FilesClient ↔ PS-06 contract', () => {
  it('creates a bucket, stores, reads, stats, signs, and removes an object', async () => {
    const files = new FilesClient({ baseUrl, serviceToken: 'test-service' });

    const bucket = await files.createBucket('docs');
    expect(bucket.name).toBe('docs');

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const put = await files.put('docs', 'a.bin', bytes, { content_type: 'application/octet-stream' });
    expect(put.size).toBe(4);
    expect(put.sha256).toBeDefined();

    const got = await files.get('docs', 'a.bin');
    expect(Buffer.from(got.content_base64, 'base64')).toEqual(Buffer.from(bytes));

    const stat = await files.stat('docs', 'a.bin');
    expect(stat.key).toBe('a.bin');

    const signed = await files.signUrl('docs', 'a.bin', 60);
    expect(signed.url).toContain('/api/download?');
    expect(signed.url).toContain('bucket=docs');

    const removed = await files.remove('docs', 'a.bin');
    expect(removed.deleted).toBe(true);
  });
});
