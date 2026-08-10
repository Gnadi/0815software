import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { DocumentMeta, OrderEvent, OrderSummary } from '../shared/types.js';
import { createApp } from '../server/app.js';
import type { SessionConfig } from '../server/auth.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';

const session: SessionConfig = {
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

const ANNA = { email: 'anna.berger@example.de', password: 'demo-anna' };
const LUKAS = { email: 'l.steiner@example.at', password: 'demo-lukas' };

let app: Express;
let documentsDir: string;

async function login(creds: { email: string; password: string }): Promise<string> {
  const res = await request(app).post('/api/login').send(creds);
  expect(res.status).toBe(200);
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

async function listOrders(cookie: string, query = ''): Promise<OrderSummary[]> {
  const res = await request(app).get(`/api/orders${query}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body.orders as OrderSummary[];
}

async function listDocuments(cookie: string): Promise<DocumentMeta[]> {
  const res = await request(app).get('/api/documents').set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body.documents as DocumentMeta[];
}

beforeAll(async () => {
  documentsDir = mkdtempSync(join(tmpdir(), 'mod01-test-'));
  const db = openDb(':memory:');
  await seed(db, documentsDir);
  app = createApp({ db, session, documentsDir });
});

afterAll(() => {
  rmSync(documentsDir, { recursive: true, force: true });
});

describe('auth', () => {
  it('rejects unauthenticated requests with 401', async () => {
    for (const path of ['/api/orders', '/api/orders/1', '/api/documents', '/api/documents/1/download', '/api/me']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
  });

  it('rejects a wrong password and an unknown email', async () => {
    const wrong = await request(app)
      .post('/api/login')
      .send({ email: ANNA.email, password: 'not-her-password' });
    expect(wrong.status).toBe(401);

    const unknown = await request(app)
      .post('/api/login')
      .send({ email: 'nobody@example.com', password: 'demo-anna' });
    expect(unknown.status).toBe(401);
  });

  it('logs in with valid credentials and sets an HttpOnly session cookie', async () => {
    const res = await request(app).post('/api/login').send(ANNA);
    expect(res.status).toBe(200);
    expect(res.body.customer.email).toBe(ANNA.email);
    expect(res.body.customer).not.toHaveProperty('password_hash');
    const cookie = res.headers['set-cookie']![0]!;
    expect(cookie).toContain('mod01_session=');
    expect(cookie).toContain('HttpOnly');
  });

  it('rejects a tampered session token', async () => {
    const cookie = await login(ANNA);
    // Flip the customer id inside the token; the HMAC no longer matches.
    const tampered = cookie.replace(/mod01_session=\d+/, 'mod01_session=999');
    const res = await request(app).get('/api/orders').set('Cookie', tampered);
    expect(res.status).toBe(401);
  });

  it('logout clears the cookie', async () => {
    const cookie = await login(ANNA);
    const res = await request(app).post('/api/logout').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']![0]).toContain('Max-Age=0');
  });
});

describe('orders', () => {
  it('lists only the signed-in customer’s orders', async () => {
    const anna = await listOrders(await login(ANNA));
    expect(anna.map((o) => o.order_no).sort()).toEqual(['ORD-1001', 'ORD-1007', 'ORD-1015']);

    const lukas = await listOrders(await login(LUKAS));
    expect(lukas.map((o) => o.order_no).sort()).toEqual(['ORD-1002', 'ORD-1010', 'ORD-1016']);
  });

  it('filters by status and rejects unknown statuses', async () => {
    const cookie = await login(ANNA);
    const delivered = await listOrders(cookie, '?status=delivered');
    expect(delivered.map((o) => o.order_no)).toEqual(['ORD-1001']);

    const bogus = await request(app).get('/api/orders?status=bogus').set('Cookie', cookie);
    expect(bogus.status).toBe(422);
  });

  it('searches order numbers and line items', async () => {
    const cookie = await login(ANNA);
    const byNo = await listOrders(cookie, '?search=1007');
    expect(byNo.map((o) => o.order_no)).toEqual(['ORD-1007']);

    const byItem = await listOrders(cookie, '?search=Label');
    expect(byItem.map((o) => o.order_no).sort()).toEqual(['ORD-1001', 'ORD-1015']);
  });

  it('returns detail with items, a chronological status timeline and documents', async () => {
    const cookie = await login(ANNA);
    const orders = await listOrders(cookie);
    const delivered = orders.find((o) => o.order_no === 'ORD-1001')!;

    const res = await request(app).get(`/api/orders/${delivered.id}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.order.order_no).toBe('ORD-1001');
    expect(res.body.order.total_cents).toBe(129800);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].sku).toBe('HW-1001');

    const events = res.body.events as OrderEvent[];
    expect(events.map((e) => e.status)).toEqual(['placed', 'confirmed', 'shipped', 'delivered']);
    const times = events.map((e) => Date.parse(e.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    events.forEach((e) => expect(Number.isNaN(Date.parse(e.at))).toBe(false));

    const docs = res.body.documents as DocumentMeta[];
    expect(docs.map((d) => d.doc_type).sort()).toEqual(['delivery_note', 'invoice']);
  });

  it('order totals equal the sum of their line items', async () => {
    const cookie = await login(LUKAS);
    for (const order of await listOrders(cookie)) {
      const res = await request(app).get(`/api/orders/${order.id}`).set('Cookie', cookie);
      const sum = (res.body.items as { quantity: number; unit_price_cents: number }[]).reduce(
        (n, i) => n + i.quantity * i.unit_price_cents,
        0,
      );
      expect(res.body.order.total_cents).toBe(sum);
    }
  });

  it("404s when requesting another customer's order (tenant isolation)", async () => {
    const lukasOrders = await listOrders(await login(LUKAS));
    const annaCookie = await login(ANNA);
    for (const order of lukasOrders) {
      const res = await request(app).get(`/api/orders/${order.id}`).set('Cookie', annaCookie);
      expect(res.status).toBe(404);
    }
  });

  it('404s on unknown and malformed order ids', async () => {
    const cookie = await login(ANNA);
    expect((await request(app).get('/api/orders/99999').set('Cookie', cookie)).status).toBe(404);
    expect((await request(app).get('/api/orders/abc').set('Cookie', cookie)).status).toBe(404);
  });
});

