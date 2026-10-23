import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { unicodeOf } from '../server/fonts.js';
import { A4, textWidth, wrapText } from '../server/pdf.js';

/**
 * The PDF says what the XML says — review findings M1 and M2 in
 * docs/E-RECHNUNG-REVIEW.md. In a ZUGFeRD file the XML is the invoice and the
 * PDF a picture of it; a picture that leaves something out is a second,
 * different document. Where no e-invoice is required, the plain PDF is the
 * invoice itself and needs every mandatory field.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's'.repeat(32), ttlHours: 1, secureCookie: false };
/** A seller identified by its Steuernummer and register number only, like the golden case `taxno`. */
const seller = (): SellerConfig => ({
  name: 'Beispiel GmbH',
  addressLines: ['Hauptstraße 1', '80331 München', 'Deutschland'],
  vatId: '',
  taxNumber: '143/123/45678',
  registration: 'HRB 12345',
  iban: 'DE02 1203 0000 0000 2020 51',
  bic: '',
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

const call = (method: 'get' | 'post', url: string, body?: object) => {
  const r = request(app)[method](url).set('Cookie', cookie);
  return body ? r.send(body) : r;
};

async function issued(lines: object[], extra: object = {}): Promise<number> {
  const c = await call('post', '/api/customers', {
    name: 'Kunde AG', email: 'ap@kunde.de', address: 'Kundenweg 5\n10115 Berlin', country_code: 'DE', buyer_reference: 'PO-1',
  });
  expect(c.status).toBe(201);
  const d = await call('post', '/api/invoices', { customer_id: c.body.id, lines, ...extra });
  expect(d.status).toBe(201);
  expect((await call('post', `/api/invoices/${d.body.id}/finalize`, { issue_date: '2026-10-21' })).status).toBe(200);
  return d.body.id as number;
}

/** A download as text: the XML is UTF-8, a PDF's text strings WinAnsi (Latin-1 but for €). */
async function download(url: string): Promise<string> {
  const res = await call('get', url)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (chunk: Buffer) => chunks.push(chunk));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  return (res.body as Buffer).toString(url.endsWith('.xml') ? 'utf8' : 'latin1');
}

/**
 * Every text a PDF shows, in order: the strings of its Tj operators, escapes
 * undone, WinAnsi codes as the characters they show (€ is 0x80). Both PDFs
 * keep their page content uncompressed (only the PDF/A's embedded fonts are
 * deflated), so the file itself can be read.
 */
function shown(pdf: string): string[] {
  return [...pdf.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) =>
    [...m[1]!.matchAll(/\\([0-7]{3})|\\(.)|(.)/gs)]
      .map(([, octal, escaped, plain]) => String.fromCodePoint(unicodeOf(octal ? parseInt(octal, 8) : (escaped ?? plain)!.charCodeAt(0)) ?? 0x3f))
      .join(''),
  );
}

const lines = [{ description: 'Beratung', quantity: 1, unit_price_cents: 10000, vat_rate: 19 }];

describe('M2 · the PDF names the seller as the XML does', () => {
  it('prints the Steuernummer and the register number, and no empty VAT id', async () => {
    const id = await issued(lines);
    expect(await download(`/api/invoices/${id}/xrechnung.xml`)).toContain('<ram:ID schemeID="FC">143/123/45678</ram:ID>');
    for (const url of [`/api/invoices/${id}/pdf`, `/api/invoices/${id}/zugferd.pdf`]) {
      const texts = shown(await download(url));
      expect(texts).toContain('TAX NO 143/123/45678 · HRB 12345');
      // What the footer used to say: "Beispiel GmbH · VAT " and "IBAN … · BIC ".
      expect(texts.filter((t) => /(VAT|BIC) $/.test(t))).toEqual([]);
    }
  });
});

