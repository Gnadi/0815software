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

async function issueFirstDraft(app: Express): Promise<void> {
  const login = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  const cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
  const draft = await request(app)
    .post('/api/invoices')
    .set('Cookie', cookie)
    .send({ customer_id: 1, payment_terms_days: 14, lines: [{ description: 'Svc', quantity: 1, unit_price_cents: 10_000, vat_rate: 20 }] });
  await request(app).post(`/api/invoices/${draft.body.id}/finalize`).set('Cookie', cookie).send({}).expect(200);
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
        async invoiceIssued() {
          throw new Error('notification hub is down');
        },
      },
    });
    // The route swallows hook errors, so finalize still returns 200.
    await issueFirstDraft(app);
  });
});
