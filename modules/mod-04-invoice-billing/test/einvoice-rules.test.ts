import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { hasVatPrefix, isCountryCode } from '../shared/countries.js';
import { ebInterfaceProblems } from '../shared/ebinterface.js';
import { EINVOICE_PROFILES, eInvoiceProblems, mistypedLeitweg, renderCii, type EInvoiceModel } from '../shared/einvoice.js';
import { BASE, CASES } from './einvoice-cases.js';
import { MATRIX, REFUSED } from './einvoice-matrix.js';

/**
 * The rules the module checks before it renders, held to the artefacts —
 * review finding H2 in docs/E-RECHNUNG-REVIEW.md: files were served although
 * they failed validation (BR-CO-09, BR-CL-14, BR-G-02, BR-E-02) or carried
 * impossible dates. Here offline: the review's probes are refused, and every
 * matrix case the module accepts passes the Factur-X schema. The schematron
 * side runs in the e-invoice workflow (scripts/validate-einvoice.sh).
 */

const XSD = join(import.meta.dirname, 'schema', 'cii-en16931', 'FACTUR-X_EN16931.xsd');
const HAVE_XMLLINT = ((): boolean => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const terms = (model: EInvoiceModel, profile: 'xrechnung' | 'zugferd'): string[] => eInvoiceProblems(model, profile).map((p) => p.term);

describe("the review's probes are refused, by business term", () => {
  for (const [name, { model, term }] of Object.entries(REFUSED)) {
    it(`case ${name} (${term}) in both profiles`, () => {
      for (const profile of EINVOICE_PROFILES) expect(terms(model, profile)).toContain(term);
    });
  }

  it('names the rule each one breaks', () => {
    const messages = (name: string): string => eInvoiceProblems(REFUSED[name]!.model, 'xrechnung').map((p) => p.message).join(' | ');
    expect(messages('J')).toContain('BR-CO-09');
    expect(messages('K')).toContain('BR-CL-14');
    expect(messages('K')).toContain('GB');
    expect(messages('O')).toContain('"2026-02-31" is not a calendar date');
    expect(messages('P')).toContain('BR-G-02');
    expect(messages('Q')).toContain('BR-E-02');
  });

  it('refuses the same dates and countries in ebInterface', () => {
    const fields = (model: EInvoiceModel) => ebInterfaceProblems(model).map((p) => p.field);
    expect(fields(REFUSED.O!.model)).toEqual(expect.arrayContaining(['issue_date', 'delivery_date']));
    expect(fields(REFUSED.K!.model)).toContain('customer.country_code');
  });
});

describe('what the EN 16931 code lists accept', () => {
  it('takes Northern Ireland (XI) and Kosovo (1A), and refuses UK', () => {
    expect(isCountryCode('XI')).toBe(true);
    expect(isCountryCode('1A')).toBe(true);
    expect(isCountryCode('GB')).toBe(true);
    expect(isCountryCode('UK')).toBe(false);
    expect(isCountryCode('de')).toBe(false);
  });

  it('takes the Greek EL prefix in VAT ids only', () => {
    expect(hasVatPrefix('EL123456789')).toBe(true);
    expect(isCountryCode('EL')).toBe(false);
    expect(hasVatPrefix('XI 123 4567 89')).toBe(true);
    expect(hasVatPrefix('123456789')).toBe(false);
    expect(hasVatPrefix('EU372000041')).toBe(false); // non-Union OSS number, no country
  });
});

describe('texts that would render empty', () => {
  it('refuses a line made only of control characters, and drops such a note', () => {
    const control = { ...BASE, exemption: { category: 'AE' as const, reason: null }, lines: [{ ...BASE.lines[0]!, description: '\u0001\u0002' }] };
    expect(terms(control, 'zugferd')).toContain('BT-153');
    const note = { ...BASE, exemption: { category: 'AE' as const, reason: null }, note: '\u0007' };
    expect(terms(note, 'zugferd')).toEqual([]);
    expect(renderCii(note, 'zugferd')).not.toContain('<ram:IncludedNote>');
  });
});

describe('Leitweg-IDs carry their check digits (M5)', () => {
  it('accepts the example of the format specification and the ZRE test ID, in either case', () => {
    // Formatspezifikation Leitweg-ID 2.0.2, section 2.4; the ZRE publishes the second for tests.
    for (const id of ['04011000-1234512345-06', '991-33333TEST-33', '991-33333test-33']) expect(mistypedLeitweg(id)).toBe(false);
  });

  it('catches a typo in the check digits and anywhere before them', () => {
    // Case F of the review, a swapped digit, and the two IDs this suite used to carry.
    for (const id of ['04011000-1234512345-99', '04011000-1234512354-06', '04011000-12345-67', '991-12345-06']) {
      expect(mistypedLeitweg(id)).toBe(true);
    }
  });

  it('leaves anything of another shape alone', () => {
    for (const value of ['ap@kunde.de', 'PO-4711', '4711', '04011000-1234512345-6', '', null]) expect(mistypedLeitweg(value)).toBe(false);
  });

  const leitweg = CASES.leitweg!;
  const fields = (model: EInvoiceModel): string[] => eInvoiceProblems(model, 'xrechnung').map((p) => p.field);

  it('refuses a mistyped one as the electronic address, and as the reference of a buyer addressed by one', () => {
    expect(fields(leitweg)).toEqual([]);
    expect(fields({ ...leitweg, buyer: { ...leitweg.buyer, einvoice_address: '991-12345-37' } })).toContain('customer.einvoice_address');
    expect(fields({ ...leitweg, buyer_reference: '991-12345-37' })).toEqual(['buyer_reference']);
    expect(terms({ ...leitweg, buyer_reference: '991-12345-37' }, 'zugferd')).toEqual(['BT-10']);
  });

  it("does not take another buyer's order reference of the same shape for one", () => {
    // 4711-01 fails the check digits, but this buyer is addressed by email.
    expect(fields({ ...CASES.standard!, buyer_reference: '4711-01' })).toEqual([]);
  });
});

describe('the matrix', () => {
  const accepted = Object.entries(MATRIX).flatMap(([name, model]) =>
    EINVOICE_PROFILES.filter((p) => eInvoiceProblems(model, p).length === 0).map((p) => ({ name, profile: p, model })),
  );

  it('has accepted cases in every VAT category, both profiles and both document types', () => {
    for (const profile of EINVOICE_PROFILES) {
      for (const category of ['s19', 's7_19', 'e', 'e_s19', 'ae', 'k', 'g', 'z', 'o']) {
        expect(accepted.some((a) => a.profile === profile && a.name.startsWith(`${category}-`))).toBe(true);
      }
      expect(accepted.some((a) => a.profile === profile && a.model.type_code === '381')).toBe(true);
    }
  });

  it('gives every refused case a field to fix', () => {
    for (const [, model] of Object.entries(MATRIX)) {
      for (const profile of EINVOICE_PROFILES) {
        for (const problem of eInvoiceProblems(model, profile)) expect(problem.field).not.toBe('');
      }
    }
  });

  it.skipIf(!HAVE_XMLLINT)('passes the Factur-X EN16931 schema wherever it is accepted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mod04-matrix-'));
    try {
      const files = accepted.map(({ name, profile, model }) => {
        const file = join(dir, `${name}-${profile}.xml`);
        writeFileSync(file, renderCii(model, profile));
        return file;
      });
      // One xmllint for all of them; a non-zero exit names the failing files.
      execFileSync('xmllint', ['--noout', '--schema', XSD, ...files], { stdio: 'pipe' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── Through the API ──────────────────────────────────────────────────────

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's'.repeat(32), ttlHours: 1, secureCookie: false };
const seller = (): SellerConfig => ({
  name: 'Beispiel GmbH',
  addressLines: ['Hauptstraße 1', '80331 München', 'Deutschland'],
  vatId: 'DE123456789',
  iban: 'DE02 1203 0000 0000 2020 51',
  bic: 'BYLADEM1001',
  contactName: 'Erika Mustermann',
  phone: '+49 89 123456',
  email: 'rechnung@beispiel.de',
});

let app: Express;
let db: Database.Database;
let cookie: string;

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, auth, seller: seller() });
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'pw' });
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
});