describe('M1 · the PDF says everything the XML says', () => {
  const long = {
    description: 'Wartung der Heizungsanlage gemäß Wartungsvertrag Nr. 2026-117, inkl. Abgasmessung, Austausch der Zündelektrode und Prüfung des Ausdehnungsgefäßes',
    note: 'Projekt Sanierung Heizzentrale Schulzentrum Nord, Bauabschnitt 2 — Abrechnung nach Aufmaß vom 14.10.2026. Bitte beachten Sie die geänderte Bankverbindung ab dem 1. November 2026.',
    reason: 'Steuerfrei nach § 4 Nr. 14 Buchst. a UStG (Heilbehandlungen im Bereich der Humanmedizin durch Ärzte, Zahnärzte, Heilpraktiker und Physiotherapeuten)',
    reference: 'Bestellung 4500012345 / Kostenstelle 4711-0815 / Ansprechpartnerin Frau Meier',
  };

  it('prints long texts in full, wrapped, where they used to be cut off', async () => {
    const id = await issued(
      [{ description: long.description, quantity: 1, unit_price_cents: 10000, vat_rate: 0 }],
      { note: long.note, buyer_reference: long.reference, tax_exemption_category: 'E', tax_exemption_reason: long.reason },
    );
    const xml = await download(`/api/invoices/${id}/xrechnung.xml`);
    for (const url of [`/api/invoices/${id}/pdf`, `/api/invoices/${id}/zugferd.pdf`]) {
      const texts = shown(await download(url));
      const all = texts.join(' ');
      for (const text of Object.values(long)) {
        expect(all, url).toContain(text);
        expect(xml).toContain(text.replace(/&/g, '&amp;'));
      }
      expect(texts.some((t) => t.endsWith('…'))).toBe(false);
    }
  });

  it('states the quantity with the four decimals of the XML, written as the amounts are', async () => {
    const id = await issued([
      { description: 'Kabel', quantity: 0.3333, unit_price_cents: 99_999, vat_rate: 19 },
      { description: 'Schrauben', quantity: 1234.5, unit_price_cents: 3, vat_rate: 19 },
    ]);
    const xml = await download(`/api/invoices/${id}/xrechnung.xml`);
    expect(xml).toContain('<ram:BilledQuantity unitCode="C62">0.3333</ram:BilledQuantity>');
    expect(xml).toContain('<ram:LineTotalAmount>333.30</ram:LineTotalAmount>');
    const texts = shown(await download(`/api/invoices/${id}/pdf`));
    expect(texts).toEqual(expect.arrayContaining(['0,3333', '333,30 €', '1.234,5', '37,04 €']));
  });

  it('wraps to the width it is given, breaking a word only when it is wider on its own', () => {
    const width = 120;
    const text = 'Donaudampfschifffahrtsgesellschaftskapitänsmützen und eine ganz gewöhnliche Fortsetzung';
    const lines = wrapText('F1', 9, text, width);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(textWidth('F1', 9, line)).toBeLessThanOrEqual(width);
    expect(lines.join('').replace(/ /g, '')).toBe(text.replace(/ /g, ''));
    expect(wrapText('F1', 9, 'erste Zeile\nzweite', 400)).toEqual(['erste Zeile', 'zweite']);
  });

  it('continues a long note on the next page instead of running it into the footer', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => ({ description: `Position ${i + 1}`, quantity: 1, unit_price_cents: 100, vat_rate: 19 }));
    const note = Array.from({ length: 6 }, () => long.note).join(' ').slice(0, 500);
    const id = await issued(lines, { note });
    const pdf = await download(`/api/invoices/${id}/pdf`);
    // Text positions from the content streams: y counts up from the bottom edge;
    // the footer's rule lies at 78 pt and its lines below it.
    const ys = [...pdf.matchAll(/ ([\d.]+) Td \(((?:\\.|[^\\)])*)\) Tj/g)].map((m) => [Number(m[1]), m[2]] as const);
    const body = ys.filter(([y]) => y > 70);
    expect(body.every(([y]) => y > 78 + 6)).toBe(true);
    expect(pdf.match(/\/Type \/Page /g)!.length).toBeGreaterThan(1);
    expect(shown(pdf).join(' ')).toContain(note.slice(-40));
    expect(A4.height).toBeGreaterThan(800);
  });
});