describe('documents', () => {
  it('lists only the signed-in customer’s documents, including standalone ones', async () => {
    const docs = await listDocuments(await login(ANNA));
    expect(docs).toHaveLength(4);
    expect(docs.some((d) => d.order_id === null && d.doc_type === 'statement')).toBe(true);
  });

  it('downloads a document with the right content', async () => {
    const cookie = await login(ANNA);
    const docs = await listDocuments(cookie);
    const invoice = docs.find((d) => d.title === 'Invoice INV-2026-0451')!;

    const res = await request(app).get(`/api/documents/${invoice.id}/download`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('INV-2026-0451.txt');
    const text = res.text ?? res.body.toString('utf8');
    expect(text).toContain('INVOICE  INV-2026-0451');
    expect(text).toContain('ORD-1001');
    expect(text).toContain('Industrial Label Printer');
    expect(text).toContain('1,298.00 EUR');
  });

  it("404s when requesting another customer's document (tenant isolation)", async () => {
    const annaDocs = await listDocuments(await login(ANNA));
    const lukasCookie = await login(LUKAS);
    for (const doc of annaDocs) {
      const res = await request(app).get(`/api/documents/${doc.id}/download`).set('Cookie', lukasCookie);
      expect(res.status, `document ${doc.id}`).toBe(404);
    }
  });
});

describe('password change', () => {
  const JAN = { email: 'j.devries@example.nl', password: 'demo-jan' };

  it('rejects a wrong current password and a too-short new password', async () => {
    const cookie = await login(JAN);
    const wrong = await request(app)
      .post('/api/me/password')
      .set('Cookie', cookie)
      .send({ currentPassword: 'nope', newPassword: 'long-enough-pw' });
    expect(wrong.status).toBe(401);

    const short = await request(app)
      .post('/api/me/password')
      .set('Cookie', cookie)
      .send({ currentPassword: JAN.password, newPassword: 'short' });
    expect(short.status).toBe(422);
  });

  it('round-trips: change, old sessions and old password die, new ones work', async () => {
    const oldCookie = await login(JAN);
    const res = await request(app)
      .post('/api/me/password')
      .set('Cookie', oldCookie)
      .send({ currentPassword: JAN.password, newPassword: 'jan-new-password' });
    expect(res.status).toBe(200);
    const freshCookie = res.headers['set-cookie']![0]!.split(';')[0]!;

    // The pre-change session token is invalidated (token version bumped)…
    expect((await request(app).get('/api/me').set('Cookie', oldCookie)).status).toBe(401);
    // …but the response carried a fresh token that still works.
    expect((await request(app).get('/api/me').set('Cookie', freshCookie)).status).toBe(200);

    // Old password no longer logs in; the new one does.
    const oldPw = await request(app).post('/api/login').send(JAN);
    expect(oldPw.status).toBe(401);
    const newPw = await request(app)
      .post('/api/login')
      .send({ email: JAN.email, password: 'jan-new-password' });
    expect(newPw.status).toBe(200);
  });
});
