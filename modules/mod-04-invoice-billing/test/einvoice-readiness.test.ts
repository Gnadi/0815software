import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { noopPlatform } from '../server/platform.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';

/**
 * A customer's e-invoice format is checked BEFORE a draft is sent — review
 * finding H1 in docs/E-RECHNUNG-REVIEW.md. Sending freezes the parties and
 * the lines, so a field missing at that moment could never be added; the
 * invoice could only be cancelled and issued again.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's'.repeat(32), ttlHours: 1, secureCookie: false };

function germanSeller(): SellerConfig {
  return {
    name: 'Beispiel GmbH',
    addressLines: ['Hauptstraße 1', '80331 München', 'Deutschland'],
    vatId: 'DE123456789',
    iban: 'DE02 1203 0000 0000 2020 51',
    bic: 'BYLADEM1001',
    contactName: 'Erika Mustermann',
    phone: '+49 89 123456',
    email: 'rechnung@beispiel.de',
  };
}

let app: Express;
let db: Database.Database;
let cookie: string;
let numbersDrawn: number;

beforeEach(async () => {
  db = openDb(':memory:');
  numbersDrawn = 0;
  app = createApp({
    db,
    auth,
    seller: germanSeller(),
    platform: {
      ...noopPlatform,
      // Stands in for PS-10: every number drawn there is gone, used or not.
      async nextInvoiceNumber() {
        numbersDrawn += 1;
        return null;
      },
    },
  });
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'pw' });
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
});

const call = (method: 'get' | 'post' | 'put', url: string, body?: object) => {
  const r = request(app)[method](url).set('Cookie', cookie);
  return body ? r.send(body) : r;
};

/** Case A of the review: no postcode, no email, no buyer reference. */
const INCOMPLETE = { name: 'Kunde ohne PLZ AG', vat_id: 'DE987654321', address: 'Kundenweg 5\nBerlin', country_code: 'DE' };

async function draftFor(customer: Record<string, unknown>): Promise<{ customerId: number; invoiceId: number }> {
  const c = await call('post', '/api/customers', customer);
  expect(c.status).toBe(201);
  const d = await call('post', '/api/invoices', {
    customer_id: c.body.id,
    lines: [{ description: 'Beratung', quantity: 1, unit_price_cents: 10000, vat_rate: 19 }],
  });
  expect(d.status).toBe(201);
  return { customerId: c.body.id as number, invoiceId: d.body.id as number };
}

const terms = (problems: { term: string }[]) => problems.map((p) => p.term);
const counters = () => db.prepare('SELECT COUNT(*) AS n FROM invoice_counters').get() as { n: number };

describe('a customer set to an e-invoice format', () => {
  it('shows a draft what is missing, refuses to send it before a number is drawn, and sends it once complete', async () => {
    const { customerId, invoiceId } = await draftFor({ ...INCOMPLETE, einvoice_format: 'xrechnung' });

    const before = await call('get', `/api/invoices/${invoiceId}/einvoice`);
    expect(before.body).toMatchObject({ available: false, format: 'xrechnung' });
    expect(terms(before.body.problems.xrechnung)).toEqual(['BT-52', 'BT-53', 'BT-49', 'BT-10']);

    const refused = await call('post', `/api/invoices/${invoiceId}/finalize`, { issue_date: '2026-10-21' });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain('XRechnung');
    expect(refused.body.details.map((d: { field: string }) => d.field)).toEqual([
      'customer.city',
      'customer.postcode',
      'customer.einvoice_address',
      'buyer_reference',
    ]);
    // Nothing was spent on the refusal: still a draft, no local number, no PS-10 number.
    expect((await call('get', `/api/invoices/${invoiceId}`)).body.status).toBe('draft');
    expect(counters().n).toBe(0);
    expect(numbersDrawn).toBe(0);

    // Completed while it is still a draft, it goes out — as an XRechnung.
    await call('put', `/api/customers/${customerId}`, {
      ...INCOMPLETE,
      einvoice_format: 'xrechnung',
      address: 'Kundenweg 5\n10115 Berlin',
      email: 'ap@kunde.de',
      buyer_reference: '04011000-12345-03',
    });
    expect((await call('get', `/api/invoices/${invoiceId}/einvoice`)).body.problems.xrechnung).toEqual([]);
    expect((await call('post', `/api/invoices/${invoiceId}/finalize`, { issue_date: '2026-10-21' })).status).toBe(200);
    expect(numbersDrawn).toBe(1);
    const xml = await call('get', `/api/invoices/${invoiceId}/xrechnung.xml`);
    expect(xml.status).toBe(200);
    expect(xml.text).toContain('<ram:PostcodeCode>10115</ram:PostcodeCode>');
  });

  it('checks only the format the customer receives', async () => {
    // ZUGFeRD EN 16931 needs neither the buyer reference nor the electronic address.
    const { invoiceId } = await draftFor({ ...INCOMPLETE, address: 'Kundenweg 5\n10115 Berlin', einvoice_format: 'zugferd' });
    expect((await call('post', `/api/invoices/${invoiceId}/finalize`, { issue_date: '2026-10-21' })).status).toBe(200);
    expect((await call('get', `/api/invoices/${invoiceId}/zugferd.pdf`)).status).toBe(200);
  });

  it('checks ebInterface as well', async () => {
    const { invoiceId } = await draftFor({ name: 'Wiener Kunde GmbH', vat_id: 'ATU12345678', address: 'Ring 5\nWien', country_code: 'AT', einvoice_format: 'ebinterface' });
    const refused = await call('post', `/api/invoices/${invoiceId}/finalize`, { issue_date: '2026-10-21' });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain('ebInterface');
    // "Wien" without a postcode line gives neither town nor postcode.
    expect(refused.body.details.map((d: { field: string }) => d.field)).toEqual(['customer.city', 'customer.postcode']);
  });

  it('refuses an unknown format on the customer', async () => {
    const bad = await call('post', '/api/customers', { ...INCOMPLETE, einvoice_format: 'pdf' });
    expect(bad.status).toBe(422);
    expect(bad.body.details.map((d: { field: string }) => d.field)).toEqual(['einvoice_format']);
  });
});

describe('a customer without an e-invoice format', () => {
  it('is not checked, but the draft still shows what is missing', async () => {
    for (const format of [null, 'none']) {
      const { invoiceId } = await draftFor({ ...INCOMPLETE, einvoice_format: format });
      const status = await call('get', `/api/invoices/${invoiceId}/einvoice`);
      expect(status.body.format).toBe(format);
      expect(status.body.problems.xrechnung.length).toBeGreaterThan(0);
      expect((await call('post', `/api/invoices/${invoiceId}/finalize`, { issue_date: '2026-10-21' })).status).toBe(200);
    }
  });

  it('says plainly that a sent invoice keeps its gaps', async () => {
    const { invoiceId } = await draftFor(INCOMPLETE);
    await call('post', `/api/invoices/${invoiceId}/finalize`, { issue_date: '2026-10-21' });
    const refused = await call('get', `/api/invoices/${invoiceId}/xrechnung.xml`);
    expect(refused.status).toBe(422);
    expect(refused.body.error).toContain('keeps its data as issued');
    expect(refused.body.error).toContain('cancel it and send a new one');
  });
});
