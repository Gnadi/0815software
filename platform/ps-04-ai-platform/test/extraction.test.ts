import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import type { FetchLike } from '../server/providers/index.js';
import { ibanValid, parseAmount, readInvoiceText } from '../server/invoice-text.js';
import { decimalCents } from '../server/einvoice-read.js';
import { parseXml } from '../server/xml.js';
import type { InvoiceExtraction } from '../shared/types.js';

/**
 * Reading a supplier invoice (server/extraction.ts).
 *
 * The e-invoice readers are pinned against published sources, not our own
 * expectations: the EN 16931 example pair (test/fixtures/en16931 — the SAME
 * invoice in UBL 2.1 and in CII, from the European Commission's
 * eInvoicing-EN16931 repository, EUPL 1.2) must read to identical fields,
 * and MOD-04's own output — which its suite validates against the official
 * XSDs and schematron — must read back to what MOD-04 wrote.
 */

const auth: AuthConfig = { username: 'admin', password: 'p', secret: 's', ttlHours: 1, secureCookie: false, serviceToken: 'svc' };
const svc = { 'X-Service-Token': 'svc' };
const FIXTURES = join(import.meta.dirname, 'fixtures');
const file = (name: string) => readFileSync(join(FIXTURES, name));

let db: Database.Database;
let app: Express;

beforeEach(() => {
  db = openDb(':memory:');
  app = createApp({ db, auth });
});

const extract = (body: Record<string, unknown>, a = app) => request(a).post('/api/extract/invoice').set(svc).send(body);
const extractFile = async (name: string, extra: Record<string, unknown> = {}) =>
  (await extract({ content_base64: file(name).toString('base64'), filename: name, ...extra }).expect(200)).body as InvoiceExtraction;

describe('structured e-invoices are read exactly', () => {
  it('the EN 16931 example reads the same from UBL and from CII', async () => {
    const ubl = await extractFile('en16931/ubl-tc434-example1.xml');
    const cii = await extractFile('en16931/CII_example1.xml');
    expect(ubl).toMatchObject({ source: 'e-invoice', syntax: 'ubl', embedded: false, provider: 'mock' });
    expect(cii.syntax).toBe('cii');
    expect(ubl.fields).toEqual(cii.fields);
    expect(ubl.fields).toMatchObject({
      supplier_name: 'De Koksmaat',
      supplier_vat_id: 'NL8200.98.395.B.01',
      iban: 'NL57RABO0107307510',
      invoice_number: '12115118',
      issue_date: '2015-01-09',
      due_date: '2015-01-09',
      currency: 'EUR',
      net_cents: 22960,
      tax_cents: 2073,
      gross_cents: 25033,
      payable_cents: 25033,
    });
    expect(ubl.lines).toHaveLength(cii.lines.length);
    expect(ubl.lines[0]).toMatchObject({ description: 'PATAT FRITES 10MM 10KG', item_id: '166022', quantity: 2, net_cents: 1990 });
    // The lines read the same from both syntaxes, and add up to the net (BT-106 = BT-109 here).
    // (The published pair itself differs in unit codes — EA / H87 — and one description's
    // spelling, so those are not compared.)
    const money = (l: InvoiceExtraction['lines'][number]) => [l.item_id, l.quantity, l.unit_price_cents, l.net_cents, l.vat_rate];
    expect(ubl.lines.map(money)).toEqual(cii.lines.map(money));
    expect(ubl.lines.reduce((sum, l) => sum + l.net_cents!, 0)).toBe(ubl.fields.net_cents);
    expect(ubl.confidence.gross_cents).toBe('exact');
    expect(ubl.warnings).toEqual([]);
  });

  it('reads back what MOD-04 writes: XRechnung, ebInterface, and the XML inside a ZUGFeRD PDF', async () => {
    const xr = await extractFile('mod-04/standard-xrechnung.xml');
    expect(xr.fields).toMatchObject({ invoice_number: 'INV-2026-0042', supplier_vat_id: 'DE123456789', iban: 'DE02120300000000202051', bic: 'BYLADEM1001', net_cents: 125097, tax_cents: 23169, gross_cents: 148266, due_date: '2026-11-04' });
    // BT-10 (buyer reference) is not BT-13 (the purchase order): not taken as one.
    expect(xr.fields.po_number).toBeNull();

    const eb = await extractFile('mod-04/at-standard.xml');
    expect(eb).toMatchObject({ syntax: 'ebinterface' });
    expect(eb.fields).toMatchObject({ supplier_name: 'Muster & Söhne GmbH', supplier_vat_id: 'ATU12345678', po_number: '4500012345', net_cents: 126347, tax_cents: 24683, gross_cents: 151030 });

    const z = await extractFile('mod-04/zugferd.pdf');
    expect(z).toMatchObject({ source: 'e-invoice', syntax: 'cii', embedded: true });
    expect(z.fields).toMatchObject({ invoice_number: 'INV-2026-0001', net_cents: 53998, tax_cents: 9780, gross_cents: 63778 });
  });

  it('a cancellation is a credit note and says so', async () => {
    const st = await extractFile('mod-04/storno-xrechnung.xml');
    expect(st.fields.document_type).toBe('credit_note');
    expect(st.warnings[0]).toContain('credit note');
  });

  it('an XML that is not an e-invoice, or not XML at all, is refused — and entities expand into nothing', async () => {
    expect((await extract({ text: '' }).expect(422)).body.details[0].field).toBe('content_base64');
    const other = Buffer.from('<?xml version="1.0"?><order><id>1</id></order>').toString('base64');
    expect((await extract({ content_base64: other }).expect(422)).body.error).toContain('not an e-invoice');
    const broken = Buffer.from('<Invoice><ID>1</Invoice>').toString('base64');
    expect((await extract({ content_base64: broken }).expect(422)).body.error).toContain('not well-formed');
    const bomb = parseXml('<!DOCTYPE x [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;">]><x>&b;</x>');
    expect(bomb.text).toBe('&b;');
  });
});

