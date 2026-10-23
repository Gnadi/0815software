import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { RENDERER_VERSION } from '../server/issued-documents.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';

/**
 * Issued e-invoices are stored at their first delivery and served unchanged
 * afterwards (server/issued-documents.ts) — review finding H3 in
 * docs/E-RECHNUNG-REVIEW.md. Before, every download rendered the file again,
 * so any change to the renderer would have rewritten invoices already sent.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's'.repeat(32), ttlHours: 1, secureCookie: false };

let app: Express;
let db: Database.Database;
let cookie: string;

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

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, auth, seller: germanSeller() });
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'pw' });
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
});

const get = (url: string) => request(app).get(url).set('Cookie', cookie).buffer(true);

async function issued(customer: Record<string, unknown> = {}): Promise<number> {
  const c = await request(app)
    .post('/api/customers')
    .set('Cookie', cookie)
    .send({
      name: 'Kunde AG',
      email: 'ap@kunde.de',
      vat_id: 'DE987654321',
      address: 'Kundenweg 5\n10115 Berlin',
      buyer_reference: '04011000-12345-03',
      ...customer,
    });
  expect(c.status).toBe(201);
  const draft = await request(app)
    .post('/api/invoices')
    .set('Cookie', cookie)
    .send({
      customer_id: c.body.id,
      lines: [
        { description: 'Beratung', quantity: 3, unit_price_cents: 33, vat_rate: 19 },
        { description: 'Fachbuch', quantity: 1, unit_price_cents: 1999, vat_rate: 7 },
      ],
    });
  expect(draft.status).toBe(201);
  const fin = await request(app).post(`/api/invoices/${draft.body.id}/finalize`).set('Cookie', cookie).send({ issue_date: '2026-10-21' });
  expect(fin.status).toBe(200);
  return draft.body.id as number;
}

const stored = (invoiceId: number) =>
  db.prepare('SELECT document, format, number, sha256, renderer, created_by, content FROM issued_documents WHERE invoice_id = ? ORDER BY id').all(invoiceId) as {
    document: string;
    format: string;
    number: string;
    sha256: string;
    renderer: string;
    created_by: string;
    content: Buffer;
  }[];

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

describe('an e-invoice is stored at its first delivery', () => {
  it('stores the file with its hash and serves exactly those bytes again', async () => {
    const id = await issued();
    const first = await get(`/api/invoices/${id}/xrechnung.xml`);
    expect(first.status).toBe(200);
    const bytes = Buffer.from(first.text, 'utf8');

    const rows = stored(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ document: 'invoice', format: 'xrechnung', number: 'INV-2026-0001', renderer: RENDERER_VERSION, created_by: 'admin' });
    expect(rows[0]!.content.equals(bytes)).toBe(true);
    expect(rows[0]!.sha256).toBe(sha256(bytes));
    expect(first.headers.etag).toBe(`"${sha256(bytes)}"`);

    const again = await get(`/api/invoices/${id}/xrechnung.xml`);
    expect(again.text).toBe(first.text);
    expect(stored(id)).toHaveLength(1);

    const status = await get(`/api/invoices/${id}/einvoice`);
    expect(status.body.issued).toEqual([
      expect.objectContaining({ document: 'invoice', format: 'xrechnung', sha256: sha256(bytes), renderer: RENDERER_VERSION }),
    ]);
  });

  it('keeps a delivered file when what it was rendered from changes, and renders an undelivered one live', async () => {
    const id = await issued();
    const xrechnung = (await get(`/api/invoices/${id}/xrechnung.xml`)).text;
    // Stand-in for any change behind a delivered file: a renderer fix, new
    // fonts, a code-list update — here the frozen buyer itself.
    const snapshot = JSON.parse((db.prepare('SELECT buyer_snapshot FROM invoices WHERE id = ?').get(id) as { buyer_snapshot: string }).buyer_snapshot);
    db.prepare('UPDATE invoices SET buyer_snapshot = ? WHERE id = ?').run(JSON.stringify({ ...snapshot, name: 'Changed Behind The Back AG' }), id);

    expect((await get(`/api/invoices/${id}/xrechnung.xml`)).text).toBe(xrechnung);
    // ZUGFeRD had not been delivered yet, so it is rendered (and stored) now.
    const zugferd = await get(`/api/invoices/${id}/zugferd.pdf`);
    expect(zugferd.status).toBe(200);
    expect((zugferd.body as Buffer).toString('latin1')).toContain('Changed Behind The Back AG');
    expect(stored(id).map((r) => r.format)).toEqual(['xrechnung', 'zugferd']);
  });

  it('stores each document of an invoice on its own: the invoice, its cancellation, a credit note', async () => {
    const credited = await issued();
    const note = await request(app)
      .post(`/api/invoices/${credited}/credit-notes`)
      .set('Cookie', cookie)
      .send({ reason: 'Ein Fachbuch zurück', lines: [{ description: 'Fachbuch', quantity: 1, unit_price_cents: 1999, vat_rate: 7 }] });
    expect(note.status).toBe(201);
    expect((await get(`/api/invoices/${credited}/xrechnung.xml`)).status).toBe(200);
    expect((await get(`/api/invoices/${credited}/xrechnung.xml?credit_note=${note.body.id}`)).status).toBe(200);
    expect(stored(credited).map((r) => [r.document, r.number])).toEqual([
      ['invoice', 'INV-2026-0001'],
      [`credit_note:${note.body.id}`, 'INV-2026-0001-GS1'],
    ]);

    const cancelled = await issued();
    await request(app).post(`/api/invoices/${cancelled}/cancel`).set('Cookie', cookie).send({ reason: 'Doppelt' });
    expect((await get(`/api/invoices/${cancelled}/zugferd.pdf?document=cancellation`)).status).toBe(200);
    expect(stored(cancelled).map((r) => [r.document, r.format, r.number])).toEqual([['cancellation', 'zugferd', 'INV-2026-0002-ST']]);
  });

  it('stores nothing it refuses', async () => {
    const id = await issued({ buyer_reference: null });
    expect((await get(`/api/invoices/${id}/xrechnung.xml`)).status).toBe(422);
    expect(stored(id)).toEqual([]);
  });

  it('refuses to change or delete a stored file in the database itself', async () => {
    const id = await issued();
    await get(`/api/invoices/${id}/xrechnung.xml`);
    expect(() => db.prepare("UPDATE issued_documents SET content = X'00' WHERE invoice_id = ?").run(id)).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM issued_documents WHERE invoice_id = ?').run(id)).toThrow(/immutable/);
    expect(stored(id)).toHaveLength(1);
  });
});

/**
 * RENDERER_VERSION names the code that produced a stored file. It is only
 * worth something if it changes whenever the output does, so it is pinned to
 * the golden files: regenerating them after a renderer change fails here
 * until the version is bumped and its fingerprint recorded. When a case in
 * test/einvoice-cases.ts changed and the renderer did not, the version stays
 * and only its fingerprint is recorded again; the commit shows which it was.
 */
