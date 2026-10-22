import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { createDraft } from '../server/invoices.js';
import { seed } from '../server/seed.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { TrueTypeFont } from '../server/ttf.js';
import { parseAddressLines } from '../shared/address.js';
import {
  EINVOICE_PROFILES,
  eInvoiceProblems,
  renderCii,
  SPECIFICATION_ID,
  type EInvoiceModel,
} from '../shared/einvoice.js';
import { BASE, CASES } from './einvoice-cases.js';

/**
 * XRechnung and ZUGFeRD.
 *
 * Three kinds of proof, from the outside in:
 *
 * 1. GOLDEN FILES. test/fixtures/einvoice/ holds the XML of every case in
 *    einvoice-cases.ts, each one validated by Mustang (EN 16931 + XRechnung
 *    3.0 schematron) before it was committed. The renderer must reproduce
 *    them byte for byte, so any change to it fails here until the files have
 *    been re-validated (scripts/validate-einvoice.sh) and regenerated.
 * 2. THE SCHEMA, at test time: every case against the Factur-X EN16931 XSD
 *    with xmllint (skipped where xmllint is not installed).
 * 3. THE API: what is frozen at issue, what is refused and why, and what the
 *    PDF/A container carries.
 */

const FIXTURES = join(import.meta.dirname, 'fixtures', 'einvoice');
const XSD = join(import.meta.dirname, 'schema', 'cii-en16931', 'FACTUR-X_EN16931.xsd');

