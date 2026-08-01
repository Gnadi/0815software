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


describe('PS-11 Customers integration', () => {
  it('registers a new supplier as a SUPPLIER party and stores the master id', async () => {
    const seen: { name: string; kind: string; localId: number }[] = [];
    const app = appWith({
      ...noopPlatform,
      async resolveParty(info) {
        // buildPlatform pins kind: 'supplier'; the hook shape carries the rest.
        seen.push({ name: info.name, kind: 'supplier', localId: info.localId });
        return 8080;
      },
    });
    const c = await cookie(app);
    const res = await request(app)
      .post('/api/suppliers')
      .set('Cookie', c)
      .send({ name: 'Auer & Söhne GmbH', contact: 'Franz Auer', email: 'verkauf@auer.example' })
      .expect(201);
    await new Promise((r) => setImmediate(r));

    expect(seen).toEqual([{ name: 'Auer & Söhne GmbH', kind: 'supplier', localId: res.body.id }]);
    const row = db.prepare('SELECT party_id FROM suppliers WHERE id = ?').get(res.body.id) as {
      party_id: number | null;
    };
    expect(row.party_id).toBe(8080);
  });

  it('leaves party_id null when PS-11 is unconfigured — the standalone posture', async () => {
    const app = createApp({ db, auth });
    const c = await cookie(app);
    const res = await request(app).post('/api/suppliers').set('Cookie', c).send({ name: 'Local GmbH' }).expect(201);
    await new Promise((r) => setImmediate(r));
    const row = db.prepare('SELECT party_id FROM suppliers WHERE id = ?').get(res.body.id) as {
      party_id: number | null;
    };
    expect(row.party_id).toBeNull();
  });

  it('still creates the supplier when the master service fails', async () => {
    const app = appWith({
      ...noopPlatform,
      async resolveParty() {
        throw new Error('ECONNREFUSED');
      },
    });
    const c = await cookie(app);
    await request(app).post('/api/suppliers').set('Cookie', c).send({ name: 'Auer GmbH' }).expect(201);
  });
});

describe('SSO login-exchange', () => {
  it('lets PS-01 decide the login, bypassing local credentials', async () => {
    // The injected verifier stands in for a configured PS-01: it approves
    // despite a wrong local password, so the module must still issue a session.
    const app = createApp({ db, auth, verifyLogin: async () => ({ ok: true, actor: 'ada@acme.test' }) });
    await request(app).post('/api/login').send({ username: 'admin', password: 'wrong-password' }).expect(200);
  });

  it('rejects when PS-01 rejects, even with correct local credentials', async () => {
    const app = createApp({ db, auth, verifyLogin: async () => ({ ok: false }) });
    await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' }).expect(401);
  });

  it('falls back to local credentials when SSO is unconfigured (null)', async () => {
    const app = createApp({ db, auth, verifyLogin: async () => null });
    await request(app).post('/api/login').send({ username: 'admin', password: 'nope' }).expect(401);
    await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' }).expect(200);
  });
});
