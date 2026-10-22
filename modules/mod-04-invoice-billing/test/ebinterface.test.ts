import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import type { EInvoiceModel } from '../shared/einvoice.js';
import { ebCategoryOf, ebInterfaceProblems, NO_VAT_ID, renderEbInterface } from '../shared/ebinterface.js';
import { CASES } from './einvoice-cases.js';
import { AT_BASE, AT_CASES } from './ebinterface-cases.js';

/**
 * ebInterface 6.1 — the Austrian e-invoice (shared/ebinterface.ts).
 *
 * Every case is validated against the official schema, `Invoice.xsd` 6.1 as
 * published by AUSTRIAPRO (test/schema/ebinterface-6p1/), with xmllint. The
 * schema's own sample passes and its deliberately broken sample fails, so a
 * green run here means the validator actually looked. What the schema cannot
 * check — the arithmetic, the tax summary, the credit-note semantics — is
 * asserted below from the specification (ebInvoice_6p1.pdf, 14.11.2023).
 */

const SCHEMA_DIR = join(import.meta.dirname, 'schema', 'ebinterface-6p1');
const XSD = join(SCHEMA_DIR, 'Invoice.xsd');
const FIXTURES = join(import.meta.dirname, 'fixtures', 'ebinterface');

const HAVE_XMLLINT = ((): boolean => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const ALL: Record<string, EInvoiceModel> = { ...AT_CASES, ...CASES };

function xmllint(file: string): void {
  execFileSync('xmllint', ['--noout', '--schema', XSD, file], { stdio: 'pipe' });
}

/** Every value of a leaf element, in document order. */
function values(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}(?: [^>]*)?>([^<]*)</${tag}>`, 'g'))].map((m) => m[1]!);
}

const cents = (decimal: string): number => Math.round(Number(decimal) * 100);

describe.skipIf(!HAVE_XMLLINT)('the official ebInterface 6.1 schema', () => {
  it('is the real check: the published sample passes, the published broken sample fails', () => {
    xmllint(join(SCHEMA_DIR, 'ebinterface_6p1_sample_more_consistent.xml'));
    expect(() => xmllint(join(SCHEMA_DIR, 'ebinterface_6p1_sample_ecosio_invalid.xml'))).toThrow();
  });

  it('accepts every case — Austrian and German sellers, every VAT situation, the credit note', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mod04-ebi-'));
    try {
      for (const [name, model] of Object.entries(ALL)) {
        expect({ name, problems: ebInterfaceProblems(model) }).toEqual({ name, problems: [] });
        const file = join(dir, `${name}.xml`);
        writeFileSync(file, renderEbInterface(model));
        xmllint(file);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('golden files', () => {
  for (const [name, model] of Object.entries(AT_CASES)) {
    it(`${name} renders exactly as validated`, () => {
      expect(renderEbInterface(model)).toBe(readFileSync(join(FIXTURES, `${name}.xml`), 'utf8'));
    });
  }
});

describe('what the schema cannot check', () => {
  it('adds up: Σ LineItemAmount + Σ TaxAmount = TotalGrossAmount = PayableAmount', () => {
    for (const [name, model] of Object.entries(ALL)) {
      const xml = renderEbInterface(model);
      const lines = values(xml, 'LineItemAmount').map(cents).reduce((a, b) => a + b, 0);
      const tax = values(xml, 'TaxAmount').map(cents).reduce((a, b) => a + b, 0);
      const [gross] = values(xml, 'TotalGrossAmount').map(cents);
      const [payable] = values(xml, 'PayableAmount').map(cents);
      expect({ name, sum: lines + tax }).toEqual({ name, sum: gross });
      expect(payable).toBe(gross);
    }
  });

  it('summarises the lines per (rate, category), as the specification aggregates them', () => {
    const xml = renderEbInterface(AT_BASE);
    const summary = xml.slice(xml.indexOf('<Tax>'), xml.indexOf('</Tax>'));
    expect(values(summary, 'TaxableAmount')).toEqual(['49.98', '12.50', '1200.99']);
    expect([...summary.matchAll(/TaxCategoryCode="(\w+)">(\d+)</g)].map((m) => `${m[1]} ${m[2]}`)).toEqual(['AA 10', 'AA 13', 'S 20']);
    // Tax is rounded once per rate (49.98 × 10 % = 5.00; 1200.99 × 20 % = 240.20).
    expect(values(summary, 'TaxAmount')).toEqual(['5.00', '1.63', '240.20']);
  });

  it('uses S for the seller country’s standard rate and AA for a reduced one', () => {
    expect(ebCategoryOf(20, 'AT', null)).toBe('S');
    expect(ebCategoryOf(13, 'AT', null)).toBe('AA');
    expect(ebCategoryOf(19, 'DE', null)).toBe('S');
    expect(ebCategoryOf(7, 'DE', null)).toBe('AA');
    expect(ebCategoryOf(0, 'AT', { category: 'AE', reason: null })).toBe('AE');
  });

  it('writes ATU00000000 for a party without a VAT id, as the specification prescribes', () => {
    const xml = renderEbInterface(AT_CASES['at-kleinunternehmer']!);
    expect(values(xml, 'VATIdentificationNumber')[0]).toBe(NO_VAT_ID);
    expect(xml).toContain('<Comment>Umsatzsteuerbefreit – Kleinunternehmer gem. § 6 Abs. 1 Z 27 UStG</Comment>');
  });

  it('carries the federal supplier number and order reference where the Republic reads them', () => {
    const xml = renderEbInterface(AT_CASES['at-bund']!);
    expect(xml).toContain('<InvoiceRecipientsBillerID>312345</InvoiceRecipientsBillerID>');
    expect(xml).toMatch(/<InvoiceRecipient>[\s\S]*<OrderID>4711000123<\/OrderID>[\s\S]*<\/InvoiceRecipient>/);
    expect(xml).toContain('<FurtherIdentification IdentificationType="FN">123456a</FurtherIdentification>');
  });

  it('issues a cancellation as a positive CreditMemo naming the cancelled invoice, with nothing to pay', () => {
    const xml = renderEbInterface(AT_CASES['at-storno']!);
    expect(xml).toContain('DocumentType="CreditMemo"');
    expect(xml).toMatch(/<CancelledOriginalDocument>\s*<InvoiceNumber>RE-2026-0042<\/InvoiceNumber>\s*<InvoiceDate>2026-10-21<\/InvoiceDate>/);
    expect(cents(values(xml, 'PayableAmount')[0]!)).toBeGreaterThan(0);
    expect(xml).not.toContain('<PaymentMethod>');
    expect(xml).not.toContain('<DueDate>');
  });

  it('refuses rather than writes what ebInterface would reject', () => {
    const terms = (model: EInvoiceModel) => ebInterfaceProblems(model).map((p) => p.term);
    expect(terms({ ...AT_BASE, buyer: { ...AT_BASE.buyer, postcode: null, city: null } })).toEqual(['BT-52', 'BT-53']);
    expect(terms({ ...AT_BASE, lines: [{ position: 1, description: 'x', quantity: 1, unit_price_cents: 100, vat_rate: 0 }] })).toEqual(['BT-118']);
    expect(terms({ ...AT_BASE, seller: { ...AT_BASE.seller, vat_id: 'ATU00000000' } })).toEqual(['BT-31']);
    // Unlike XRechnung, ebInterface needs no seller contact and no buyer reference.
    expect(terms({ ...AT_BASE, buyer_reference: null, seller: { ...AT_BASE.seller, contact_name: null, phone: null } })).toEqual([]);
  });
});

// ── Through the API ─────────────────────────────────────────────────────

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's', ttlHours: 1, secureCookie: false };

function austrianSeller(): SellerConfig {
  return {
    name: 'Muster GmbH',
    addressLines: ['Lassallestraße 5', '1020 Wien', 'Österreich'],
    vatId: 'ATU12345678',
    iban: 'AT61 1904 3002 3457 3201',
    bic: 'BKAUATWW',
    contactName: 'Max Muster',
    phone: '+43 1 234567',
    email: 'rechnung@muster.at',
  };
}

let app: Express;
let db: Database.Database;
let cookie: string;

async function boot(): Promise<void> {
  db = openDb(':memory:');
  app = createApp({ db, auth, seller: austrianSeller() });
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'pw' });
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
}

async function customer(values: Record<string, unknown> = {}): Promise<number> {
  const res = await request(app)
    .post('/api/customers')
    .set('Cookie', cookie)
    .send({
      name: 'Bundesministerium für Beispiele',
      email: 'rechnung@bmb.gv.at',
      address: 'Minoritenplatz 5\n1010 Wien',
      country_code: 'AT',
      buyer_reference: '4711000123',
      supplier_number: '312345',
      ...values,
    });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

async function issued(customerId: number): Promise<number> {
  const draft = await request(app)
    .post('/api/invoices')
    .set('Cookie', cookie)
    .send({
      customer_id: customerId,
      lines: [
        { description: 'Wartung', quantity: 4, unit_price_cents: 9500, vat_rate: 20 },
        { description: 'Fachbuch', quantity: 1, unit_price_cents: 3990, vat_rate: 10 },
      ],
    });
  expect(draft.status).toBe(201);
  const fin = await request(app).post(`/api/invoices/${draft.body.id}/finalize`).set('Cookie', cookie).send({ issue_date: '2026-10-21' });
  expect(fin.status).toBe(200);
  return draft.body.id as number;
}

describe('ebInterface through the API', () => {
  beforeEach(boot);

  it('serves the issued invoice as ebInterface, with the federal identifiers, and it validates', async () => {
    const id = await issued(await customer());
    const res = await request(app).get(`/api/invoices/${id}/ebinterface.xml`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.headers['content-disposition']).toMatch(/_ebinterface\.xml"/);
    expect(res.text).toContain('<InvoiceRecipientsBillerID>312345</InvoiceRecipientsBillerID>');
    expect(res.text).toContain('<OrderID>4711000123</OrderID>');
    expect(res.text).toContain('<PayableAmount>499.89</PayableAmount>');
    if (HAVE_XMLLINT) {
      const dir = mkdtempSync(join(tmpdir(), 'mod04-ebi-api-'));
      try {
        writeFileSync(join(dir, 'api.xml'), res.text);
        xmllint(join(dir, 'api.xml'));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('freezes the supplier number at issue, like every other party field', async () => {
    const customerId = await customer();
    const id = await issued(customerId);
    const before = (await request(app).get(`/api/invoices/${id}/ebinterface.xml`).set('Cookie', cookie)).text;
    await request(app)
      .put(`/api/customers/${customerId}`)
      .set('Cookie', cookie)
      .send({ name: 'Anderes Ministerium', address: 'Minoritenplatz 5\n1010 Wien', supplier_number: '999999' });
    expect((await request(app).get(`/api/invoices/${id}/ebinterface.xml`).set('Cookie', cookie)).text).toBe(before);
  });

  it('lists ebInterface beside XRechnung and ZUGFeRD in the readiness check, and refuses with 422 first', async () => {
    const id = await issued(await customer({ address: 'Minoritenplatz 5' }));
    const ready = await request(app).get(`/api/invoices/${id}/einvoice`).set('Cookie', cookie);
    expect(ready.body.problems.ebinterface.map((p: { term: string }) => p.term)).toEqual(['BT-52', 'BT-53']);
    const res = await request(app).get(`/api/invoices/${id}/ebinterface.xml`).set('Cookie', cookie);
    expect(res.status).toBe(422);
  });

  it('serves the cancellation as a CreditMemo', async () => {
    const id = await issued(await customer());
    await request(app).post(`/api/invoices/${id}/cancel`).set('Cookie', cookie).send({ reason: 'Doppelt verrechnet' }).expect(200);
    const res = await request(app).get(`/api/invoices/${id}/ebinterface.xml?document=cancellation`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.text).toContain('DocumentType="CreditMemo"');
    expect(res.text).toContain('<CancelledOriginalDocument>');
  });

  it('reports the seller side for ebInterface on the settings banner too', async () => {
    const res = await request(app).get('/api/einvoice-config').set('Cookie', cookie);
    expect(res.body.problems.ebinterface).toEqual([]);
  });
});
