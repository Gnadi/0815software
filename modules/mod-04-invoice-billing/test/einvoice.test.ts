import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { buildPlatform } from '../server/platform.js';
import type { AuthConfig, SellerConfig } from '../server/config.js';
import { toEInvoice } from '../server/einvoice.js';
// The REAL PS-12 service, in-process. This suite is the only place the two
// halves of the e-invoicing story meet, so a mock here would test nothing.
import { createApp as createEInvoiceApp } from '../../../platform/ps-12-einvoice/server/app.js';
import { openDb as openEInvoiceDb } from '../../../platform/ps-12-einvoice/server/db.js';

/**
 * MOD-04 → PS-12: issuing the invoice this module already has as an EN 16931
 * document.
 *
 * The properties under test are about what happens when the data ISN'T there,
 * because that is the normal case and the expensive one:
 *
 *  - A country code is mandatory (BT-40/BT-55) and this module stores addresses
 *    as free text. It comes from PS-11 or it comes from nowhere — never from a
 *    regex over an address line, because a guessed address produces a document
 *    the recipient's system rejects weeks later, silently.
 *  - A 0 % line does not say what it means. Zero-rated, exempt, reverse
 *    charge, intra-community, export and out-of-scope all show 0 %, and all
 *    but zero-rated legally require a stated reason.
 *
 * In both cases the module reports the missing field and refuses, rather than
 * filling it in with something plausible.
 */

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

function sellerConfig(overrides: Partial<SellerConfig> = {}): SellerConfig {
  return {
    name: '0815software GmbH',
    addressLines: ['Teststraße 1', '4020 Linz', 'Austria'],
    vatId: 'ATU12345678',
    iban: 'AT611904300234573201',
    bic: 'BKAUATWW',
    email: 'rechnung@0815software.example',
    street: 'Teststraße 1',
    postcode: '4020',
    city: 'Linz',
    countryCode: 'AT',
    ...overrides,
  };
}

let einvoiceServer: Server | null = null;
let einvoiceUrl = '';
let einvoiceDb: Database.Database | null = null;

/**
 * A FRESH PS-12 per test, because MOD-04 gets a fresh database per test and
 * its numbering restarts at INV-2026-0001. A PS-12 that outlived it would
 * legitimately replay the previous test's document — its idempotency is per
 * (source, invoice number), and those numbers would genuinely collide. Sharing
 * one service across the file would therefore test the replay path everywhere
 * and the issue path nowhere.
 */
function startEInvoice(): void {
  einvoiceDb = openEInvoiceDb(':memory:');
  einvoiceServer = createEInvoiceApp({
    db: einvoiceDb,
    auth: {
      username: 'admin',
      password: 'p',
      secret: 's',
      ttlHours: 1,
      secureCookie: false,
      serviceToken: 'test-service',
    },
  }).listen(0);
  einvoiceUrl = `http://127.0.0.1:${(einvoiceServer.address() as AddressInfo).port}`;
}

afterEach(() => {
  einvoiceServer?.close();
  einvoiceDb?.close();
  einvoiceServer = null;
  einvoiceDb = null;
});

let db: Database.Database;
let app: Express;
let cookie: string;

/** Build an app; `platformOn` wires PS-12 and a stub PS-11 party address. */
async function harness(opts: { platformOn?: boolean; seller?: Partial<SellerConfig>; buyerCountry?: string | null } = {}) {
  db = openDb(':memory:');
  const seller = sellerConfig(opts.seller);
  if (opts.platformOn) startEInvoice();
  const platform = opts.platformOn
    ? buildPlatform({ einvoiceUrl, serviceToken: 'test-service', einvoiceProfile: 'en16931' })
    : undefined;
  // PS-11 is not booted here; the buyer address is injected through the same
  // hook the real client fills, which is what the route actually depends on.
  const wired = platform
    ? {
        ...platform,
        async fetchPartyAddress() {
          return opts.buyerCountry === null
            ? null
            : { street: 'Hafenstraße 4', postcode: '20359', city: 'Hamburg', country_code: opts.buyerCountry ?? 'DE' };
        },
      }
    : undefined;
  app = createApp({ db, auth, seller, platform: wired });
  const login = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  cookie = login.headers['set-cookie']![0]!.split(';')[0]!;
  return { seller };
}