describe('a generated PDF or pasted text is read from its labels', () => {
  it('reads MOD-04\'s printed invoice — label and amount on one baseline, drawn separately', async () => {
    const r = await extractFile('mod-04/invoice.pdf', { own: { names: ['Kunde AG'], vat_ids: ['DE987654321'] } });
    expect(r).toMatchObject({ source: 'text', syntax: null, provider: 'mock' });
    expect(r.fields).toMatchObject({
      supplier_name: 'Beispiel GmbH',
      supplier_vat_id: 'DE123456789',
      iban: 'DE02120300000000202051',
      bic: 'BYLADEM1001',
      invoice_number: 'INV-2026-0001',
      issue_date: '2026-10-21',
      due_date: '2026-11-04',
      net_cents: 53998,
      tax_cents: 9780,
      gross_cents: 63778,
      po_number: 'PO-2026-0007',
      currency: 'EUR',
    });
    expect(r.confidence).toMatchObject({ gross_cents: 'found', supplier_name: 'guess' });
  });

  const GERMAN = `Elektro Huber GmbH · Industriestraße 4 · 4020 Linz
UID: ATU11223344
An: Kunde AG, Kundenweg 5, 10115 Berlin, USt-IdNr. DE987654321
Rechnung
Rechnungsnummer: 2026/1187
Rechnungsdatum: 21.10.2026
Lieferdatum: 15.10.2026
Ihre Bestellung: PO-2026-0007
Pos  Bezeichnung        Menge   Einzelpreis   Gesamt
1    Kabel NYM 3x1,5    100     1,20          120,00
2    Montage            8       75,00         600,00
Summe netto                                   720,00 €
USt 20 %                                      144,00 €
Gesamtbetrag                                  864,00 €
Zahlbar innerhalb von 14 Tagen ohne Abzug.
Bankverbindung: Raiffeisen OÖ · IBAN AT61 1904 3002 3457 3201 · BIC RZOOAT2L`;

  it('reads a typical Austrian invoice; never takes the buyer for the supplier', () => {
    const { fields, confidence, warnings } = readInvoiceText(GERMAN, { names: ['Kunde AG'], vat_ids: ['DE987654321'] });
    expect(fields).toMatchObject({
      supplier_name: 'Elektro Huber GmbH',
      supplier_vat_id: 'ATU11223344',
      iban: 'AT611904300234573201',
      bic: 'RZOOAT2L',
      invoice_number: '2026/1187',
      issue_date: '2026-10-21',
      po_number: 'PO-2026-0007',
      net_cents: 72000,
      tax_cents: 14400,
      gross_cents: 86400,
      currency: 'EUR',
    });
    // "within 14 days": a term, so the due date is derived — and says so.
    expect(fields.due_date).toBe('2026-11-04');
    expect(confidence.due_date).toBe('derived');
    expect(warnings).toEqual([]);
  });

  it('stacked labels, per-rate tax lines, a missing total derived — and nothing invented', () => {
    const text = `INVOICE
Invoice No.
A-77
Invoice date
2026-10-01
Due date
2026-10-31
Subtotal 1,000.00
VAT 10% 50.00
VAT 20% 160.00`;
    const { fields, confidence } = readInvoiceText(text);
    expect(fields).toMatchObject({ invoice_number: 'A-77', issue_date: '2026-10-01', due_date: '2026-10-31', net_cents: 100000, tax_cents: 21000, gross_cents: 121000 });
    expect(confidence.gross_cents).toBe('derived');
    expect(fields.iban).toBeNull();
    expect(fields.supplier_name).toBeNull();
  });

  it('an IBAN whose check digits fail is not taken, and the person is told', () => {
    const { fields, warnings } = readInvoiceText('Rechnung Nr. 5\nIBAN AT61 1904 3002 3457 3202\nGesamtbetrag 10,00');
    expect(fields.iban).toBeNull();
    expect(warnings[0]).toContain('check digits');
  });

  it('pasted text goes the same way, and totals that do not add up are flagged', async () => {
    const r = (await extract({ text: 'Rechnungsnummer R-1\nNettobetrag 100,00\nMwSt 20,00\nGesamtbetrag 125,00\nFällig am 30.11.2026' }).expect(200)).body as InvoiceExtraction;
    expect(r.source).toBe('text');
    expect(r.warnings).toContain('Net 100.00 + tax 20.00 is not the gross 125.00');
  });
});

