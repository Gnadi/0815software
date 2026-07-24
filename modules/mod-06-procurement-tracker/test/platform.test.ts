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
const line = [{ description: 'Budget line', quantity: 1, unit: 'pc', unit_price_cents: 5000 }];
beforeEach(() => { db = openDb(':memory:'); seed(db); });

describe('PS-07 audit integration', () => {
  it('records an audit event when a PO is submitted', async () => {
    const events: AuditInfo[] = [];
    const app = appWith({ ...noopPlatform, async audit(info) { events.push(info); } });
    const c = await cookie(app);
    const po = await request(app).post('/api/pos').set('Cookie', c).send({ supplier_id: 1, lines: line });
    await request(app).post(`/api/pos/${po.body.id}/submit`).set('Cookie', c).send({}).expect(200);
    await new Promise((r) => setImmediate(r));
    expect(events.map((e) => e.action)).toContain('po.submitted');
  });
  it('is a no-op when unconfigured (standalone)', async () => {
    expect(buildPlatform({})).toBe(noopPlatform);
    const app = createApp({ db, auth });
    const c = await cookie(app);
    const po = await request(app).post('/api/pos').set('Cookie', c).send({ supplier_id: 1, lines: line });
    await request(app).post(`/api/pos/${po.body.id}/submit`).set('Cookie', c).send({}).expect(200);
  });
});
