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
import { ebInterfaceProblems, renderEbInterface } from '../shared/ebinterface.js';
import {
  EINVOICE_PROFILES,
  eInvoiceProblems,
  mistypedLeitweg,
  parseElectronicAddress,
  parseSchemeIdentifier,
  PLACEHOLDER_BIC,
  PLACEHOLDER_IBAN,
  renderCii,
  type EInvoiceModel,
} from '../shared/einvoice.js';
import { EAS_CODES, ICD_CODES } from '../shared/schemes.js';
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
    expect(messages('R')).toContain('"Buchhaltung, Frau Meier" is neither an email address, a Leitweg-ID nor a Peppol ID');
    expect(messages('T')).toContain('BT-29');
    expect(messages('U')).toContain('BR-CL-10');
    expect(messages('H')).toContain('shipped placeholder AT00 0000 0000 0000 0000');
    expect(messages('V')).toContain('shipped placeholder EXAMPLEX');
    expect(messages('W')).toContain('DE02 1203 0000 0000 2020 15: IBAN check digits do not match');
  });

  it('refuses the same dates, countries and payment details in ebInterface', () => {
    const fields = (model: EInvoiceModel) => ebInterfaceProblems(model).map((p) => p.field);
    expect(fields(REFUSED.O!.model)).toEqual(expect.arrayContaining(['issue_date', 'delivery_date']));
    expect(fields(REFUSED.K!.model)).toContain('customer.country_code');
    for (const name of ['H', 'W']) expect(fields(REFUSED[name]!.model)).toContain('seller.iban');
    expect(fields(REFUSED.V!.model)).toContain('seller.bic');
  });
});

