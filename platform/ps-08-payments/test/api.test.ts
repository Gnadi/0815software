import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import Database from 'better-sqlite3';
import { createApp, type AppOptions } from '../server/app.js';
import { openDb } from '../server/db.js';
import { expectedSignature } from '../server/webhooks.js';
import type { AuthConfig } from '../server/auth.js';
import type { FetchLike } from '../server/providers/index.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-pass',
  secret: 'test-secret',
  ttlHours: 12,
  secureCookie: false,
  serviceToken: 'test-service',
};
const webhookSecret = 'whsec-test';
const svc = { 'X-Service-Token': 'test-service' };
const as = (t: string) => ({ Authorization: `Bearer ${t}` });

let db: Database.Database;
let app: Express;
let clock: number;

function make(extra: Partial<AppOptions> = {}): Express {
  return createApp({ db, auth, webhookSecret, now: () => clock, ...extra });
}
async function adminToken(a: Express): Promise<string> {
  return (await request(a).post('/api/login').send({ username: 'admin', password: 'test-pass' })).body.token as string;
}

beforeEach(() => {
  db = openDb(':memory:');
  clock = Date.parse('2026-07-01T00:00:00Z');
  app = make();
});

async function createIntent(fields: Record<string, unknown> = {}): Promise<request.Response> {
  return request(app)
    .post('/api/intents')
    .set(svc)
    .send({ reference: 'invoice:INV-1', amount_minor: 10_000, currency: 'EUR', ...fields });
}

describe('auth', () => {
  it('gates caller routes and requires a service token or admin', async () => {
    expect((await request(app).get('/api/health')).body).toEqual({ ok: true });
    expect((await request(app).get('/api/intents')).status).toBe(401);
    expect((await request(app).post('/api/intents').send({ reference: 'x', amount_minor: 1 })).status).toBe(401);
  });
});

describe('intent lifecycle', () => {
  it('creates → confirms → settles on tick, crediting the ledger once', async () => {
    const created = await createIntent();
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('requires_payment');
    expect(created.body.public_id).toMatch(/^pi_[0-9a-f]+$/);
    const id = created.body.id;

    const confirmed = await request(app).post(`/api/intents/${id}/confirm`).set(svc);
    expect(confirmed.body.status).toBe('processing'); // mock settles async

    const tick = await request(app).post('/api/tick').set(svc);
    expect(tick.body.settled).toBe(1);

    const after = await request(app).get(`/api/intents/${id}`).set(svc);
    expect(after.body.status).toBe('succeeded');
    const credits = after.body.ledger.filter((l: { direction: string }) => l.direction === 'credit');
    expect(credits).toHaveLength(1);
    expect(credits[0].amount_minor).toBe(10_000);

    // A second tick must not double-credit.
    await request(app).post('/api/tick').set(svc);
    const again = await request(app).get(`/api/intents/${id}`).set(svc);
    expect(again.body.ledger.filter((l: { direction: string }) => l.direction === 'credit')).toHaveLength(1);
  });

  it('confirm=true on create moves straight to processing', async () => {
    const res = await createIntent({ confirm: true });
    expect(res.body.status).toBe('processing');
  });

  it('validates amount and currency', async () => {
    expect((await createIntent({ amount_minor: 0 })).status).toBe(422);
    expect((await createIntent({ amount_minor: 10.5 })).status).toBe(422);
    expect((await createIntent({ currency: 'euro' })).status).toBe(422);
  });

  it('is idempotent on idempotency_key and 409s on a changed amount', async () => {
    const first = await createIntent({ idempotency_key: 'k1' });
    expect(first.status).toBe(201);
    const replay = await createIntent({ idempotency_key: 'k1' });
    expect(replay.status).toBe(200);
    expect(replay.body.id).toBe(first.body.id);
    const conflict = await createIntent({ idempotency_key: 'k1', amount_minor: 999 });
    expect(conflict.status).toBe(409);
  });
});

describe('refunds', () => {
  async function settledIntent(amount = 10_000): Promise<number> {
    const created = await createIntent({ amount_minor: amount, confirm: true });
    await request(app).post('/api/tick').set(svc);
    return created.body.id;
  }

  it('refunds partially then fully, debiting the ledger', async () => {
    const id = await settledIntent();
    const partial = await request(app).post(`/api/intents/${id}/refund`).set(svc).send({ amount_minor: 4_000 });
    expect(partial.body.status).toBe('partially_refunded');
    expect(partial.body.amount_refunded_minor).toBe(4_000);

    const rest = await request(app).post(`/api/intents/${id}/refund`).set(svc).send({});
    expect(rest.body.status).toBe('refunded');
    expect(rest.body.amount_refunded_minor).toBe(10_000);

    const debits = rest.body.ledger.filter((l: { direction: string }) => l.direction === 'debit');
    expect(debits.reduce((n: number, l: { amount_minor: number }) => n + l.amount_minor, 0)).toBe(10_000);
  });

  it('rejects over-refund and refunding an unsettled intent', async () => {
    const id = await settledIntent();
    expect((await request(app).post(`/api/intents/${id}/refund`).set(svc).send({ amount_minor: 20_000 })).status).toBe(422);

    const unsettled = await createIntent();
    expect((await request(app).post(`/api/intents/${unsettled.body.id}/refund`).set(svc).send({})).status).toBe(422);
  });
});

describe('inbound PSP webhooks', () => {
  it('reconciles a succeeded webhook and rejects a bad signature', async () => {
    const created = await createIntent({ confirm: true });
    const publicId = created.body.public_id;
    const payload = JSON.stringify({ type: 'payment.succeeded', intent: publicId });

    const bad = await request(app)
      .post('/api/webhooks/stripe')
      .set('x-signature', 'deadbeef')
      .set('content-type', 'application/json')
      .send(payload);
    expect(bad.status).toBe(403);

    const good = await request(app)
      .post('/api/webhooks/stripe')
      .set('x-signature', expectedSignature(webhookSecret, payload))
      .set('content-type', 'application/json')
      .send(payload);
    expect(good.status).toBe(202);

    const after = await request(app).get(`/api/intents/${created.body.id}`).set(svc);
    expect(after.body.status).toBe('succeeded'); // reconciled without a tick
  });
});

describe('real provider selection', () => {
  it('uses the Stripe adapter when a key is configured (injected fetch)', async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ id: 'pi_stripe_1', status: 'succeeded' }) };
    };
    const stripeApp = make({ stripeSecretKey: 'sk_test', fetchImpl });
    const created = await request(stripeApp)
      .post('/api/intents')
      .set(svc)
      .send({ reference: 'r', amount_minor: 500, currency: 'usd', confirm: true });
    // Stripe confirms synchronously → succeeded without a tick.
    expect(created.body.status).toBe('succeeded');
    expect(created.body.provider).toBe('stripe');
    expect(calls.some((u) => u.includes('/v1/payment_intents'))).toBe(true);
  });
});

describe('identity seam', () => {
  it('accepts a PS-01-verified token when IDENTITY_URL is set', async () => {
    const identityFetch = async (_url: string, init?: { body?: string }) => {
      const tok = init?.body ? (JSON.parse(init.body).token as string) : '';
      return { ok: true, status: 200, json: async () => ({ valid: tok === 'ps01-good' }) };
    };
    const seamApp = make({ auth: { ...auth, identityUrl: 'http://identity.test' }, identityFetch });
    await adminToken(seamApp); // sanity: login still works
    expect((await request(seamApp).get('/api/intents').set(as('ps01-good'))).status).toBe(200);
    expect((await request(seamApp).get('/api/intents').set(as('ps01-bad'))).status).toBe(401);
  });
});