/** A customer linked to a PS-11 party, so the address hook is reached. */
async function makeCustomer(): Promise<number> {
  const res = await request(app)
    .post('/api/customers')
    .set('Cookie', cookie)
    .send({ name: 'Nordwind AG', email: 'rechnungen@nordwind.example', vat_id: 'DE811234567', address: 'Hafenstraße 4\n20359 Hamburg' });
  expect(res.status).toBe(201);
  db.prepare('UPDATE customers SET party_id = 7 WHERE id = ?').run(res.body.id);
  return res.body.id as number;
}

/** A SENT invoice — a draft has no number and cannot be an e-invoice. */
async function sentInvoice(lines: Record<string, unknown>[]): Promise<number> {
  const customerId = await makeCustomer();
  const draft = await request(app)
    .post('/api/invoices')
    .set('Cookie', cookie)
    .send({ customer_id: customerId, payment_terms_days: 14, lines });
  expect(draft.status).toBe(201);
  const sent = await request(app).post(`/api/invoices/${draft.body.id}/finalize`).set('Cookie', cookie).send({});
  expect(sent.status).toBe(200);
  return draft.body.id as number;
}

const STANDARD_LINE = { description: 'Consulting', quantity: 2, unit_price_cents: 1234, vat_rate: 20 };

describe('with PS-12 unconfigured, nothing changes', () => {
  beforeEach(async () => {
    await harness({ platformOn: false });
  });

  // The whole opt-in promise: a deployment that never heard of e-invoicing
  // behaves exactly as it always did, and the PDF is untouched.
  it('503s the e-invoice routes and still serves the PDF', async () => {
    const id = await sentInvoice([STANDARD_LINE]);
    for (const path of [`/api/invoices/${id}/einvoice`, `/api/invoices/${id}/einvoice.xml`]) {
      const res = await request(app).get(path).set('Cookie', cookie);
      expect(res.status, path).toBe(503);
      expect(res.body.error).toContain('EINVOICE_URL');
    }
    const pdf = await request(app).get(`/api/invoices/${id}/pdf`).set('Cookie', cookie);
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
  });
});

describe('issuing an e-invoice end to end', () => {
  beforeEach(async () => {
    await harness({ platformOn: true });
  });

  it('reports readiness before anything is issued', async () => {
    const id = await sentInvoice([STANDARD_LINE]);
    const res = await request(app).get(`/api/invoices/${id}/einvoice`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ profile: 'en16931', ready: true, gaps: [], violations: [] });
  });

  it('issues, and the XML carries the same money the PDF does', async () => {
    const id = await sentInvoice([STANDARD_LINE]);
    const res = await request(app).post(`/api/invoices/${id}/einvoice`).set('Cookie', cookie).send({});
    expect(res.status).toBe(201);
    expect(res.body.document.profile).toBe('en16931');

    // 2 × 12.34 = 24.68 net, 20 % = 4.94, gross 29.62 — the same numbers the
    // API reports, because both come from shared/money.ts.
    const detail = await request(app).get(`/api/invoices/${id}`).set('Cookie', cookie);
    expect(detail.body.gross_cents).toBe(2962);
    expect(res.body.xml).toContain('<ram:GrandTotalAmount>29.62</ram:GrandTotalAmount>');
    expect(res.body.xml).toContain('<ram:CountryID>AT</ram:CountryID>');
    expect(res.body.xml).toContain('<ram:CountryID>DE</ram:CountryID>');
  });

  it('serves the file, and issuing twice returns the same document', async () => {
    const id = await sentInvoice([STANDARD_LINE]);
    const file = await request(app).get(`/api/invoices/${id}/einvoice.xml`).set('Cookie', cookie);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('application/xml');
    expect(file.headers['content-disposition']).toMatch(/INV-\d{4}-\d{4}\.xml/);

    const again = await request(app).post(`/api/invoices/${id}/einvoice`).set('Cookie', cookie).send({});
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(again.body.xml).toBe(file.text);
  });

  it('refuses a draft — an e-invoice for a document with no number is not a thing', async () => {
    const customerId = await makeCustomer();
    const draft = await request(app)
      .post('/api/invoices')
      .set('Cookie', cookie)
      .send({ customer_id: customerId, payment_terms_days: 14, lines: [STANDARD_LINE] });
    const res = await request(app).get(`/api/invoices/${draft.body.id}/einvoice`).set('Cookie', cookie);
    expect(res.body.ready).toBe(false);
    expect(res.body.gaps[0].message).toContain('only a sent invoice');
  });
});

