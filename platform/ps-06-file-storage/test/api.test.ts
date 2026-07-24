import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
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
const signingSecret = 'sign-secret';

let db: Database.Database;
let app: Express;
let clock: number;

beforeEach(() => {
  db = openDb(':memory:');
  clock = Date.parse('2026-07-01T00:00:00Z');
  app = createApp({ db, auth, signingSecret, now: () => clock });
});

const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('auth', () => {
  it('gates caller routes', async () => {
    expect((await request(app).get('/api/health')).body).toEqual({ ok: true });
    expect((await request(app).get('/api/buckets')).status).toBe(401);
    expect((await request(app).get('/api/buckets').set({ 'X-Service-Token': 'no' })).status).toBe(401);
  });
});

describe('buckets & objects', () => {
  it('creates a bucket, stores, stats and reads an object', async () => {
    await request(app).post('/api/buckets').set(svc).send({ name: 'docs' }).expect(201);

    const put = await request(app)
      .put('/api/objects/docs/invoice.pdf')
      .set(svc)
      .send({ content_base64: b64('PDF-BYTES'), content_type: 'application/pdf', metadata: { module: 'mod-04' } });
    expect(put.status).toBe(201);
    expect(put.body.size).toBe('PDF-BYTES'.length);
    expect(put.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(put.body.metadata).toEqual({ module: 'mod-04' });

    const meta = await request(app).get('/api/objects/docs/invoice.pdf/meta').set(svc);
    expect(meta.body.content_type).toBe('application/pdf');

    const get = await request(app).get('/api/objects/docs/invoice.pdf').set(svc);
    expect(Buffer.from(get.body.content_base64, 'base64').toString()).toBe('PDF-BYTES');

    const list = await request(app).get('/api/objects/docs').set(svc);
    expect(list.body.objects.length).toBe(1);
  });

  it('overwrites an object and 404s the unknown', async () => {
    await request(app).post('/api/buckets').set(svc).send({ name: 'docs' });
    await request(app).put('/api/objects/docs/a').set(svc).send({ content_base64: b64('v1') });
    const v2 = await request(app).put('/api/objects/docs/a').set(svc).send({ content_base64: b64('v2-longer') });
    expect(v2.body.size).toBe('v2-longer'.length);
    expect((await request(app).get('/api/objects/docs/missing').set(svc)).status).toBe(404);
    expect((await request(app).put('/api/objects/nope/a').set(svc).send({ content_base64: b64('x') })).status).toBe(404);
  });

  it('deletes an object', async () => {
    await request(app).post('/api/buckets').set(svc).send({ name: 'docs' });
    await request(app).put('/api/objects/docs/a').set(svc).send({ content_base64: b64('x') });
    expect((await request(app).delete('/api/objects/docs/a').set(svc)).status).toBe(200);
    expect((await request(app).get('/api/objects/docs/a').set(svc)).status).toBe(404);
  });
});

describe('signed download URLs', () => {
  it('mints a signed URL that serves the bytes, and rejects tampering/expiry', async () => {
    await request(app).post('/api/buckets').set(svc).send({ name: 'docs' });
    await request(app).put('/api/objects/docs/report.txt').set(svc).send({ content_base64: b64('REPORT'), content_type: 'text/plain' });

    const signed = await request(app).post('/api/objects/docs/report.txt/sign').set(svc).send({ ttl_seconds: 60 });
    expect(signed.body.url).toContain('/api/download?');

    // The signed URL is public (no auth) and returns the raw bytes.
    const dl = await request(app).get(signed.body.url);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toContain('text/plain');
    expect(dl.text).toBe('REPORT');

    // Tampered signature → 403.
    expect((await request(app).get(signed.body.url.replace(/sig=[0-9a-f]+/, 'sig=deadbeef'))).status).toBe(403);

    // Expired → 403.
    clock += 61_000;
    expect((await request(app).get(signed.body.url)).status).toBe(403);
  });
});

describe('identity seam', () => {
  it('accepts a PS-01-verified token when IDENTITY_URL is set', async () => {
    const identityFetch = async (_url: string, init?: { body?: string }) => {
      const tok = init?.body ? (JSON.parse(init.body).token as string) : '';
      return { ok: true, status: 200, json: async () => ({ valid: tok === 'ps01-good', permissions: ['platform:admin'] }) };
    };
    const seamApp = createApp({ db, auth: { ...auth, identityUrl: 'http://identity.test' }, signingSecret, now: () => clock, identityFetch });
    expect((await request(seamApp).get('/api/buckets').set(as('ps01-good'))).status).toBe(200);
    expect((await request(seamApp).get('/api/buckets').set(as('ps01-bad'))).status).toBe(401);
  });
});
