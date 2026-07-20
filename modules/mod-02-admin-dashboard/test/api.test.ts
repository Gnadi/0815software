import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { AuthConfig } from '../server/auth.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

let app: Express;
let cookie: string;

beforeAll(async () => {
  const db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth });

  const res = await request(app)
    .post('/api/login')
    .send({ username: 'admin', password: 'test-password' });
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
});

describe('auth', () => {
  it('rejects unauthenticated requests', async () => {
    const res = await request(app).get('/api/customers');
    expect(res.status).toBe(401);
  });

  it('rejects bad credentials', async () => {
    const res = await request(app).post('/api/login').send({ username: 'admin', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('accepts good credentials and sets a session cookie', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ username: 'admin', password: 'test-password' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']![0]).toContain('mod02_session=');
    expect(res.headers['set-cookie']![0]).toContain('HttpOnly');
  });
});

describe('list', () => {
  it('returns seeded rows with pagination metadata', async () => {
    const res = await request(app).get('/api/customers').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(12);
    expect(res.body.rows).toHaveLength(12);
    expect(res.body.rows[0]).toHaveProperty('email');
  });

  it('supports search, column filters, sorting and paging', async () => {
    const res = await request(app)
      .get('/api/customers?f_status=active&sort=name&dir=desc&page=1&pageSize=3')
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.rows).toHaveLength(3);
    expect(res.body.rows.every((r: { status: string }) => r.status === 'active')).toBe(true);
    const names = res.body.rows.map((r: { name: string }) => r.name);
    expect([...names].sort().reverse()).toEqual(names);

    const search = await request(app).get('/api/products?search=Scanner').set('Cookie', cookie);
    expect(search.body.total).toBe(2);
  });

  it('404s on unknown resources', async () => {
    const res = await request(app).get('/api/nonsense').set('Cookie', cookie);
    expect(res.status).toBe(404);
  });
});

describe('create / update / delete', () => {
  it('round-trips a record', async () => {
    const created = await request(app)
      .post('/api/customers')
      .set('Cookie', cookie)
      .send({ name: 'Test Person', email: 'test@example.com', status: 'prospect' });
    expect(created.status).toBe(201);
    const id = created.body.id as number;
    expect(created.body.name).toBe('Test Person');
    expect(created.body.company).toBeNull();

    const updated = await request(app)
      .put(`/api/customers/${id}`)
      .set('Cookie', cookie)
      .send({ name: 'Test Person', email: 'test@example.com', status: 'active', company: 'ACME' });
    expect(updated.status).toBe(200);
    expect(updated.body.status).toBe('active');
    expect(updated.body.company).toBe('ACME');

    const deleted = await request(app).delete(`/api/customers/${id}`).set('Cookie', cookie);
    expect(deleted.status).toBe(200);

    const gone = await request(app).get(`/api/customers/${id}`).set('Cookie', cookie);
    expect(gone.status).toBe(404);
  });

  it('validates payloads', async () => {
    const res = await request(app)
      .post('/api/customers')
      .set('Cookie', cookie)
      .send({ name: '', email: 'not-an-email', status: 'bogus' });
    expect(res.status).toBe(422);
    const fields = res.body.details.map((d: { field: string }) => d.field);
    expect(fields).toContain('name');
    expect(fields).toContain('email');
    expect(fields).toContain('status');
  });

  it('validates numbers and selects on products', async () => {
    const res = await request(app)
      .post('/api/products')
      .set('Cookie', cookie)
      .send({ sku: 'lowercase!', name: 'X', price: -5, stock: 1 });
    expect(res.status).toBe(422);
    const fields = res.body.details.map((d: { field: string }) => d.field);
    expect(fields).toContain('sku');
    expect(fields).toContain('price');
  });
});

describe('bulk actions and CSV export', () => {
  it('bulk-deletes selected ids', async () => {
    const a = await request(app)
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({ order_no: 'ORD-9001', customer: 'A', product: 'P', quantity: 1, total: 1, status: 'pending' });
    const b = await request(app)
      .post('/api/orders')
      .set('Cookie', cookie)
      .send({ order_no: 'ORD-9002', customer: 'B', product: 'P', quantity: 1, total: 1, status: 'pending' });

    const res = await request(app)
      .post('/api/orders/bulk-delete')
      .set('Cookie', cookie)
      .send({ ids: [a.body.id, b.body.id] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
  });

  it('exports a full resource as valid CSV', async () => {
    const res = await request(app).get('/api/products/export.csv').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('id,sku,name,category,price,stock,active');
    expect(lines).toHaveLength(11); // header + 10 seeded products
    expect(lines[1]).toContain('HW-1001');
  });

  it('exports only selected ids and escapes commas', async () => {
    const res = await request(app).get('/api/products/export.csv?ids=1,2').set('Cookie', cookie);
    const lines = res.text.trim().split('\r\n');
    expect(lines).toHaveLength(3);

    const created = await request(app)
      .post('/api/customers')
      .set('Cookie', cookie)
      .send({ name: 'Comma Corp', email: 'comma@example.com', status: 'active', company: 'ACME, Inc.' });
    const escaped = await request(app)
      .get(`/api/customers/export.csv?ids=${created.body.id}`)
      .set('Cookie', cookie);
    expect(escaped.text).toContain('"ACME, Inc."');
    await request(app).delete(`/api/customers/${created.body.id}`).set('Cookie', cookie);
  });

  it('rejects CSV export without a session', async () => {
    const res = await request(app).get('/api/products/export.csv');
    expect(res.status).toBe(401);
  });
});