describe('the gaps it refuses to guess at', () => {
  it('names the missing SELLER country code instead of inventing one', async () => {
    await harness({ platformOn: true, seller: { countryCode: null } });
    const id = await sentInvoice([STANDARD_LINE]);

    const check = await request(app).get(`/api/invoices/${id}/einvoice`).set('Cookie', cookie);
    expect(check.body.ready).toBe(false);
    expect(check.body.gaps[0].field).toBe('seller.country_code');
    expect(check.body.gaps[0].message).toContain('PS-11');

    const issued = await request(app).post(`/api/invoices/${id}/einvoice`).set('Cookie', cookie).send({});
    expect(issued.status).toBe(422);
  });

  it('names the missing BUYER country code', async () => {
    await harness({ platformOn: true, buyerCountry: null });
    const id = await sentInvoice([STANDARD_LINE]);
    const res = await request(app).get(`/api/invoices/${id}/einvoice`).set('Cookie', cookie);
    expect(res.body.ready).toBe(false);
    expect(res.body.gaps.map((g: { field: string }) => g.field)).toContain('buyer.country_code');
  });

  // The 0 % trap. "Reverse charge is just a 0 % line with a note" is fine on a
  // PDF a human reads and wrong in a document a tax authority parses.
  it('refuses a 0 % line that does not say what it means', async () => {
    await harness({ platformOn: true });
    const id = await sentInvoice([{ description: 'Export', quantity: 1, unit_price_cents: 10_000, vat_rate: 0 }]);
    const res = await request(app).get(`/api/invoices/${id}/einvoice`).set('Cookie', cookie);
    expect(res.body.ready).toBe(false);
    expect(res.body.gaps[0].field).toBe('lines[1].vat_category');
    expect(res.body.gaps[0].message).toContain('reverse charge');
  });

  it('accepts a 0 % line once the category and reason are stated', async () => {
    await harness({ platformOn: true });
    const id = await sentInvoice([
      {
        description: 'Intra-community supply',
        quantity: 1,
        unit_price_cents: 10_000,
        vat_rate: 0,
        vat_category: 'K',
        vat_exemption_reason: 'Intra-community supply, Art. 138 VAT Directive',
      },
    ]);
    const res = await request(app).post(`/api/invoices/${id}/einvoice`).set('Cookie', cookie).send({});
    expect(res.status).toBe(201);
    expect(res.body.xml).toContain('<ram:CategoryCode>K</ram:CategoryCode>');
    expect(res.body.xml).toContain('Intra-community supply, Art. 138 VAT Directive');
  });

  it('requires a reason for a category that legally needs one', async () => {
    await harness({ platformOn: true });
    const id = await sentInvoice([
      { description: 'Reverse charged', quantity: 1, unit_price_cents: 10_000, vat_rate: 0, vat_category: 'AE' },
    ]);
    const res = await request(app).get(`/api/invoices/${id}/einvoice`).set('Cookie', cookie);
    expect(res.body.ready).toBe(false);
    expect(res.body.gaps[0].field).toBe('lines[1].vat_exemption_reason');
  });

  it('needs no category at all for a rate above 0 — there is nothing ambiguous', async () => {
    await harness({ platformOn: true });
    const id = await sentInvoice([STANDARD_LINE]);
    const detail = await request(app).get(`/api/invoices/${id}`).set('Cookie', cookie);
    expect(detail.body.lines[0].vat_category).toBe('S');
  });
});

