import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { buildPlatform, noopPlatform, type InvoiceIssuedInfo } from '../server/platform.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';

const auth: AuthConfig = { username: 'admin', password: 'test-password', secret: 'test-secret', ttlHours: 1, secureCookie: false };
const seller: SellerConfig = {
  name: '0815software GmbH',
  addressLines: ['Beispielgasse 8/15', '1010 Wien', 'Austria'],
  vatId: 'ATU00000000',
  iban: 'AT00 0000 0000 0000 0000',
  bic: 'EXAMPLEX',
};

let db: Database.Database;

async function login(app: Express): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

/** Issue a fresh invoice and return its id + admin cookie. */
async function issueInvoice(app: Express): Promise<{ id: number; cookie: string }> {
  const cookie = await login(app);
  const draft = await request(app)
    .post('/api/invoices')
    .set('Cookie', cookie)
    .send({ customer_id: 1, payment_terms_days: 14, lines: [{ description: 'Svc', quantity: 1, unit_price_cents: 10_000, vat_rate: 20 }] });
  await request(app).post(`/api/invoices/${draft.body.id}/finalize`).set('Cookie', cookie).send({}).expect(200);
  return { id: draft.body.id, cookie };
}

async function issueFirstDraft(app: Express): Promise<void> {
  await issueInvoice(app);
}

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
});

describe('platform integration on invoice finalize', () => {
  it('invokes the platform hook with the issued invoice and its PDF', async () => {
    const calls: InvoiceIssuedInfo[] = [];
    const app = createApp({
      db,
      auth,
      seller,
      platform: {
        ...noopPlatform,
        async invoiceIssued(info) {
          calls.push(info);
        },
      },
    });
    await issueFirstDraft(app);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.number).toMatch(/^INV-\d{4}-\d+$/); // issued number, not a draft
    expect(calls[0]!.totalFormatted).toContain('€');
    expect(calls[0]!.pdf.length).toBeGreaterThan(0); // a real rendered PDF
  });

  it('is a no-op when no platform services are configured (standalone)', async () => {
    // buildPlatform with an empty config returns the shared no-op instance.
    expect(buildPlatform({})).toBe(noopPlatform);
    const app = createApp({ db, auth, seller }); // no platform option → noop
    await issueFirstDraft(app); // must not throw
  });

  it('a failing platform hook never fails the finalize (best-effort)', async () => {
    const app = createApp({
      db,
      auth,
      seller,
      platform: {
        ...noopPlatform,
        async invoiceIssued() {
          throw new Error('notification hub is down');
        },
      },
    });
    // The route swallows hook errors, so finalize still returns 200.
    await issueFirstDraft(app);
  });
});

describe('pay-an-invoice via PS-08', () => {
  it('records the payment when the intent settles synchronously', async () => {
    const app = createApp({
      db,
      auth,
      seller,
      platform: {
        ...noopPlatform,
        async payInvoice() {
          return { status: 'succeeded', public_id: 'pi_test' };
        },
      },
    });
    const { id, cookie } = await issueInvoice(app);
    const pay = await request(app).post(`/api/invoices/${id}/pay`).set('Cookie', cookie);
    expect(pay.status).toBe(200);
    expect(pay.body.payment.status).toBe('succeeded');
    expect(pay.body.invoice.payment_status).toBe('paid');
    expect(pay.body.invoice.open_cents).toBe(0);
  });

  it('leaves the invoice open when the intent is still processing', async () => {
    const app = createApp({
      db,
      auth,
      seller,
      platform: {
        ...noopPlatform,
        async payInvoice() {
          return { status: 'processing', public_id: 'pi_test' };
        },
      },
    });
    const { id, cookie } = await issueInvoice(app);
    const pay = await request(app).post(`/api/invoices/${id}/pay`).set('Cookie', cookie);
    expect(pay.body.payment.status).toBe('processing');
    expect(pay.body.invoice.payment_status).not.toBe('paid');
  });

  it('returns 501 when Payments is not configured', async () => {
    const app = createApp({ db, auth, seller }); // noop platform
    const { id, cookie } = await issueInvoice(app);
    expect((await request(app).post(`/api/invoices/${id}/pay`).set('Cookie', cookie)).status).toBe(501);
  });
});

describe('invoice numbering via PS-10', () => {
  it('uses the number from PS-10 when configured', async () => {
    const app = createApp({
      db,
      auth,
      seller,
      platform: {
        ...noopPlatform,
        async nextInvoiceNumber() {
          return 'INV-CUSTOM-0007';
        },
      },
    });
    const { id, cookie } = await issueInvoice(app);
    const detail = await request(app).get(`/api/invoices/${id}`).set('Cookie', cookie);
    expect(detail.body.number).toBe('INV-CUSTOM-0007');
  });

  it('falls back to the local gapless counter when PS-10 is unconfigured', async () => {
    const app = createApp({ db, auth, seller }); // noop
    const { id, cookie } = await issueInvoice(app);
    const detail = await request(app).get(`/api/invoices/${id}`).set('Cookie', cookie);
    expect(detail.body.number).toMatch(/^INV-\d{4}-\d{4}$/);
  });
});


describe('SSO login-exchange', () => {
  it('lets PS-01 decide the login, bypassing local credentials', async () => {
    // The injected verifier stands in for a configured PS-01: it approves
    // despite a wrong local password, so the module must still issue a session.
    const app = createApp({ db, auth, seller, verifyLogin: async () => ({ ok: true, actor: 'ada@acme.test' }) });
    await request(app).post('/api/login').send({ username: 'admin', password: 'wrong-password' }).expect(200);
  });

  it('rejects when PS-01 rejects, even with correct local credentials', async () => {
    const app = createApp({ db, auth, seller, verifyLogin: async () => ({ ok: false }) });
    await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' }).expect(401);
  });

  it('falls back to local credentials when SSO is unconfigured (null)', async () => {
    const app = createApp({ db, auth, seller, verifyLogin: async () => null });
    await request(app).post('/api/login').send({ username: 'admin', password: 'nope' }).expect(401);
    await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' }).expect(200);
  });
});

describe('who issued this invoice', () => {
  it('reaches the audit trail as the PS-01 identity, not "admin"', async () => {
    const actors: string[] = [];
    const app = createApp({
      db,
      auth,
      seller,
      verifyLogin: async () => ({ ok: true, actor: 'ada@acme.test' }),
      platform: {
        ...noopPlatform,
        async invoiceIssued(info) {
          actors.push(info.actor);
        },
      },
    });
    const login = await request(app).post('/api/login').send({ username: 'x', password: 'y' }).expect(200);
    const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;

    const draft = await request(app)
      .post('/api/invoices')
      .set('Cookie', cookie)
      .send({ customer_id: 1, lines: [{ description: 'Work', quantity: 1, unit_price_cents: 10_000, vat_rate: 20 }] });
    expect(draft.status).toBe(201);
    await request(app).post(`/api/invoices/${draft.body.id}/finalize`).set('Cookie', cookie).expect(200);

    expect(actors).toEqual(['ada@acme.test']);
  });
});
