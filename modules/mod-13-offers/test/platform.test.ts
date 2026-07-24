import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildPlatform, noopPlatform, type AuditInfo, type NotifyInfo, type PlatformHooks } from '../server/platform.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';

const auth: AuthConfig = { username: 'admin', password: 'test-password', secret: 'test-secret', ttlHours: 1, secureCookie: false };
const seller: SellerConfig = { name: '0815', addressLines: ['A'], vatId: 'ATU0', email: 'o@x.at' };
let db: Database.Database;
const appWith = (platform: PlatformHooks): Express => createApp({ db, auth, seller, publicBaseUrl: 'http://shop.test', platform });
async function cookie(app: Express): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}
const offer = { customer_id: 1, title: 'Test offer', valid_until: '2026-12-31', lines: [{ description: 'Svc', quantity: 1, unit_price_cents: 10000, vat_rate: 20 }] };
beforeEach(() => { db = openDb(':memory:'); seed(db); });

describe('platform integration on offer send', () => {
  it('audits the send and emails the customer the acceptance link', async () => {
    const audits: AuditInfo[] = []; const notes: NotifyInfo[] = [];
    const app = appWith({ async audit(i) { audits.push(i); }, async notify(i) { notes.push(i); } });
    const c = await cookie(app);
    const created = await request(app).post('/api/offers').set('Cookie', c).send(offer);
    await request(app).post(`/api/offers/${created.body.id}/send`).set('Cookie', c).send({}).expect(200);
    await new Promise((r) => setImmediate(r));
    expect(audits.map((e) => e.action)).toContain('offer.sent');
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain('http://shop.test'); // acceptance link
  });
  it('is a no-op when unconfigured (standalone)', async () => {
    expect(buildPlatform({})).toBe(noopPlatform);
    const app = createApp({ db, auth, seller });
    const c = await cookie(app);
    const created = await request(app).post('/api/offers').set('Cookie', c).send(offer);
    await request(app).post(`/api/offers/${created.body.id}/send`).set('Cookie', c).send({}).expect(200);
  });
});
