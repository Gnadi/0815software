import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { openSourceDb } from '../server/source-db.js';
import { seedSourceDb, seedMeta } from '../server/seed.js';
import { buildPlatform, noopPlatform, type AuditInfo, type PlatformHooks } from '../server/platform.js';
import type { AuthConfig } from '../server/auth.js';

const auth: AuthConfig = { username: 'admin', password: 'test-password', secret: 'test-secret', ttlHours: 1, secureCookie: false };

let tmp: string;
let db: Database.Database;
let sourceDb: Database.Database;
let exportsDir: string;

function makeApp(platform: PlatformHooks): Express {
  return createApp({ db, sourceDb, auth, exportsDir, platform });
}
async function cookie(app: Express): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mod08-plat-'));
  exportsDir = join(tmp, 'exports');
  const writable = new Database(join(tmp, 'source.db'));
  seedSourceDb(writable);
  writable.close();
  db = openDb(':memory:');
  seedMeta(db, exportsDir);
  sourceDb = openSourceDb(join(tmp, 'source.db'));
});
afterEach(() => {
  sourceDb.close();
  db.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('PS-07 audit integration', () => {
  it('records an audit event when a report is run', async () => {
    const events: AuditInfo[] = [];
    const app = makeApp({ async audit(info) { events.push(info); } });
    const c = await cookie(app);
    const report = await request(app).post('/api/reports').set('Cookie', c).send({ name: 'R', sql: 'SELECT 1 AS n' });
    await request(app).post(`/api/reports/${report.body.id}/run-now`).set('Cookie', c).expect(201);
    await new Promise((r) => setImmediate(r));
    expect(events.map((e) => e.action)).toContain('report.run');
  });

  it('is a no-op when AUDIT_URL is unset (standalone)', async () => {
    expect(buildPlatform({})).toBe(noopPlatform);
    const app = createApp({ db, sourceDb, auth, exportsDir });
    const c = await cookie(app);
    const report = await request(app).post('/api/reports').set('Cookie', c).send({ name: 'R', sql: 'SELECT 1 AS n' });
    await request(app).post(`/api/reports/${report.body.id}/run-now`).set('Cookie', c).expect(201);
  });
});
