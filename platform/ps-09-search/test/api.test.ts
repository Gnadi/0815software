import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp, type AppOptions } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};
const svc = { 'X-Service-Token': 'test-service' };
const as = (t: string) => ({ Authorization: `Bearer ${t}` });

let db: Database.Database;
let app: Express;

const make = (extra: Partial<AppOptions> = {}): Express => createApp({ db, auth, ...extra });

async function index(doc: Record<string, unknown>): Promise<void> {
  await request(app).post('/api/index').set(svc).send(doc).expect(201);
}

beforeEach(() => {
  db = openDb(':memory:');
  app = make();
});

describe('auth', () => {
  it('gates index and search', async () => {
    expect((await request(app).get('/api/health')).body).toEqual({ ok: true });
    expect((await request(app).get('/api/search?collection=x&q=y')).status).toBe(401);
    expect((await request(app).post('/api/index').send({ collection: 'x', id: '1', title: 't' })).status).toBe(401);
  });
});

describe('index & search', () => {
  beforeEach(async () => {
    await index({ collection: 'products', id: '1', title: 'Blue Widget', body: 'sturdy blue widget', facets: { color: 'blue', category: 'widgets' } });
    await index({ collection: 'products', id: '2', title: 'Red Widget', body: 'bright red widget', facets: { color: 'red', category: 'widgets' } });
    await index({ collection: 'products', id: '3', title: 'Blue Gadget', body: 'compact blue gadget', facets: { color: 'blue', category: 'gadgets' } });
  });

  it('ranks full-text matches and returns facet counts', async () => {
    const res = await request(app).get('/api/search?collection=products&q=widget').set(svc);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.hits.map((h: { id: string }) => h.id).sort()).toEqual(['1', '2']);
    expect(res.body.hits[0].score).toBeGreaterThan(0);
    // facet counts over the matching set
    const colors = res.body.facets.filter((f: { key: string }) => f.key === 'color');
    expect(colors.find((f: { value: string }) => f.value === 'blue').count).toBe(1);
    expect(colors.find((f: { value: string }) => f.value === 'red').count).toBe(1);
  });

  it('supports prefix matching', async () => {
    const res = await request(app).get('/api/search?collection=products&q=blu').set(svc);
    expect(res.body.total).toBe(2); // Blue Widget + Blue Gadget
  });

  it('filters by facet', async () => {
    const res = await request(app).get('/api/search?collection=products&q=widget&facet.color=blue').set(svc);
    expect(res.body.total).toBe(1);
    expect(res.body.hits[0].id).toBe('1');
    expect(res.body.hits[0].facets.category).toBe('widgets');
  });

  it('scopes to the collection', async () => {
    await index({ collection: 'docs', id: '9', title: 'Widget manual', body: 'widget widget' });
    const res = await request(app).get('/api/search?collection=products&q=widget').set(svc);
    expect(res.body.hits.every((h: { collection: string }) => h.collection === 'products')).toBe(true);
  });

  it('upserts (re-indexing replaces the previous document)', async () => {
    await index({ collection: 'products', id: '1', title: 'Green Widget', body: 'now green', facets: { color: 'green' } });
    const blue = await request(app).get('/api/search?collection=products&q=widget&facet.color=blue').set(svc);
    expect(blue.body.hits.map((h: { id: string }) => h.id)).not.toContain('1');
    const green = await request(app).get('/api/search?collection=products&q=green').set(svc);
    expect(green.body.hits.map((h: { id: string }) => h.id)).toContain('1');
  });

  it('deletes a document from the index', async () => {
    await request(app).delete('/api/index/products/2').set(svc).expect(200);
    const res = await request(app).get('/api/search?collection=products&q=widget').set(svc);
    expect(res.body.hits.map((h: { id: string }) => h.id)).not.toContain('2');
  });

  it('returns empty for a blank query', async () => {
    const res = await request(app).get('/api/search?collection=products&q=').set(svc);
    expect(res.body).toEqual({ total: 0, hits: [], facets: [] });
  });
});

describe('identity seam', () => {
  it('accepts a PS-01-verified token when IDENTITY_URL is set', async () => {
    const identityFetch = async (_url: string, init?: { body?: string }) => {
      const tok = init?.body ? (JSON.parse(init.body).token as string) : '';
      return { ok: true, status: 200, json: async () => ({ valid: tok === 'ps01-good', permissions: ['platform:admin'] }) };
    };
    const seamApp = make({ auth: { ...auth, identityUrl: 'http://identity.test' }, identityFetch });
    expect((await request(seamApp).get('/api/search?collection=x&q=y').set(as('ps01-good'))).status).toBe(200);
    expect((await request(seamApp).get('/api/search?collection=x&q=y').set(as('ps01-bad'))).status).toBe(401);
  });
});