describe('scans and models', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

  it('without a vision model a scan is refused — the default never invents an invoice', async () => {
    const res = await extract({ content_base64: PNG }).expect(422);
    expect(res.body.error).toContain('vision model');
    // Asking for a vendor that is not configured is said out loud, not swapped for patterns.
    expect((await extract({ content_base64: PNG, provider: 'anthropic' }).expect(422)).body.error).toBe('The provider anthropic is not configured on this AI platform');
  });

  it('a configured vision model reads it; its answer is held to the same shapes and checks', async () => {
    const sent: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      sent.push({ url, body: JSON.parse(init.body) });
      const answer = {
        document_type: 'invoice',
        supplier_name: 'Scan & Co KG',
        iban: 'AT61 1904 3002 3457 3201',
        invoice_number: 'S-9',
        issue_date: '2026-10-02',
        due_date: '2026-10-16',
        net: '100.00',
        tax: '20.00',
        gross: '120.00',
        currency: 'EUR',
      };
      return { ok: true, status: 200, json: async () => ({ content: [{ type: 'text', text: `Here it is: ${JSON.stringify(answer)}` }] }) };
    };
    const keyed = createApp({ db, auth, anthropicApiKey: 'k', anthropicModel: 'vision-model', fetchImpl });
    const r = (await extract({ content_base64: PNG, provider: 'anthropic', own: { names: ['Kunde AG'] } }, keyed).expect(200)).body as InvoiceExtraction;
    expect(r).toMatchObject({ source: 'model', provider: 'anthropic', model: 'vision-model' });
    expect(r.fields).toMatchObject({ supplier_name: 'Scan & Co KG', iban: 'AT611904300234573201', gross_cents: 12000, net_cents: 10000 });
    expect(r.confidence.gross_cents).toBe('model');
    expect(r.lines).toEqual([]);
    const content = (sent[0]!.body.messages as { content: { type: string }[] }[])[0]!.content;
    expect(content[0]!.type).toBe('image');
    expect(sent[0]!.body.system).toContain('RECIPIENT (not the supplier) is: Kunde AG');

    // An e-invoice is never sent to the model, even when one is asked for.
    const xml = await extract({ content_base64: file('en16931/CII_example1.xml').toString('base64'), provider: 'anthropic' }, keyed).expect(200);
    expect(xml.body.source).toBe('e-invoice');
    expect(sent).toHaveLength(1);
  });

  it('the log keeps that a document was read and how — never what it said', async () => {
    const r = await extractFile('mod-04/invoice.pdf');
    const rows = db.prepare('SELECT * FROM extractions').all() as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ document_sha256: r.document_sha256, source: 'text', provider: 'mock', warning_count: 0 });
    expect(JSON.stringify(rows[0])).not.toMatch(/Beispiel|DE02|637/);
  });

  it('takes a scan-sized body on this route only, and needs a caller', async () => {
    await request(app).post('/api/extract/invoice').send({ text: 'x' }).expect(401);
    const big = Buffer.alloc(3 * 1024 * 1024, 0x41).toString('base64');
    expect((await extract({ content_base64: big }).expect(200)).body.source).toBe('text');
    await request(app).post('/api/embeddings').set(svc).send({ input: 'x'.repeat(600 * 1024) }).expect(413);
  });
});

describe('lines', () => {
  it('a model\'s lines are held to the same shapes; lines that do not add up to the net are flagged', async () => {
    const fetchImpl: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              invoice_number: 'S-1',
              net: '150.00',
              gross: '180.00',
              tax: '30.00',
              due_date: '2026-11-30',
              lines: [
                { description: 'Widget', item_id: 'W-1', quantity: 10, unit: 'C62', unit_price: '10.00', net: '100.00', vat_rate: 20 },
                { description: 'Freight', net: 40 },
                { description: '   ', net: '999.00' },
                'not a line',
              ],
            }),
          },
        ],
      }),
    });
    const keyed = createApp({ db, auth, anthropicApiKey: 'k', fetchImpl });
    const r = (await extract({ content_base64: Buffer.from('89504e470d0a1a0a', 'hex').toString('base64'), provider: 'anthropic' }, keyed).expect(200)).body as InvoiceExtraction;
    expect(r.lines).toEqual([
      { description: 'Widget', item_id: 'W-1', quantity: 10, unit_code: 'C62', unit_price_cents: 1000, net_cents: 10000, vat_rate: 20 },
      { description: 'Freight', item_id: null, quantity: null, unit_code: null, unit_price_cents: null, net_cents: 4000, vat_rate: null },
    ]);
    expect(r.warnings).toContain('The lines add up to 140.00 net, the invoice says 150.00 — an allowance or charge on the whole invoice?');
  });

  it('ebInterface lines carry the supplier\'s article number when it has one', async () => {
    const eb = await extractFile('mod-04/at-standard.xml');
    expect(eb.lines.map((l) => [l.description, l.net_cents, l.vat_rate])).toEqual([
      ['Beratung', 99, 20],
      ['Fachbuch', 4998, 10],
      ['Pflanzen', 1250, 13],
      ['Lizenz', 120000, 20],
    ]);
    expect(eb.lines[0]!.item_id).toBeNull();
  });
});

describe('the small parts', () => {
  it('amounts, cents and IBANs', () => {
    expect(parseAmount('1.234,56')).toBe(123456);
    expect(parseAmount('1,234.56 €')).toBe(123456);
    expect(parseAmount('1 234,56')).toBe(123456);
    expect(parseAmount('12.2026')).toBeNull();
    expect(parseAmount('1,234,56')).toBeNull();
    expect(decimalCents('229.6')).toBe(22960);
    expect(decimalCents('0.335')).toBe(34);
    expect(decimalCents('-5.00')).toBe(-500);
    expect(ibanValid('DE02 1203 0000 0000 2020 51')).toBe(true);
    expect(ibanValid('DE02 1203 0000 0000 2020 52')).toBe(false);
  });
});
