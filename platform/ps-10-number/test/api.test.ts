import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp, type AppOptions } from '../server/app.js';
import { openDb } from '../server/db.js';
import { formatNumber } from '../server/numbering.js';
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
let clock: number;
let app: Express;

function make(extra: Partial<AppOptions> = {}): Express {
  return createApp({ db, auth, now: () => clock, ...extra });
}

beforeEach(() => {
  db = openDb(':memory:');
  clock = Date.parse('2026-05-01T00:00:00Z');
  app = make();
});

describe('auth', () => {
  it('gates allocation', async () => {
    expect((await request(app).get('/api/health')).body).toEqual({ ok: true });
    expect((await request(app).post('/api/next').send({ scope: 'invoice' })).status).toBe(401);
  });
});

describe('formatNumber', () => {
  it('renders seq padding and calendar tokens', () => {
    const now = Date.parse('2026-03-07T00:00:00Z');
    expect(formatNumber('INV-{YYYY}-{seq:0000}', 42, now)).toBe('INV-2026-0042');
    expect(formatNumber('{YY}{MM}{DD}-{seq}', 5, now)).toBe('260307-5');
  });
});

describe('gapless allocation', () => {
  it('increments gaplessly within a scope', async () => {
    await request(app).post('/api/sequences').set(svc).send({ scope: 'invoice', format: 'INV-{YYYY}-{seq:0000}', period: 'year' }).expect(201);
    const a = await request(app).post('/api/next').set(svc).send({ scope: 'invoice' });
    const b = await request(app).post('/api/next').set(svc).send({ scope: 'invoice' });
    expect(a.body.formatted).toBe('INV-2026-0001');
    expect(b.body.formatted).toBe('INV-2026-0002');
    expect(b.body.value).toBe(2);
  });

  it('keeps separate scopes independent', async () => {
    const inv = await request(app).post('/api/next').set(svc).send({ scope: 'invoice' });
    const ord = await request(app).post('/api/next').set(svc).send({ scope: 'order' });
    expect(inv.body.value).toBe(1);
    expect(ord.body.value).toBe(1); // independent counters
  });

  it('restarts the counter on a new period (year)', async () => {
    await request(app).post('/api/sequences').set(svc).send({ scope: 'invoice', format: 'INV-{YYYY}-{seq:0000}', period: 'year' });
    const first = await request(app).post('/api/next').set(svc).send({ scope: 'invoice' });
    expect(first.body.formatted).toBe('INV-2026-0001');
    clock = Date.parse('2027-01-02T00:00:00Z'); // next year
    const second = await request(app).post('/api/next').set(svc).send({ scope: 'invoice' });
    expect(second.body.formatted).toBe('INV-2027-0001'); // restarted at 1
  });

  it('auto-creates a default config for an unknown scope', async () => {
    const res = await request(app).post('/api/next').set(svc).send({ scope: 'brand-new' });
    expect(res.status).toBe(201);
    expect(res.body.formatted).toBe('2026-0001');
  });

  it('rejects a format without a {seq} token', async () => {
    expect((await request(app).post('/api/sequences').set(svc).send({ scope: 'x', format: 'no-seq' })).status).toBe(422);
  });

  it('exposes the current value without incrementing', async () => {
    await request(app).post('/api/next').set(svc).send({ scope: 'invoice' });
    const view = await request(app).get('/api/sequences/invoice').set(svc);
    expect(view.body.current.last_value).toBe(1);
    // peeking did not consume a number
    const nextOne = await request(app).post('/api/next').set(svc).send({ scope: 'invoice' });
    expect(nextOne.body.value).toBe(2);
  });
});

describe('concurrency (gapless under parallel allocation)', () => {
  it('never repeats or skips a value', async () => {
    const results = await Promise.all(
      Array.from({ length: 25 }, () => request(app).post('/api/next').set(svc).send({ scope: 'invoice' })),
    );
    const values = results.map((r) => r.body.value as number).sort((a, b) => a - b);
    expect(values).toEqual(Array.from({ length: 25 }, (_, i) => i + 1)); // 1..25, no gaps/dupes
  });
});

describe('identity seam', () => {
  it('accepts a PS-01-verified token when IDENTITY_URL is set', async () => {
    const identityFetch = async (_url: string, init?: { body?: string }) => {
      const tok = init?.body ? (JSON.parse(init.body).token as string) : '';
      return { ok: true, status: 200, json: async () => ({ valid: tok === 'ps01-good' }) };
    };
    const seamApp = make({ auth: { ...auth, identityUrl: 'http://identity.test' }, identityFetch });
    expect((await request(seamApp).post('/api/next').set(as('ps01-good')).send({ scope: 'invoice' })).status).toBe(201);
    expect((await request(seamApp).post('/api/next').set(as('ps01-bad')).send({ scope: 'invoice' })).status).toBe(401);
  });
});
