import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';

/**
 * The `ids` batch on the CSV export and on bulk-delete.
 *
 * Two things used to go wrong here, and neither announced itself. A batch
 * larger than SQLite's bound-parameter ceiling made better-sqlite3 throw, so a
 * request whose only fault was being too big came back as a 500. And `absent`
 * and `invalid` both parsed to `null`, which the export read as "no filter" —
 * so a malformed `?ids=` silently WIDENED the export to the whole table
 * instead of refusing it.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

let app: Express;
let cookie: string;
const created: number[] = [];

beforeAll(async () => {
  app = createApp({ db: openDb(':memory:'), auth });
  const login = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  expect(login.status).toBe(200);
  cookie = login.headers['set-cookie']![0]!.split(';')[0]!;

  for (let i = 1; i <= 3; i += 1) {
    const res = await request(app)
      .post('/api/products')
      .set('Cookie', cookie)
      .send({ sku: `BATCH-${i}`, name: `Batch product ${i}`, category: 'hardware', price: i * 100, stock: i, active: true });
    expect(res.status).toBe(201);
    created.push(res.body.id as number);
  }
});

/** A comma-joined run of `count` plausible ids. */
function idRun(count: number): string {
  return Array.from({ length: count }, (_, i) => i + 1).join(',');
}

describe('export.csv id batches', () => {
  it('filters to the requested ids', async () => {
    const res = await request(app)
      .get(`/api/products/export.csv?ids=${created[0]},${created[1]}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const lines = res.text.trimEnd().split('\r\n');
    expect(lines).toHaveLength(3); // header + two rows
  });

  it('exports everything when no ids are given', async () => {
    const res = await request(app).get('/api/products/export.csv').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text.trimEnd().split('\r\n')).toHaveLength(created.length + 1);
  });

  it('treats an empty ids parameter as "no filter", not as an error', async () => {
    const res = await request(app).get('/api/products/export.csv?ids=').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text.trimEnd().split('\r\n')).toHaveLength(created.length + 1);
  });

  // The regression: a malformed filter must NOT quietly widen the result.
  it.each(['1,abc', '0', '-1', '1.5', 'DROP', '1,,2'])('refuses the malformed filter %o with 422', async (ids) => {
    const res = await request(app).get(`/api/products/export.csv?ids=${encodeURIComponent(ids)}`).set('Cookie', cookie);
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('positive integers');
  });

  // The regression: this used to reach SQLite and come back as a 500.
  it('refuses an oversized batch with 422 and says how many were sent', async () => {
    const res = await request(app).get(`/api/products/export.csv?ids=${idRun(1001)}`).set('Cookie', cookie);
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('1000');
    expect(res.body.error).toContain('1001');
  });

  it('accepts a batch of exactly the cap', async () => {
    const res = await request(app).get(`/api/products/export.csv?ids=${idRun(1000)}`).set('Cookie', cookie);
    expect(res.status).toBe(200);
  });
});

describe('bulk-delete id batches', () => {
  it('refuses a missing or non-list body with 422', async () => {
    for (const body of [{}, { ids: [] }, { ids: 'nope' }, { ids: 42 }]) {
      const res = await request(app).post('/api/products/bulk-delete').set('Cookie', cookie).send(body);
      expect(res.status, JSON.stringify(body)).toBe(422);
    }
  });

  it('refuses non-positive ids with 422', async () => {
    const res = await request(app).post('/api/products/bulk-delete').set('Cookie', cookie).send({ ids: [1, 0] });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('positive integers');
  });

  it('refuses an oversized batch with 422 instead of throwing a 500', async () => {
    const ids = Array.from({ length: 40_000 }, (_, i) => i + 1);
    const res = await request(app).post('/api/products/bulk-delete').set('Cookie', cookie).send({ ids });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('at most 1000');
  });

  it('deletes a valid batch and reports the count', async () => {
    const res = await request(app)
      .post('/api/products/bulk-delete')
      .set('Cookie', cookie)
      .send({ ids: [created[0], created[1]] });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
  });
});