const call = (method: 'get' | 'post' | 'put', url: string, body?: object) => {
  const r = request(app)[method](url).set('Cookie', cookie);
  return body ? r.send(body) : r;
};
const customer = { name: 'Kunde AG', email: 'ap@kunde.de', address: 'Kundenweg 5\n10115 Berlin', country_code: 'DE', buyer_reference: 'PO-1' };
const lines = [{ description: 'Beratung', quantity: 1, unit_price_cents: 10000, vat_rate: 19 }];

async function issued(values: Record<string, unknown>): Promise<number> {
  const c = await call('post', '/api/customers', { ...customer, ...values });
  expect(c.status).toBe(201);
  const d = await call('post', '/api/invoices', { customer_id: c.body.id, lines });
  expect((await call('post', `/api/invoices/${d.body.id}/finalize`, { issue_date: '2026-10-21' })).status).toBe(200);
  return d.body.id as number;
}

describe('the API refuses what used to reach the file', () => {
  it('J: a buyer VAT id without a country prefix stops the XRechnung', async () => {
    const id = await issued({ vat_id: '123456789' });
    const res = await call('get', `/api/invoices/${id}/xrechnung.xml`);
    expect(res.status).toBe(422);
    expect(res.body.details.map((d: { field: string }) => d.field)).toContain('customer.vat_id');
  });

  it('K: a country code outside the list is refused on the customer, and in old data at download', async () => {
    const bad = await call('post', '/api/customers', { ...customer, country_code: 'UK' });
    expect(bad.status).toBe(422);
    expect(bad.body.details[0].message).toContain('GB');
    expect((await call('put', '/api/settings/seller', { country: 'UK' })).status).toBe(422);

    // A row saved before the list was checked.
    const id = await issued({});
    const snapshot = JSON.parse((db.prepare('SELECT buyer_snapshot FROM invoices WHERE id = ?').get(id) as { buyer_snapshot: string }).buyer_snapshot);
    db.prepare('UPDATE invoices SET buyer_snapshot = ? WHERE id = ?').run(JSON.stringify({ ...snapshot, country: 'UK' }), id);
    const res = await call('get', `/api/invoices/${id}/xrechnung.xml`);
    expect(res.status).toBe(422);
    expect(res.body.details.map((d: { message: string }) => d.message.split(':')[0])).toContain('BT-55');
  });

  it('F: a mistyped Leitweg-ID is refused on the customer and in the seller settings', async () => {
    const field = (res: { body: { details: { field: string }[] } }) => res.body.details.map((d) => d.field);
    const address = await call('post', '/api/customers', { ...customer, einvoice_address: '04011000-1234512345-99' });
    expect(address.status).toBe(422);
    expect(field(address)).toEqual(['einvoice_address']);
    const reference = await call('post', '/api/customers', { ...customer, einvoice_address: '04011000-1234512345-06', buyer_reference: '04011000-1234512345-60' });
    expect(reference.status).toBe(422);
    expect(field(reference)).toEqual(['buyer_reference']);
    expect(reference.body.details[0].message).not.toContain('-06'); // no hint that would make a typo valid
    expect((await call('post', '/api/customers', { ...customer, buyer_reference: '4711-01' })).status).toBe(201);
    const settings = await call('put', '/api/settings/seller', { einvoiceAddress: '991-12345-06' });
    expect(settings.status).toBe(422);
    expect(field(settings)).toEqual(['einvoiceAddress']);
  });

  it('O: impossible calendar dates are refused on the draft, at issue and on a credit note', async () => {
    const c = await call('post', '/api/customers', { ...customer, vat_id: 'DE987654321' });
    const draft = await call('post', '/api/invoices', { customer_id: c.body.id, delivery_date: '2026-02-30', lines });
    expect(draft.status).toBe(422);
    expect(draft.body.details.map((d: { field: string }) => d.field)).toEqual(['delivery_date']);

    const ok = await call('post', '/api/invoices', { customer_id: c.body.id, lines });
    const fin = await call('post', `/api/invoices/${ok.body.id}/finalize`, { issue_date: '2026-02-31' });
    expect(fin.status).toBe(422);
    expect(fin.body.details.map((d: { field: string }) => d.field)).toEqual(['issue_date']);

    await call('post', `/api/invoices/${ok.body.id}/finalize`, { issue_date: '2026-10-21' });
    const note = await call('post', `/api/invoices/${ok.body.id}/credit-notes`, { reason: 'Teil zurück', issue_date: '2026-11-31', lines });
    expect(note.status).toBe(422);
    expect(note.body.details.map((d: { field: string }) => d.field)).toContain('issue_date');
  });
});
