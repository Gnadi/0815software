import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildPlatform, noopPlatform, type AuditInfo, type PlatformHooks } from '../server/platform.js';
import type { AuthConfig } from '../server/auth.js';

const auth: AuthConfig = { username: 'admin', password: 'test-password', secret: 'test-secret', ttlHours: 1, secureCookie: false };

let db: Database.Database;
const appWith = (platform: PlatformHooks): Express => createApp({ db, auth, platform });
async function cookie(app: Express): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
});

describe('PS-07 audit integration', () => {
  it('records an audit event when a product is created', async () => {
    const events: AuditInfo[] = [];
    const app = appWith({ async audit(info) { events.push(info); } });
    const c = await cookie(app);
    await request(app)
      .post('/api/products')
      .set('Cookie', c)
      .send({ sku: 'TS-9001', name: 'Test Widget', unit: 'pcs', reorder_point: 4 })
      .expect(201);
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe('product.created');
  });

  it('is a no-op when AUDIT_URL is unset (standalone)', async () => {
    expect(buildPlatform({})).toBe(noopPlatform);
    const app = createApp({ db, auth });
    const c = await cookie(app);
    await request(app).post('/api/products').set('Cookie', c).send({ sku: 'TS-1', name: 'W', unit: 'pcs', reorder_point: 1 }).expect(201);
  });
});
