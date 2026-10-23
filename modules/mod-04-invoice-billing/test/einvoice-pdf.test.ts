import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type Database from 'better-sqlite3';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';

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

async function download(url: string): Promise<string> {
  const res = await call('get', url)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (chunk: Buffer) => chunks.push(chunk));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  expect(res.status).toBe(200);
  return (res.body as Buffer).toString('latin1');
}

/**
 * Every text a PDF shows, in order: the strings of its Tj operators, escapes
 * undone. Both PDFs keep their page content uncompressed (only the PDF/A's
 * embedded fonts are deflated), so the file itself can be read.
 */
function shown(pdf: string): string[] {
  return [...pdf.matchAll(/\(((?:\\.|[^\\)])*)\) Tj/g)].map((m) =>
    m[1]!.replace(/\\([0-7]{3}|.)/g, (_, esc: string) => (esc.length === 3 ? String.fromCharCode(parseInt(esc, 8)) : esc)),
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