describe('an account someone can pay into, a phone someone can call (N2)', () => {
  it('does not check the account of a credit note, which names none', () => {
    const gs = MATRIX['s19-vat_taxno-at_vat-gs']!;
    const note: EInvoiceModel = { ...gs, seller: { ...gs.seller, iban: PLACEHOLDER_IBAN, bic: PLACEHOLDER_BIC } };
    expect(eInvoiceProblems(note, 'xrechnung')).toEqual([]);
    for (const profile of EINVOICE_PROFILES) expect(eInvoiceProblems(note, profile)).toEqual(eInvoiceProblems(gs, profile));
    expect(ebInterfaceProblems(note)).toEqual(ebInterfaceProblems(gs));
  });

  it('writes the BIC without spaces and in capitals, which the ebInterface schema requires', () => {
    const standard = CASES.standard!;
    const spaced: EInvoiceModel = { ...standard, seller: { ...standard.seller, bic: 'byla dem1 001' } };
    expect(eInvoiceProblems(spaced, 'xrechnung')).toEqual([]);
    expect(renderCii(spaced, 'xrechnung')).toContain('<ram:BICID>BYLADEM1001</ram:BICID>');
    expect(renderEbInterface(spaced)).toContain('<BIC>BYLADEM1001</BIC>');
  });

  it('refuses a phone with fewer than three digits for XRechnung (BR-DE-27), which alone asks for one', () => {
    const standard = CASES.standard!;
    const phone = (value: string): EInvoiceModel => ({ ...standard, seller: { ...standard.seller, phone: value } });
    expect(eInvoiceProblems(phone('n/a'), 'xrechnung')).toEqual([
      { term: 'BT-42', field: 'seller.phone', message: 'Seller phone "n/a" has fewer than three digits — XRechnung expects a number to call (BR-DE-27)' },
    ]);
    expect(eInvoiceProblems(phone('n/a'), 'zugferd')).toEqual([]);
    expect(eInvoiceProblems(phone('112'), 'xrechnung')).toEqual([]);
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

describe('electronic addresses are an email, a Leitweg-ID or a Peppol ID (M4)', () => {
  it('reads each with its scheme', () => {
    expect(parseElectronicAddress('ap@kunde.de')).toEqual({ scheme: 'EM', value: 'ap@kunde.de' });
    expect(parseElectronicAddress('991-33333TEST-33')).toEqual({ scheme: '0204', value: '991-33333TEST-33' });
    expect(parseElectronicAddress('0204:991-33333TEST-33')).toEqual({ scheme: '0204', value: '991-33333TEST-33' });
    expect(parseElectronicAddress('0088:4012345000009')).toEqual({ scheme: '0088', value: '4012345000009' });
    expect(parseElectronicAddress(' 9930:DE987654321 ')).toEqual({ scheme: '9930', value: 'DE987654321' });
  });

  it('refuses free text, a scheme not in the EAS list, and a value its scheme does not fit', () => {
    for (const raw of ['Buchhaltung, Frau Meier', 'Rechnungseingang Buchhaltung', '1234:xyz', '0204:Buchhaltung', 'EM:niemand', '0088:', '']) {
      expect(parseElectronicAddress(raw), raw).toBeNull();
    }
  });

  it('takes the address schemes from BR-CL-25 and the identifier schemes from BR-CL-10', () => {
    for (const code of ['EM', '0204', '0088', '9930', '9914']) expect(EAS_CODES.has(code)).toBe(true);
    expect(EAS_CODES.has('0001')).toBe(false);
    for (const code of ['0060', '0088', '0204']) expect(ICD_CODES.has(code)).toBe(true);
    for (const code of ['0092', '0249', 'EM']) expect(ICD_CODES.has(code)).toBe(false);
    expect(parseSchemeIdentifier('0088:4000001000005')).toEqual({ scheme: '0088', value: '4000001000005' });
    expect(parseSchemeIdentifier('9930:DE123456789')).toBeNull(); // an address scheme, not ISO 6523
  });

  it('writes a Peppol ID with its own scheme, and checks a Leitweg-ID written with its scheme', () => {
    const standard = CASES.standard!;
    const peppol = { ...standard, buyer: { ...standard.buyer, einvoice_address: '9930:DE987654321' } };
    expect(eInvoiceProblems(peppol, 'xrechnung')).toEqual([]);
    expect(renderCii(peppol, 'xrechnung')).toContain('<ram:URIID schemeID="9930">DE987654321</ram:URIID>');
    const mistyped = { ...standard, buyer: { ...standard.buyer, einvoice_address: '0204:991-12345-06' } };
    expect(terms(mistyped, 'xrechnung')).toContain('BT-49');
  });

  it('refuses an email field that is not one when it stands in for the address', () => {
    const standard = CASES.standard!;
    const legacy = { ...standard, buyer: { ...standard.buyer, email: 'Frau Meier' } };
    expect(eInvoiceProblems(legacy, 'zugferd').map((p) => p.field)).toEqual(['customer.email']);
  });
});

describe('a seller with neither VAT id nor register number can still be identified (M8)', () => {
  const taxOnly: EInvoiceModel = { ...CASES.taxno!, seller: { ...CASES.taxno!.seller, registration: null } };

  it('is refused with only a Steuernummer, and the message names the ways out', () => {
    const problem = eInvoiceProblems(taxOnly, 'zugferd').find((p) => p.term === 'BT-30');
    expect(problem?.message).toContain('a seller identifier such as a GLN (Settings → Seller, BT-29)');
    expect(problem?.message).toContain('the supplier number this customer assigned you');
  });

  it('takes a seller identifier with an ISO 6523 scheme, as GlobalID before the name', () => {
    const gln = { ...taxOnly, seller: { ...taxOnly.seller, identifier: '0088:4000001000005' } };
    for (const profile of EINVOICE_PROFILES) expect(eInvoiceProblems(gln, profile)).toEqual([]);
    expect(renderCii(gln, 'xrechnung')).toMatch(/<ram:SellerTradeParty>\s*<ram:GlobalID schemeID="0088">4000001000005<\/ram:GlobalID>\s*<ram:Name>/);
  });

  it('takes the supplier number the customer assigned, as the seller ID without a scheme', () => {
    const known = { ...taxOnly, buyer: { ...taxOnly.buyer, supplier_number: 'K-4711' } };
    expect(eInvoiceProblems(known, 'zugferd')).toEqual([]);
    expect(renderCii(known, 'zugferd')).toMatch(/<ram:SellerTradeParty>\s*<ram:ID>K-4711<\/ram:ID>\s*<ram:Name>/);
  });
});

describe('a service period is the time of supply (M7)', () => {
  const period = CASES.period!;

  it('is written as BG-14 in CII, beside its last day as the delivery date', () => {
    for (const profile of EINVOICE_PROFILES) expect(eInvoiceProblems(period, profile)).toEqual([]);
    const xml = renderCii(period, 'xrechnung');
    expect(xml).toMatch(/<ram:BillingSpecifiedPeriod>\s*<ram:StartDateTime>\s*<udt:DateTimeString format="102">20261001<\/udt:DateTimeString>\s*<\/ram:StartDateTime>\s*<ram:EndDateTime>\s*<udt:DateTimeString format="102">20261031<\/udt:DateTimeString>/);
    expect(xml).toMatch(/<ram:ActualDeliverySupplyChainEvent>\s*<ram:OccurrenceDateTime>\s*<udt:DateTimeString format="102">20261031</);
  });

  it('is a Period in ebInterface, which takes a date or a period', () => {
    const xml = renderEbInterface(period);
    expect(xml).toMatch(/<Delivery>\s*<Period>\s*<FromDate>2026-10-01<\/FromDate>\s*<ToDate>2026-10-31<\/ToDate>\s*<\/Period>\s*<\/Delivery>/);
  });

  it('refuses a period that ends before it starts, and an impossible day', () => {
    expect(terms({ ...period, period: { start: '2026-10-31', end: '2026-10-01' } }, 'zugferd')).toEqual(['BT-74']);
    expect(terms({ ...period, period: { start: '2026-09-31', end: '2026-10-31' } }, 'zugferd')).toEqual(['BT-73']);
    expect(ebInterfaceProblems({ ...period, period: { start: '2026-10-31', end: '2026-10-01' } }).map((p) => p.term)).toContain('BT-74');
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

  it('C, M: free text is refused as an e-invoice address, a listed scheme is taken', async () => {
    const field = (res: { body: { details: { field: string }[] } }) => res.body.details.map((d) => d.field);
    const free = await call('post', '/api/customers', { ...customer, einvoice_address: 'Buchhaltung, Frau Meier' });
    expect(free.status).toBe(422);
    expect(field(free)).toEqual(['einvoice_address']);
    expect((await call('post', '/api/customers', { ...customer, einvoice_address: '0088:4012345000009' })).status).toBe(201);
    const settings = await call('put', '/api/settings/seller', { einvoiceAddress: 'Rechnungseingang Buchhaltung' });
    expect(settings.status).toBe(422);
    expect(field(settings)).toEqual(['einvoiceAddress']);
    const unlisted = await call('put', '/api/settings/seller', { identifier: '1234:4000001000005' });
    expect(unlisted.status).toBe(422);
    expect(field(unlisted)).toEqual(['identifier']);
    expect((await call('put', '/api/settings/seller', { identifier: '0088:4000001000005' })).status).toBe(200);
  });

  it('H, M: the shipped IBAN and BIC stop every e-invoice but the cancellation; a phone no one can call is refused in the settings', async () => {
    const fields = (res: { body: { details: { field: string }[] } }) => res.body.details.map((d) => d.field);
    const phone = await call('put', '/api/settings/seller', { phone: 'n/a' });
    expect(phone.status).toBe(422);
    expect(fields(phone)).toEqual(['phone']);

    // Started without SELLER_IBAN and SELLER_BIC, as server/config.ts falls back.
    app = createApp({ db, auth, seller: { ...seller(), iban: PLACEHOLDER_IBAN, bic: PLACEHOLDER_BIC } });
    cookie = (await request(app).post('/api/login').send({ username: 'admin', password: 'pw' })).headers['set-cookie']![0]!.split(';')[0]!;
    const c = await call('post', '/api/customers', { ...customer, einvoice_format: 'xrechnung' });
    const draft = await call('post', '/api/invoices', { customer_id: c.body.id, lines });
    const refused = await call('post', `/api/invoices/${draft.body.id}/finalize`, { issue_date: '2026-10-21' });
    expect(refused.status).toBe(422);
    expect(fields(refused)).toEqual(['seller.iban', 'seller.bic']);

    const id = await issued({});
    for (const format of ['xrechnung.xml', 'zugferd.pdf', 'ebinterface.xml']) {
      const res = await call('get', `/api/invoices/${id}/${format}`);
      expect(res.status, format).toBe(422);
      expect(fields(res), format).toEqual(expect.arrayContaining(['seller.iban', 'seller.bic']));
    }
    expect((await call('post', `/api/invoices/${id}/cancel`, { reason: 'Konto fehlte' })).status).toBe(200);
    expect((await call('get', `/api/invoices/${id}/xrechnung.xml?document=cancellation`)).status).toBe(200);
  });

  it('M7: a draft bills a service period, which the XRechnung and the PDF state', async () => {
    const c = await call('post', '/api/customers', { ...customer, vat_id: 'DE987654321' });
    const half = await call('post', '/api/invoices', { customer_id: c.body.id, period_start: '2026-10-01', lines });
    expect(half.status).toBe(422);
    expect(half.body.details.map((d: { field: string }) => d.field)).toEqual(['period_end']);
    const backwards = await call('post', '/api/invoices', { customer_id: c.body.id, period_start: '2026-10-31', period_end: '2026-10-01', lines });
    expect(backwards.body.details.map((d: { field: string }) => d.field)).toEqual(['period_end']);

    const d = await call('post', '/api/invoices', { customer_id: c.body.id, period_start: '2026-10-01', period_end: '2026-10-31', lines });
    expect(d.status).toBe(201);
    expect(d.body).toMatchObject({ period_start: '2026-10-01', period_end: '2026-10-31', delivery_date: null });
    expect((await call('post', `/api/invoices/${d.body.id}/finalize`, { issue_date: '2026-11-02' })).status).toBe(200);
    const xml = (await call('get', `/api/invoices/${d.body.id}/xrechnung.xml`)).text;
    expect(xml).toContain('<ram:BillingSpecifiedPeriod>');
    // No date was entered: the period's last day stands in, not the issue date (2 November).
    expect(xml).toMatch(/<ram:OccurrenceDateTime>\s*<udt:DateTimeString format="102">20261031</);
    const pdf = await call('get', `/api/invoices/${d.body.id}/pdf`).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (chunk: Buffer) => chunks.push(chunk));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    const text = (pdf.body as Buffer).toString('latin1');
    for (const shown of ['(SERVICE FROM)', '(2026-10-01)', '(SERVICE TO)', '(2026-10-31)']) expect(text).toContain(shown);
    expect(text).not.toContain('(SERVICE DATE)');
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