const FINGERPRINTS: Record<string, string> = {
  'mod-04-einvoice-1': '788a4b8c9e1bf791452b07c4f17cc92771c3cc665067e742e34a42f48966ab1f',
  // The PDF footer names the Steuernummer and register number (M2); the XML is unchanged.
  'mod-04-einvoice-2': '788a4b8c9e1bf791452b07c4f17cc92771c3cc665067e742e34a42f48966ab1f',
  // Decimal line rounding (M3); the PDF wraps texts and shows four decimals (M1); golden case `long`.
  'mod-04-einvoice-3': '6a7738bf0fedcc8d000191b4bc7194a4b8864566c9bb327b0e52270fd052d83c',
  // Electronic addresses with their own scheme, seller IDs as BT-29, both in the PDF too (M4, M8).
  'mod-04-einvoice-4': '6a7738bf0fedcc8d000191b4bc7194a4b8864566c9bb327b0e52270fd052d83c',
};

describe('the renderer version', () => {
  it('belongs to the golden files it renders', () => {
    const digest = createHash('sha256');
    for (const dir of ['einvoice', 'ebinterface']) {
      const path = join(import.meta.dirname, 'fixtures', dir);
      for (const name of readdirSync(path).sort()) {
        digest.update(`${dir}/${name}\0`).update(readFileSync(join(path, name))).update('\0');
      }
    }
    expect(
      digest.digest('hex'),
      'The golden files changed, so the renderer output did: bump RENDERER_VERSION in server/issued-documents.ts and record the new fingerprint here',
    ).toBe(FINGERPRINTS[RENDERER_VERSION]);
  });
});