const HAVE_XMLLINT = ((): boolean => {
  try {
    execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe('golden files (validated by Mustang before commit)', () => {
  for (const [name, model] of Object.entries(CASES)) {
    for (const profile of EINVOICE_PROFILES) {
      it(`${name} / ${profile} renders exactly as validated`, () => {
        expect(renderCii(model, profile)).toBe(readFileSync(join(FIXTURES, `${name}-${profile}.xml`), 'utf8'));
      });
    }
  }

  it('every golden case is free of problems in both profiles', () => {
    for (const [name, model] of Object.entries(CASES)) {
      for (const profile of EINVOICE_PROFILES) {
        expect({ name, profile, problems: eInvoiceProblems(model, profile) }).toEqual({ name, profile, problems: [] });
      }
    }
  });
});

describe.skipIf(!HAVE_XMLLINT)('the Factur-X EN16931 schema', () => {
  it('accepts every case in both profiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mod04-cii-'));
    try {
      for (const [name, model] of Object.entries(CASES)) {
        for (const profile of EINVOICE_PROFILES) {
          const file = join(dir, `${name}-${profile}.xml`);
          writeFileSync(file, renderCii(model, profile));
          // Throws (non-zero exit) on any schema violation.
          execFileSync('xmllint', ['--noout', '--schema', XSD, file], { stdio: 'pipe' });
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the rules this module can break, refused before rendering', () => {
  const terms = (model: EInvoiceModel, profile: 'xrechnung' | 'zugferd'): string[] =>
    eInvoiceProblems(model, profile).map((p) => p.term);

  it('XRechnung requires buyer reference, contact and electronic addresses; ZUGFeRD EN 16931 does not', () => {
    const bare: EInvoiceModel = {
      ...CASES.standard!,
      buyer_reference: null,
      seller: { ...CASES.standard!.seller, contact_name: null, phone: null, email: null },
      buyer: { ...CASES.standard!.buyer, email: null, einvoice_address: null },
    };
    expect(terms(bare, 'xrechnung')).toEqual(expect.arrayContaining(['BT-10', 'BT-41', 'BT-42', 'BT-43', 'BT-34', 'BT-49']));
    expect(terms(bare, 'zugferd')).toEqual([]);
  });

  it('a 0 % line needs a VAT category, and "exempt" needs its legal ground', () => {
    expect(terms({ ...BASE, exemption: null }, 'zugferd')).toEqual(['BT-118']);
    expect(terms({ ...BASE, exemption: { category: 'E', reason: null } }, 'zugferd')).toEqual(['BT-120']);
  });

  it('reverse charge and intra-EU supply need both VAT ids', () => {
    const noBuyerId = { ...BASE, buyer: { ...BASE.buyer, vat_id: null } };
    expect(terms({ ...noBuyerId, exemption: { category: 'AE', reason: null } }, 'zugferd')).toEqual(['BT-48']);
    expect(terms({ ...noBuyerId, exemption: { category: 'K', reason: null } }, 'zugferd')).toEqual(['BT-48']);
  });

  it('"not subject to VAT" needs a register number and cannot sit beside taxed lines', () => {
    const o: EInvoiceModel = { ...BASE, exemption: { category: 'O', reason: null } };
    expect(terms(o, 'zugferd')).toEqual(['BT-30']);
    const mixed: EInvoiceModel = {
      ...o,
      seller: { ...o.seller, registration: 'HRB 1' },
      lines: [...o.lines, { position: 2, description: 'x', quantity: 1, unit_price_cents: 100, vat_rate: 19 }],
    };
    expect(terms(mixed, 'zugferd')).toEqual(['BT-118']);
  });

  it('a seller with only a Steuernummer must give its register number', () => {
    const seller = { ...CASES.standard!.seller, vat_id: null, tax_number: '143/123/45678' };
    expect(terms({ ...CASES.standard!, seller }, 'zugferd')).toEqual(['BT-30']);
  });

  it('the shipped placeholder VAT id is refused', () => {
    const seller = { ...CASES.standard!.seller, vat_id: 'ATU00000000' };
    expect(terms({ ...CASES.standard!, seller }, 'zugferd')).toEqual(['BT-31']);
  });

  it('declares the profile it is', () => {
    expect(renderCii(CASES.standard!, 'xrechnung')).toContain(`<ram:ID>${SPECIFICATION_ID.xrechnung}</ram:ID>`);
    expect(renderCii(CASES.standard!, 'zugferd')).toContain(`<ram:ID>${SPECIFICATION_ID.zugferd}</ram:ID>`);
  });

  it('addresses a Leitweg-ID with scheme 0204 and an email with EM', () => {
    const xml = renderCii(CASES.leitweg!, 'xrechnung');
    expect(xml).toContain('<ram:URIID schemeID="0204">991-12345-06</ram:URIID>');
    expect(xml).toContain('<ram:URIID schemeID="EM">rechnung@beispiel.de</ram:URIID>');
  });
});

describe('reading a printed address', () => {
  it('finds street, postcode, city and country in the usual layouts', () => {
    expect(parseAddressLines(['Beispielgasse 8/15', '1010 Wien', 'Austria'])).toEqual({
      street: 'Beispielgasse 8/15',
      postcode: '1010',
      city: 'Wien',
      country: 'AT',
    });
    expect(parseAddressLines(['Hauptstraße 1', 'D-80331 München'])).toEqual({
      street: 'Hauptstraße 1',
      postcode: '80331',
      city: 'München',
      country: 'DE',
    });
    expect(parseAddressLines(['c/o Einkauf', 'Ring 5', '10115 Berlin'], 'DE').street).toBe('Ring 5');
  });

  it('reports what it cannot read instead of guessing', () => {
    expect(parseAddressLines(['Somewhere without a postcode'])).toEqual({
      street: null,
      postcode: null,
      city: null,
      country: null,
    });
  });
});

describe('font subsetting', () => {
  it('keeps the used glyphs, metrics and character map, and drops the rest', () => {
    const file = readFileSync(join(import.meta.dirname, '..', 'assets', 'fonts', 'LiberationSans-Regular.ttf'));
    const font = new TrueTypeFont(file);
    const used = [...'Rechnung Äö€'].map((c) => font.glyphOf(c.codePointAt(0)!));
    const subset = new TrueTypeFont(font.subset(used));
    expect(subset.subset(used).length).toBeLessThan(file.length / 4);
    for (const c of 'Rechnung Äö€') {
      const glyph = font.glyphOf(c.codePointAt(0)!);
      expect(glyph).toBeGreaterThan(0);
      expect(subset.glyphOf(c.codePointAt(0)!)).toBe(glyph);
      expect(subset.width(glyph)).toBe(font.width(glyph));
    }
  });
});

// ── Through the API ────────────────────────────────────────────────────

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's'.repeat(32), ttlHours: 1, secureCookie: false };

/** A German seller with everything XRechnung asks for. */
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
let seller: SellerConfig;

async function boot(): Promise<void> {
  db = openDb(':memory:');
  seller = germanSeller();
  app = createApp({ db, auth, seller });
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'pw' });
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
}

async function customer(values: Record<string, unknown> = {}): Promise<number> {
  const res = await request(app)
    .post('/api/customers')
    .set('Cookie', cookie)
    .send({
      name: 'Kunde AG',
      email: 'ap@kunde.de',
      vat_id: 'DE987654321',
      address: 'Kundenweg 5\n10115 Berlin',
      buyer_reference: '04011000-12345-67',
      ...values,
    });
  expect(res.status).toBe(201);
  return res.body.id as number;
}

async function issued(customerId: number, extra: Record<string, unknown> = {}, lines?: unknown[]): Promise<number> {
  const draft = await request(app)
    .post('/api/invoices')
    .set('Cookie', cookie)
    .send({
      customer_id: customerId,
      lines: lines ?? [
        { description: 'Beratung', quantity: 3, unit_price_cents: 33, vat_rate: 19 },
        { description: 'Fachbuch', quantity: 1, unit_price_cents: 1999, vat_rate: 7 },
      ],
      ...extra,
    });
  expect(draft.status).toBe(201);
  const fin = await request(app).post(`/api/invoices/${draft.body.id}/finalize`).set('Cookie', cookie).send({ issue_date: '2026-10-21' });
  expect(fin.status).toBe(200);
  return draft.body.id as number;
}

/** The XML embedded in a PDF/A we wrote: the only uncompressed stream starting with <?xml. */
function embeddedXml(pdf: Buffer): string {
  const text = pdf.toString('latin1');
  const start = text.indexOf('<?xml version="1.0" encoding="UTF-8"?>');
  const end = text.indexOf('</rsm:CrossIndustryInvoice>', start) + '</rsm:CrossIndustryInvoice>\n'.length;
  return Buffer.from(text.slice(start, end), 'latin1').toString('utf8');
}

describe('e-invoices through the API', () => {
  beforeEach(boot);

  it('accepts the German rates 7 % and 19 % beside the Austrian ones', async () => {
    const id = await issued(await customer());
    const detail = await request(app).get(`/api/invoices/${id}`).set('Cookie', cookie);
    expect(detail.body.vat_breakdown.map((r: { rate: number }) => r.rate)).toEqual([7, 19]);
  });

  it('serves a valid XRechnung that names the invoice and the buyer reference', async () => {
    const id = await issued(await customer());
    const res = await request(app).get(`/api/invoices/${id}/xrechnung.xml`).set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/xml');
    expect(res.headers['content-disposition']).toContain('INV-2026-0001_xrechnung.xml');
    expect(res.text).toContain('<ram:ID>INV-2026-0001</ram:ID>');
    expect(res.text).toContain('<ram:BuyerReference>04011000-12345-67</ram:BuyerReference>');
    expect(res.text).toContain('<ram:GrandTotalAmount>22.57</ram:GrandTotalAmount>');
    // The city and postcode came from the printed address lines.
    expect(res.text).toContain('<ram:PostcodeCode>10115</ram:PostcodeCode>');
  });

  it('freezes the parties at issue: later master-data edits do not rewrite the invoice', async () => {
    const customerId = await customer();
    const id = await issued(customerId);
    const before = (await request(app).get(`/api/invoices/${id}/xrechnung.xml`).set('Cookie', cookie)).text;

    await request(app)
      .put(`/api/customers/${customerId}`)
      .set('Cookie', cookie)
      .send({ name: 'Renamed AG', email: 'new@kunde.de', address: 'Neu 1\n20095 Hamburg', buyer_reference: 'X' });
    seller.name = 'Moved GmbH';
    seller.addressLines = ['Elsewhere 9', '50667 Köln'];

    const after = (await request(app).get(`/api/invoices/${id}/xrechnung.xml`).set('Cookie', cookie)).text;
    expect(after).toBe(before);
    expect((await request(app).get(`/api/invoices/${id}`).set('Cookie', cookie)).body.parties_frozen).toBe(true);
  });

  it('refuses a draft with 409 — it has no number yet', async () => {
    const draft = await request(app)
      .post('/api/invoices')
      .set('Cookie', cookie)
      .send({ customer_id: await customer(), lines: [{ description: 'x', quantity: 1, unit_price_cents: 100, vat_rate: 19 }] });
    const res = await request(app).get(`/api/invoices/${draft.body.id}/xrechnung.xml`).set('Cookie', cookie);
    expect(res.status).toBe(409);
  });

  it('refuses with 422 naming every missing business term, and the readiness endpoint says so first', async () => {
    const id = await issued(await customer({ buyer_reference: null, email: null }));
    const res = await request(app).get(`/api/invoices/${id}/xrechnung.xml`).set('Cookie', cookie);
    expect(res.status).toBe(422);
    const messages = res.body.details.map((d: { message: string }) => d.message.split(':')[0]);
    expect(messages).toEqual(expect.arrayContaining(['BT-10', 'BT-49']));

    const ready = await request(app).get(`/api/invoices/${id}/einvoice`).set('Cookie', cookie);
    expect(ready.body.problems.xrechnung.map((p: { term: string }) => p.term)).toEqual(['BT-49', 'BT-10']);
    // ZUGFeRD EN 16931 asks for neither, so the same invoice is fine there.
    expect(ready.body.problems.zugferd).toEqual([]);
    expect((await request(app).get(`/api/invoices/${id}/zugferd.pdf`).set('Cookie', cookie)).status).toBe(200);
  });

  it('serves a ZUGFeRD PDF/A-3 that carries exactly the EN 16931 XML, reproducibly', async () => {
    const id = await issued(await customer());
    const first = await request(app).get(`/api/invoices/${id}/zugferd.pdf`).set('Cookie', cookie).buffer(true);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('application/pdf');
    const pdf = first.body as Buffer;
    const text = pdf.toString('latin1');
    expect(text.startsWith('%PDF-1.7')).toBe(true);
    expect(text).toContain('<pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>');
    expect(text).toContain('<fx:DocumentFileName>factur-x.xml</fx:DocumentFileName>');
    expect(text).toContain('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>');
    expect(text).toContain('/AFRelationship /Alternative');
    expect(text).toContain('/Subtype /text#2Fxml');
    expect(text).toContain('/OutputIntents');
    expect(text).toMatch(/\/ID \[<[0-9A-F]{32}> <[0-9A-F]{32}>\]/);
    // No font is left to the viewer: every one is an embedded TrueType subset.
    expect(text).not.toContain('/Subtype /Type1');
    expect(text.match(/\/FontFile2 /g)).toHaveLength(4);

    const xml = embeddedXml(pdf);
    expect(xml).toContain(`<ram:ID>${SPECIFICATION_ID.zugferd}</ram:ID>`);
    expect(xml).toContain('<ram:GrandTotalAmount>22.57</ram:GrandTotalAmount>');

    const second = await request(app).get(`/api/invoices/${id}/zugferd.pdf`).set('Cookie', cookie).buffer(true);
    expect(Buffer.compare(second.body as Buffer, pdf)).toBe(0);
  });

  it('embeds font programs that decompress to valid TrueType', async () => {
    const id = await issued(await customer());
    const pdf = ((await request(app).get(`/api/invoices/${id}/zugferd.pdf`).set('Cookie', cookie).buffer(true)).body as Buffer).toString('latin1');
    const match = /\/Length1 (\d+) \/Filter \/FlateDecode \/Length (\d+) >>\nstream\n/.exec(pdf)!;
    const start = match.index + match[0].length;
    const font = inflateSync(Buffer.from(pdf.slice(start, start + Number(match[2])), 'latin1'));
    expect(font.length).toBe(Number(match[1]));
    expect(new TrueTypeFont(font).glyphOf('R'.codePointAt(0)!)).toBeGreaterThan(0);
  });

  it('prints the exemption reason, and refuses a 0 % invoice without a category', async () => {
    const at = await customer({ vat_id: 'ATU12345678', address: 'Ring 5\n1010 Wien', country_code: 'AT' });
    const zero = [{ description: 'Leistung', quantity: 1, unit_price_cents: 50000, vat_rate: 0 }];
    const missing = await issued(at, {}, zero);
    expect((await request(app).get(`/api/invoices/${missing}/zugferd.pdf`).set('Cookie', cookie)).status).toBe(422);

    const rc = await issued(at, { tax_exemption_category: 'AE' }, zero);
    const xml = (await request(app).get(`/api/invoices/${rc}/xrechnung.xml`).set('Cookie', cookie)).text;
    expect(xml).toContain('<ram:CategoryCode>AE</ram:CategoryCode>');
    expect(xml).toContain('<ram:ExemptionReasonCode>VATEX-EU-AE</ram:ExemptionReasonCode>');
    const pdf = (await request(app).get(`/api/invoices/${rc}/pdf`).set('Cookie', cookie).buffer(true)).body as Buffer;
    expect(pdf.toString('latin1')).toContain('Steuerschuldnerschaft des Leistungsempf');
  });

  it('issues the cancellation as a credit note (381) referring to the invoice', async () => {
    const id = await issued(await customer());
    expect(
      (await request(app).get(`/api/invoices/${id}/xrechnung.xml?document=cancellation`).set('Cookie', cookie)).status,
    ).toBe(409);
    await request(app).post(`/api/invoices/${id}/cancel`).set('Cookie', cookie).send({ reason: 'Doppelt' });

    const credit = await request(app).get(`/api/invoices/${id}/xrechnung.xml?document=cancellation`).set('Cookie', cookie);
    expect(credit.status).toBe(200);
    expect(credit.text).toContain('<ram:TypeCode>381</ram:TypeCode>');
    expect(credit.text).toContain('<ram:ID>INV-2026-0001-ST</ram:ID>');
    expect(credit.text).toContain('<ram:IssuerAssignedID>INV-2026-0001</ram:IssuerAssignedID>');

    // The original stays the original — a cancelled invoice's e-invoice is the one that was sent.
    const original = await request(app).get(`/api/invoices/${id}/xrechnung.xml`).set('Cookie', cookie);
    expect(original.text).toContain('<ram:TypeCode>380</ram:TypeCode>');
    const pdf = await request(app).get(`/api/invoices/${id}/zugferd.pdf?document=cancellation`).set('Cookie', cookie).buffer(true);
    expect(embeddedXml(pdf.body as Buffer)).toContain('<ram:TypeCode>381</ram:TypeCode>');
  });

  it('validates the new customer and draft fields', async () => {
    const bad = await request(app)
      .post('/api/customers')
      .set('Cookie', cookie)
      .send({ name: 'X', country_code: 'Germany', debtor_account: 'abc' });
    expect(bad.status).toBe(422);
    expect(bad.body.details.map((d: { field: string }) => d.field)).toEqual(['country_code', 'debtor_account']);

    const draft = await request(app)
      .post('/api/invoices')
      .set('Cookie', cookie)
      .send({
        customer_id: await customer(),
        tax_exemption_category: 'XX',
        delivery_date: '2026-13-01',
        lines: [{ description: 'x', quantity: 1, unit_price_cents: 1, vat_rate: 19 }],
      });
    expect(draft.status).toBe(422);
    expect(draft.body.details.map((d: { field: string }) => d.field)).toEqual(['delivery_date', 'tax_exemption_category']);
  });

  it('reports the seller side on its own, for the settings banner', async () => {
    seller.phone = undefined;
    const res = await request(app).get('/api/einvoice-config').set('Cookie', cookie);
    expect(res.body.seller).toMatchObject({ street: 'Hauptstraße 1', postcode: '80331', city: 'München', country: 'DE' });
    expect(res.body.problems.xrechnung.map((p: { term: string }) => p.term)).toEqual(['BT-42']);
    expect(res.body.problems.zugferd).toEqual([]);
  });
});

describe('upgrading a database created before e-invoicing', () => {
  it('widens the VAT CHECK to 7 / 13 / 19 and keeps every row', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mod04-upgrade-'));
    const file = join(dir, 'old.db');
    try {
      // The schema as the previous release created it.
      const old = new Database(file);
      old.exec(`
        CREATE TABLE customers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT, vat_id TEXT, address TEXT, created_at TEXT NOT NULL);
        CREATE TABLE invoices (id INTEGER PRIMARY KEY AUTOINCREMENT, number TEXT UNIQUE, customer_id INTEGER NOT NULL REFERENCES customers(id),
          status TEXT NOT NULL DEFAULT 'draft', issue_date TEXT, due_date TEXT, payment_terms_days INTEGER NOT NULL DEFAULT 14,
          note TEXT, cancelled_at TEXT, cancellation_reason TEXT, created_at TEXT NOT NULL);
        CREATE TABLE invoice_lines (id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
          position INTEGER NOT NULL, description TEXT NOT NULL, quantity REAL NOT NULL CHECK (quantity > 0),
          unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0), vat_rate INTEGER NOT NULL CHECK (vat_rate IN (0, 10, 20)));
        INSERT INTO customers (name, created_at) VALUES ('Alt GmbH', 'x');
        INSERT INTO invoices (customer_id, created_at) VALUES (1, 'x');
        INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit_price_cents, vat_rate) VALUES (1, 1, 'alt', 2, 500, 20);
      `);
      expect(() =>
        old.prepare('INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit_price_cents, vat_rate) VALUES (1, 2, ?, 1, 1, 19)').run('neu'),
      ).toThrow(/CHECK/);
      old.close();

      const upgraded = openDb(file);
      expect(upgraded.prepare('SELECT id, description, vat_rate FROM invoice_lines').all()).toEqual([
        { id: 1, description: 'alt', vat_rate: 20 },
      ]);
      upgraded.prepare('INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit_price_cents, vat_rate) VALUES (1, 2, ?, 1, 1, 19)').run('neu');
      expect(() =>
        upgraded.prepare('INSERT INTO invoice_lines (invoice_id, position, description, quantity, unit_price_cents, vat_rate) VALUES (1, 3, ?, 1, 1, 16)').run('x'),
      ).toThrow(/CHECK/);
      // The report views were rebuilt over the new table.
      expect(upgraded.prepare('SELECT COUNT(*) AS n FROM report_invoice_lines').get()).toEqual({ n: 0 });
      upgraded.close();
      // And opening again is a no-op.
      openDb(file).close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('review findings: what stays frozen, and which rates an installation issues', () => {
  beforeEach(boot);

  it('a Leitweg-ID added to the customer later does not enter an invoice issued without one', async () => {
    const customerId = await customer({ buyer_reference: null });
    const id = await issued(customerId);
    const before = await request(app).get(`/api/invoices/${id}/zugferd.pdf`).set('Cookie', cookie).buffer(true);
    expect((await request(app).get(`/api/invoices/${id}/xrechnung.xml`).set('Cookie', cookie)).status).toBe(422);

    await request(app)
      .put(`/api/customers/${customerId}`)
      .set('Cookie', cookie)
      .send({ name: 'Kunde AG', email: 'ap@kunde.de', address: 'Kundenweg 5\n10115 Berlin', buyer_reference: '991-12345-06' });

    // Still refused, and the ZUGFeRD file is byte for byte what it was.
    expect((await request(app).get(`/api/invoices/${id}/xrechnung.xml`).set('Cookie', cookie)).status).toBe(422);
    const after = await request(app).get(`/api/invoices/${id}/zugferd.pdf`).set('Cookie', cookie).buffer(true);
    expect(Buffer.compare(before.body as Buffer, after.body as Buffer)).toBe(0);
    expect(embeddedXml(after.body as Buffer)).not.toContain('BuyerReference');
  });

  it("refuses rates the seller's country does not charge — on the draft and again at issue", async () => {
    seller.addressLines = ['Ring 1', '1010 Wien', 'Austria'];
    seller.vatId = 'ATU12345678';
    const id = await customer();
    const refused = await request(app)
      .post('/api/invoices')
      .set('Cookie', cookie)
      .send({ customer_id: id, lines: [{ description: 'x', quantity: 1, unit_price_cents: 100, vat_rate: 19 }] });
    expect(refused.status).toBe(422);
    expect(refused.body.details).toEqual([
      { field: 'lines[0].vat_rate', message: '19 % is not a VAT rate in AT — use one of: 0, 10, 13, 20' },
    ]);

    // A draft that reached the database by another path (an imported offer) is caught at issue.
    const draft = createDraft(db, {
      customerId: id,
      paymentTermsDays: 14,
      note: null,
      lines: [{ description: 'x', quantity: 1, unitPriceCents: 100, vatRate: 7 }],
    });
    const finalize = await request(app).post(`/api/invoices/${draft}/finalize`).set('Cookie', cookie).send({});
    expect(finalize.status).toBe(422);
    expect((await request(app).get(`/api/invoices/${draft}`).set('Cookie', cookie)).body.number).toBeNull();
  });

  it('seeded invoices are frozen like any other, when the seed knows the seller', async () => {
    const seeded = openDb(':memory:');
    seed(seeded, germanSeller());
    const rows = seeded.prepare("SELECT seller_snapshot IS NOT NULL AS frozen FROM invoices WHERE status <> 'draft'").all() as { frozen: number }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.frozen === 1)).toBe(true);
  });
});
