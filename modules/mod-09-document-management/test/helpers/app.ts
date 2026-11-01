import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import type { Express } from 'express';
import type { Database } from 'better-sqlite3';
import type { MatterSummary } from '../../shared/types.js';
import { createApp, type AppOptions } from '../../server/app.js';
import type { SessionConfig } from '../../server/auth.js';
import { openDb } from '../../server/db.js';
import { seed } from '../../server/seed.js';

/** A seeded module on a fresh database, with a clock the test controls. */
export interface TestModule {
  app: Express;
  db: Database;
  storageDir: string;
  clock: { now: number };
  login(username: string): Promise<string>;
  matter(cookie: string, key: string): Promise<MatterSummary>;
  upload(cookie: string, matterId: number, bytes: Buffer, title: string, filename: string, contentType?: string): Promise<request.Response>;
}

export const session: SessionConfig = { secret: 'test-secret', ttlHours: 1, secureCookie: false };

const PASSWORDS: Record<string, string> = { admin: 'demo-admin', mara: 'demo-mara', theo: 'demo-theo', iris: 'demo-iris' };

export async function testModule(options: Partial<AppOptions> = {}, start = Date.parse('2026-11-01T10:00:00Z')): Promise<TestModule> {
  const storageDir = mkdtempSync(join(tmpdir(), 'mod09-'));
  const db = openDb(':memory:');
  await seed(db, storageDir);
  const clock = { now: start };
  const app = createApp({ db, session, storageDir, maxUploadBytes: 4 * 1024 * 1024, now: () => clock.now, ...options });
  return {
    app,
    db,
    storageDir,
    clock,
    async login(username) {
      const res = await request(app).post('/api/login').send({ username, password: PASSWORDS[username] });
      if (res.status !== 200) throw new Error(`login ${username}: ${res.status}`);
      return res.headers['set-cookie']![0]!.split(';')[0]!;
    },
    async matter(cookie, key) {
      const res = await request(app).get('/api/matters').set('Cookie', cookie);
      const found = (res.body.matters as MatterSummary[]).find((m) => m.key === key);
      if (!found) throw new Error(`${key} not visible`);
      return found;
    },
    upload(cookie, matterId, bytes, title, filename, contentType = 'application/octet-stream') {
      return request(app)
        .post(`/api/matters/${matterId}/documents?title=${encodeURIComponent(title)}&filename=${encodeURIComponent(filename)}`)
        .set('Cookie', cookie)
        .set('Content-Type', contentType)
        .send(bytes);
    },
  };
}

/** Collect a binary response body (supertest leaves unknown types unparsed). */
export const binary = (req: request.Test): request.Test =>
  req.buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });
