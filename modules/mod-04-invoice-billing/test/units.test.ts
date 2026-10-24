import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { issueCreditNote } from '../server/credit-notes.js';
import { openDb } from '../server/db.js';
import { unicodeOf } from '../server/fonts.js';
import { createDraft, finalizeInvoice, invoiceDetail } from '../server/invoices.js';
import { textWidth } from '../server/pdf.js';
import { renderEbInterface } from '../shared/ebinterface.js';
import { eInvoiceProblems, renderCii, type EInvoiceModel } from '../shared/einvoice.js';
import { UNIT_CODES, withUnit } from '../shared/units.js';
import { CASES } from './einvoice-cases.js';

/**
 * Every line in its own unit of measure — review finding N7 in
 * docs/E-RECHNUNG-REVIEW.md: all lines went out as C62, so three consulting
 * days were three pieces. Valid, and wrong. The codes themselves are held to
 * the validators by the golden case `units`, which carries each one.
 */

const standard = CASES.standard!;
const withUnits = (...units: (string | undefined)[]): EInvoiceModel => ({
  ...standard,
  lines: standard.lines.map((line, i) => ({ ...line, unit: units[i] })),
});

describe('a line is billed in its unit', () => {
  it('in CII and ebInterface, and as a piece (C62) when it names none', () => {
    const model = withUnits('DAY', undefined, 'LS');
    const cii = renderCii(model, 'xrechnung');
    expect(cii).toContain('<ram:BilledQuantity unitCode="DAY">3</ram:BilledQuantity>');
    expect(cii).toContain('<ram:BilledQuantity unitCode="C62">2.5</ram:BilledQuantity>');
    expect(cii).toContain('<ram:BilledQuantity unitCode="LS">1</ram:BilledQuantity>');
    expect(renderEbInterface(model)).toContain('<Quantity Unit="DAY">3</Quantity>');
  });

  it('refuses a unit outside the list, by business term', () => {
    const problems = eInvoiceProblems(withUnits('HUR', 'STK'), 'xrechnung');
    expect(problems.map((p) => [p.term, p.field])).toEqual([['BT-130', 'lines[1].unit']]);
    expect(problems[0]!.message).toContain('UN/ECE Rec 20, BR-CL-23');
  });

  it('shows the unit after the quantity, and none for a piece', () => {
    expect(withUnit('7,5', 'HUR')).toBe('7,5 h');
    expect(withUnit('12', 'MTK')).toBe('12 m²');
    expect(withUnit('3', 'C62')).toBe('3');
    expect(withUnit('3', 'XYZ')).toBe('3');
    expect(UNIT_CODES[0]).toBe('C62'); // the editor's default comes first
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
  cookie = (await request(app).post('/api/login').send({ username: 'admin', password: 'pw' })).headers['set-cookie']![0]!.split(';')[0]!;
});

const call = (method: 'get' | 'post', url: string, body?: object) => {
  const r = request(app)[method](url).set('Cookie', cookie);
  return body ? r.send(body) : r;
};

async function customer(): Promise<number> {
  const c = await call('post', '/api/customers', { name: 'Kunde AG', email: 'ap@kunde.de', address: 'Kundenweg 5\n10115 Berlin', country_code: 'DE', buyer_reference: 'PO-1' });
  expect(c.status).toBe(201);
  return c.body.id as number;
}

/** The texts a PDF shows, with the font, size and position each is set at. */
function placed(pdf: string): { font: string; size: number; x: number; y: number; text: string }[] {
  return [...pdf.matchAll(/\/(F\d) ([\d.]+) Tf ([\d.]+) ([\d.]+) Td \(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => ({
    font: m[1]!,
    size: Number(m[2]),
    x: Number(m[3]),
    y: Number(m[4]),
    text: [...m[5]!.matchAll(/\\([0-7]{3})|\\(.)|(.)/gs)]
      .map(([, octal, escaped, plain]) => String.fromCodePoint(unicodeOf(octal ? parseInt(octal, 8) : (escaped ?? plain)!.charCodeAt(0)) ?? 0x3f))
      .join(''),
  }));
}

async function pdfOf(id: number): Promise<string> {
  const res = await call('get', `/api/invoices/${id}/pdf`)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (chunk: Buffer) => chunks.push(chunk));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  return (res.body as Buffer).toString('latin1');
}

describe('the API', () => {
  it('takes a unit per line, pieces when none is sent, and refuses one it does not know', async () => {
    const customerId = await customer();
    const draft = await call('post', '/api/invoices', {
      customer_id: customerId,
      lines: [
        { description: 'Beratung', quantity: 7.5, unit: 'HUR', unit_price_cents: 9500, vat_rate: 19 },
        { description: 'Kabel', quantity: 3, unit_price_cents: 250, vat_rate: 19 },
      ],
    });
    expect(draft.status).toBe(201);
    expect(draft.body.lines.map((l: { unit: string }) => l.unit)).toEqual(['HUR', 'C62']);

    const bad = await call('post', '/api/invoices', { customer_id: customerId, lines: [{ description: 'x', quantity: 1, unit: 'Stk', unit_price_cents: 1, vat_rate: 19 }] });
    expect(bad.status).toBe(422);
    expect(bad.body.details.map((d: { field: string }) => d.field)).toEqual(['lines[0].unit']);
    expect(bad.body.details[0].message).toContain('HUR (hour)');

    expect((await call('post', `/api/invoices/${draft.body.id}/finalize`, { issue_date: '2026-10-21' })).status).toBe(200);
    const xml = (await call('get', `/api/invoices/${draft.body.id}/xrechnung.xml`)).text;
    expect(xml).toContain('<ram:BilledQuantity unitCode="HUR">7.5</ram:BilledQuantity>');
    expect(placed(await pdfOf(draft.body.id)).map((t) => t.text)).toEqual(expect.arrayContaining(['7,5 h', '3']));
  });

  it('credits in the unit the credit note names, and keeps a template’s unit for its drafts', async () => {
    const customerId = await customer();
    const draft = await call('post', '/api/invoices', { customer_id: customerId, lines: [{ description: 'Schulung', quantity: 2, unit: 'DAY', unit_price_cents: 80000, vat_rate: 19 }] });
    await call('post', `/api/invoices/${draft.body.id}/finalize`, { issue_date: '2026-10-21' });
    const note = await call('post', `/api/invoices/${draft.body.id}/credit-notes`, {
      reason: 'Ein Tag ausgefallen',
      lines: [{ description: 'Schulung', quantity: 1, unit: 'DAY', unit_price_cents: 80000, vat_rate: 19 }],
    });
    expect(note.status).toBe(201);
    expect(note.body.lines[0].unit).toBe('DAY');
    expect((await call('get', `/api/invoices/${draft.body.id}/xrechnung.xml?credit_note=${note.body.id}`)).text).toContain('unitCode="DAY"');

    const template = await call('post', '/api/recurring', {
      name: 'Wartung', customer_id: customerId, interval: 'monthly', start_date: '2026-01-01',
      lines: [{ description: 'Wartungspauschale', quantity: 1, unit: 'MON', unit_price_cents: 12000, vat_rate: 19 }],
    });
    expect(template.status).toBe(201);
    expect(template.body.lines[0].unit).toBe('MON');
    const generated = await call('post', `/api/recurring/${template.body.id}/generate`);
    const first = generated.body.created[0].invoice_id as number;
    expect((await call('get', `/api/invoices/${first}`)).body.lines[0].unit).toBe('MON');
  });

  it('narrows a description beside a quantity wider than the widest bare one, rather than run under it', async () => {
    const customerId = await customer();
    // At the usual width its lines would reach 195 pt — past where this quantity begins.
    const description = 'Strom laut Zähler am Standort Nord, Zähler 4711 und Zähler 4712, je Monat und Tarif, Lieferung im Oktober 2026';
    const draft = await call('post', '/api/invoices', { customer_id: customerId, lines: [{ description, quantity: 999_999.9999, unit: 'KWH', unit_price_cents: 1, vat_rate: 19 }] });
    await call('post', `/api/invoices/${draft.body.id}/finalize`, { issue_date: '2026-10-21' });
    const texts = placed(await pdfOf(draft.body.id));
    const qty = texts.find((t) => t.text === '999.999,9999 kWh')!;
    expect(qty).toBeDefined();
    const lines = texts.filter((t) => t.font === 'F1' && t.size === 9 && t.y <= qty.y && t.y > qty.y - 60 && t.x < qty.x);
    expect(lines.map((t) => t.text).join(' ')).toBe(description);
    for (const line of lines) expect(line.x + textWidth('F1', 9, line.text)).toBeLessThan(qty.x);
  });
});

describe('lines from before units existed', () => {
  it('stay pieces, on invoices and credit notes alike — what was sent does not change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mod04-units-'));
    try {
      const file = join(dir, 'invoices.db');
      let database = openDb(file);
      const customerId = Number(database.prepare("INSERT INTO customers (name, created_at) VALUES ('Kunde AG', '2026-01-01T00:00:00Z')").run().lastInsertRowid);
      const id = createDraft(database, { customerId, paymentTermsDays: 14, note: null, lines: [{ description: 'Beratung', quantity: 3, unit: 'DAY', unitPriceCents: 1000, vatRate: 19 }] });
      finalizeInvoice(database, id, '2026-10-21');
      issueCreditNote(database, id, { reason: 'Teil', issueDate: '2026-10-22', lines: [{ description: 'Beratung', quantity: 1, unitPriceCents: 1000, vatRate: 19 }] }, 'admin', '2026-10-22');
      database.close();

      // The database as the previous release left it: no unit columns.
      const raw = new Database(file);
      for (const view of ['report_receivables_aging', 'report_payments', 'report_invoice_lines', 'report_invoices', 'report_credit_notes']) {
        raw.exec(`DROP VIEW ${view}`);
      }
      raw.exec('ALTER TABLE invoice_lines DROP COLUMN unit');
      raw.exec('ALTER TABLE credit_note_lines DROP COLUMN unit');
      raw.close();

      database = openDb(file);
      const detail = invoiceDetail(database, id);
      expect(detail.lines[0]!.unit).toBe('C62');
      expect(detail.credit_notes[0]!.lines[0]!.unit).toBe('C62');
      expect((database.prepare('SELECT unit_code FROM report_invoice_lines').get() as { unit_code: string }).unit_code).toBe('C62');
      database.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