describe('the mapping itself', () => {
  // A mixed invoice is where a breakdown grouped only by RATE goes wrong: two
  // 0 % lines of different categories are one rate and two breakdown rows.
  it('splits the VAT breakdown by category, not only by rate', async () => {
    await harness({ platformOn: true });
    const id = await sentInvoice([
      STANDARD_LINE,
      {
        description: 'EU supply',
        quantity: 1,
        unit_price_cents: 50_000,
        vat_rate: 0,
        vat_category: 'K',
        vat_exemption_reason: 'Intra-community supply',
      },
      {
        description: 'Export',
        quantity: 1,
        unit_price_cents: 30_000,
        vat_rate: 0,
        vat_category: 'G',
        vat_exemption_reason: 'Export outside the EU',
      },
    ]);
    const res = await request(app).post(`/api/invoices/${id}/einvoice`).set('Cookie', cookie).send({});
    expect(res.status).toBe(201);
    const categories = [...res.body.xml.matchAll(/<ram:CategoryCode>(\w+)<\/ram:CategoryCode>/g)].map(
      (m: RegExpMatchArray) => m[1],
    );
    // Three lines and three breakdown rows — S, K and G each appear twice.
    expect(categories.filter((c: string) => c === 'K')).toHaveLength(2);
    expect(categories.filter((c: string) => c === 'G')).toHaveLength(2);
    // 24.68 (20 %) + 500.00 + 300.00 = 824.68 net, 4.94 VAT, 829.62 gross.
    expect(res.body.xml).toContain('<ram:LineTotalAmount>824.68</ram:LineTotalAmount>');
    expect(res.body.xml).toContain('<ram:GrandTotalAmount>829.62</ram:GrandTotalAmount>');
  });

  it('reports every gap at once rather than one per round trip', () => {
    const result = toEInvoice({
      invoice: {
        id: 1,
        number: 'INV-2026-0001',
        issue_date: '2026-07-20',
        due_date: null,
        lines: [
          { id: 1, invoice_id: 1, position: 1, description: 'X', quantity: 1, unit_price_cents: 100, vat_rate: 0, vat_category: null, net_cents: 100 },
        ],
        note: null,
        paid_cents: 0,
      } as never,
      customer: { id: 1, name: 'C', email: null, vat_id: null, address: null, created_at: '' },
      seller: sellerConfig({ countryCode: null }),
      sellerAddress: { country_code: null },
      buyerAddress: null,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.gaps.map((g) => g.field)).toEqual([
      'seller.country_code',
      'buyer.country_code',
      'lines[1].vat_category',
    ]);
  });
});

describe('the ZUGFeRD hybrid: one file, both readings', () => {
  beforeEach(async () => {
    await harness({ platformOn: true });
  });

  it('serves the real PDF with the real XML inside it', async () => {
    const id = await sentInvoice([STANDARD_LINE]);

    const plain = await request(app).get(`/api/invoices/${id}/pdf`).set('Cookie', cookie);
    expect(plain.status).toBe(200);

    const hybrid = await request(app).get(`/api/invoices/${id}/einvoice.pdf`).set('Cookie', cookie);
    expect(hybrid.status).toBe(200);
    expect(hybrid.headers['content-type']).toContain('application/pdf');

    const plainBytes = Buffer.from(plain.body as Buffer);
    const hybridBytes = Buffer.from(hybrid.body as Buffer);

    // The VISIBLE invoice is byte-for-byte the one this module has always
    // rendered — PS-12 appends, it never redraws. That is the property that
    // lets the two routes exist without the documents drifting apart.
    expect(hybridBytes.subarray(0, plainBytes.length).equals(plainBytes)).toBe(true);
    expect(hybridBytes.length).toBeGreaterThan(plainBytes.length);

    // And a reader finds the invoice data where ZUGFeRD says it will be.
    const text = hybridBytes.toString('latin1');
    expect(text).toContain('factur-x.xml');
    expect(text).toContain('/AFRelationship /Alternative');
    expect(text).toContain('<ram:GrandTotalAmount>29.62</ram:GrandTotalAmount>');
  });

  it('refuses the hybrid for the same reasons it refuses the XML', async () => {
    await harness({ platformOn: true, buyerCountry: null });
    const id = await sentInvoice([STANDARD_LINE]);
    const res = await request(app).get(`/api/invoices/${id}/einvoice.pdf`).set('Cookie', cookie);
    expect(res.status).toBe(422);
    expect(res.body.details.map((d: { field: string }) => d.field)).toContain('buyer.country_code');
  });

  it('503s when PS-12 is not configured, like the other e-invoice routes', async () => {
    await harness({ platformOn: false });
    const id = await sentInvoice([STANDARD_LINE]);
    const res = await request(app).get(`/api/invoices/${id}/einvoice.pdf`).set('Cookie', cookie);
    expect(res.status).toBe(503);
  });
});
