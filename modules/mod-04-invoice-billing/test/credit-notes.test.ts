import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { noopPlatform, type CreditNoteInfo } from '../server/platform.js';
import { bookingsFor } from '../server/accounting-export.js';
import { dunningOverview } from '../server/dunning.js';
import { addDays, customerLedger, invoiceDetail, todayIso } from '../server/invoices.js';

/**
 * Teilgutschriften (server/credit-notes.ts): a document of its own that takes
 * back part of an issued invoice — never more than was invoiced per VAT rate,
 * immutable once issued, and reflected wherever "what is owed" is derived.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's', ttlHours: 1, secureCookie: false };
const seller: SellerConfig = {
  name: 'Beispiel GmbH',
  addressLines: ['Hauptstraße 1', '80331 München', 'Deutschland'],
  vatId: 'DE123456789',
  iban: 'DE02 1203 0000 0000 2020 51',
  bic: 'BYLADEM1001',
  contactName: 'Erika Mustermann',
  phone: '+49 89 123456',
  email: 'rechnung@beispiel.de',
};

let db: Database.Database;
let app: Express;
let audited: CreditNoteInfo[];
const today = todayIso();
const as = (access: AccessLevel) => `${COOKIE_NAME}=${createToken(auth, `${access}@example`, Date.now(), access)}`;

beforeEach(() => {
  db = openDb(':memory:');
  audited = [];
  app = createApp({ db, auth, seller, platform: { ...noopPlatform, creditNoteIssued: async (info) => void audited.push(info) } });
});

/**
 * An issued German invoice: 3 × 10.00 € at 19 % and 1 × 50.00 € at 7 %.
 * Net 80.00, VAT 5.70 + 3.50, gross 89.20 €.
 */
async function invoice(issueDate = addDays(today, -20)): Promise<number> {
  const customer = await request(app)
    .post('/api/customers')
    .set('Cookie', as('manage'))
    .send({ name: 'Kunde AG', email: 'ap@kunde.de', vat_id: 'DE987654321', address: 'Kundenweg 5\n10115 Berlin', country_code: 'DE', buyer_reference: 'PO-1' })
    .expect(201);
  const draft = await request(app)
    .post('/api/invoices')
    .set('Cookie', as('edit'))
    .send({
      customer_id: customer.body.id,
      payment_terms_days: 14,
      lines: [
        { description: 'Seminar', quantity: 3, unit_price_cents: 1000, vat_rate: 19 },
        { description: 'Fachbuch', quantity: 1, unit_price_cents: 5000, vat_rate: 7 },
      ],
    })
    .expect(201);
  await request(app).post(`/api/invoices/${draft.body.id}/finalize`).set('Cookie', as('edit')).send({ issue_date: issueDate }).expect(200);
  return draft.body.id as number;
}

const seminar = (quantity: number) => ({ description: 'Seminar', quantity, unit_price_cents: 1000, vat_rate: 19 });
const credit = (id: number, lines: unknown[], extra: Record<string, unknown> = {}, access: AccessLevel = 'edit') =>
  request(app).post(`/api/invoices/${id}/credit-notes`).set('Cookie', as(access)).send({ reason: 'Teilnehmer abgesagt', lines, ...extra });

describe('a credit note is its own document', () => {
  it('numbers per invoice, keeps its own totals and names who issued it', async () => {
    const id = await invoice();
    const first = await credit(id, [seminar(1)]).expect(201);
    expect(first.body).toMatchObject({ number: 'INV-2026-0001-GS1', issue_date: today, net_cents: 1000, vat_cents: 190, gross_cents: 1190, actor: 'edit@example' });
    const second = await credit(id, [seminar(1)]).expect(201);
    expect(second.body.number).toBe('INV-2026-0001-GS2');
    expect(audited.map((a) => a.number)).toEqual(['INV-2026-0001-GS1', 'INV-2026-0001-GS2']);
    // Nothing edits or deletes it.
    await request(app).put(`/api/invoices/${id}/credit-notes/${first.body.id}`).set('Cookie', as('manage')).send({}).expect(404);
    await request(app).delete(`/api/invoices/${id}/credit-notes/${first.body.id}`).set('Cookie', as('manage')).expect(404);
  });

  it('lowers what is owed: open amount, payment cap, paid status', async () => {
    const id = await invoice();
    await credit(id, [seminar(1)]).expect(201);
    let detail = invoiceDetail(db, id);
    expect(detail).toMatchObject({ gross_cents: 8920, credited_cents: 1190, open_cents: 7730, status: 'sent' });
    // The invoice as issued is unchanged.
    expect(detail.lines.map((l) => l.quantity)).toEqual([3, 1]);

    const over = await request(app).post(`/api/invoices/${id}/payments`).set('Cookie', as('edit')).send({ amount_cents: 7731 }).expect(422);
    expect(over.body.details[0].message).toMatch(/7730 cents open/);
    await request(app).post(`/api/invoices/${id}/payments`).set('Cookie', as('edit')).send({ amount_cents: 7730 }).expect(201);
    detail = invoiceDetail(db, id);
    expect(detail).toMatchObject({ status: 'paid', payment_status: 'paid', open_cents: 0 });
  });

  it('credited in full and unpaid: nothing open, not overdue, not dunned — but not "paid" either', async () => {
    const id = await invoice(addDays(today, -60));
    await credit(id, [seminar(3), { description: 'Fachbuch', quantity: 1, unit_price_cents: 5000, vat_rate: 7 }]).expect(201);
    expect(invoiceDetail(db, id)).toMatchObject({ status: 'sent', open_cents: 0, overdue: false, creditable: [{ rate: 7, base_cents: 0, vat_cents: 0 }, { rate: 19, base_cents: 0, vat_cents: 0 }] });
    expect(dunningOverview(db, today)).toEqual([]);
    await credit(id, [seminar(1)]).expect(422);
  });
});

describe('never more than was invoiced, per VAT rate', () => {
  it('refuses more than is left at a rate, across credit notes', async () => {
    const id = await invoice();
    await credit(id, [seminar(2)]).expect(201);
    const res = await credit(id, [seminar(2)]).expect(422);
    expect(res.body.details[0].message).toMatch(/At 19 % only 1000 cents net/);
    await credit(id, [seminar(1)]).expect(201);
  });

  it('refuses a rate the invoice does not carry, even where the amount would fit', async () => {
    const id = await invoice();
    const res = await credit(id, [{ description: 'x', quantity: 1, unit_price_cents: 100, vat_rate: 20 }]).expect(422);
    expect(res.body.details).toEqual([expect.objectContaining({ field: 'lines[0].vat_rate' })]);
  });

  it('caps the VAT too: two half credits cannot return a cent more VAT than was charged', async () => {
    const customer = await request(app).post('/api/customers').set('Cookie', as('edit')).send({ name: 'K', address: 'x' }).expect(201);
    const draft = await request(app)
      .post('/api/invoices')
      .set('Cookie', as('edit'))
      .send({ customer_id: customer.body.id, lines: [{ description: 'x', quantity: 1, unit_price_cents: 16, vat_rate: 7 }] })
      .expect(201);
    await request(app).post(`/api/invoices/${draft.body.id}/finalize`).set('Cookie', as('edit')).send({}).expect(200);
    // 16 cents at 7 % → 1 cent VAT (1.12). Each 8-cent half rounds 0.56 → 1:
    // the second half fits the base but would return a second cent of VAT.
    const half = { description: 'x', quantity: 1, unit_price_cents: 8, vat_rate: 7 };
    await credit(draft.body.id, [half]).expect(201);
    expect(invoiceDetail(db, draft.body.id).creditable).toEqual([{ rate: 7, base_cents: 8, vat_cents: 0 }]);
    const res = await credit(draft.body.id, [half]).expect(422);
    expect(res.body.details[0].message).toMatch(/0 cents VAT/);
    expect(invoiceDetail(db, draft.body.id).credited_cents).toBe(9);
  });
});

describe('the rules around it', () => {
  it('only on an issued, uncancelled invoice; a credited invoice is not cancelled on top', async () => {
    const id = await invoice();
    const customer = invoiceDetail(db, id).customer_id;
    const draft = await request(app).post('/api/invoices').set('Cookie', as('edit')).send({ customer_id: customer, lines: [seminar(1)] }).expect(201);
    await credit(draft.body.id, [seminar(1)]).expect(409);

    await credit(id, [seminar(1)]).expect(201);
    const cancel = await request(app).post(`/api/invoices/${id}/cancel`).set('Cookie', as('edit')).send({ reason: 'x' }).expect(409);
    expect(cancel.body.error).toMatch(/partly credited \(INV-2026-0001-GS1\)/);

    const other = await invoice();
    await request(app).post(`/api/invoices/${other}/cancel`).set('Cookie', as('edit')).send({ reason: 'x' }).expect(200);
    await credit(other, [seminar(1)]).expect(409);
  });

  it('needs a reason and a date between the invoice and today', async () => {
    const id = await invoice(addDays(today, -5));
    const res = await credit(id, [seminar(1)], { reason: '', issue_date: addDays(today, 1) }).expect(422);
    expect(res.body.details.map((d: { field: string }) => d.field)).toEqual(['reason']);
    expect((await credit(id, [seminar(1)], { issue_date: addDays(today, 1) }).expect(422)).body.details[0].field).toBe('issue_date');
    expect((await credit(id, [seminar(1)], { issue_date: addDays(today, -6) }).expect(422)).body.details[0].field).toBe('issue_date');
    await credit(id, [seminar(1)], { issue_date: addDays(today, -5) }).expect(201);
  });

  it('is edit work; reading it is view', async () => {
    const id = await invoice();
    await credit(id, [seminar(1)], {}, 'view').expect(403);
    const note = await credit(id, [seminar(1)]).expect(201);
    const pdf = await request(app).get(`/api/invoices/${id}/credit-notes/${note.body.id}/pdf`).set('Cookie', as('view')).buffer(true).expect(200);
    const text = (pdf.body as Buffer).toString('latin1');
    expect(text).toContain('CREDIT NOTE');
    expect(text).toContain('CORRECTS');
    expect(text).toContain('INV-2026-0001-GS1');
    // Only under its own invoice.
    const other = await invoice();
    await request(app).get(`/api/invoices/${other}/credit-notes/${note.body.id}/pdf`).set('Cookie', as('view')).expect(404);
  });
});

describe('everywhere "owed" is derived', () => {
  it('the ledger: invoiced − credited − paid, and a credit after payment leaves the customer in credit', async () => {
    const id = await invoice();
    await request(app).post(`/api/invoices/${id}/payments`).set('Cookie', as('edit')).send({ amount_cents: 8920, date: addDays(today, -1) }).expect(201);
    await credit(id, [seminar(1)]).expect(201);
    const ledger = customerLedger(db, invoiceDetail(db, id).customer_id);
    expect(ledger).toMatchObject({ invoiced_cents: 8920, credited_cents: 1190, paid_cents: 8920, balance_cents: -1190 });
    expect(ledger.entries.map((e) => e.type)).toEqual(['invoice', 'payment', 'credit_note']);
    expect(ledger.entries.at(-1)).toMatchObject({ number: 'INV-2026-0001-GS1', amount_cents: -1190, balance_cents: -1190 });
    expect(invoiceDetail(db, id)).toMatchObject({ status: 'paid', open_cents: 0 });
  });

  it('the reporting views agree with the API', async () => {
    const id = await invoice();
    const note = await credit(id, [seminar(1), { description: 'Fachbuch', quantity: 0.5, unit_price_cents: 5000, vat_rate: 7 }]).expect(201);
    expect(db.prepare('SELECT * FROM report_credit_notes').all()).toEqual([
      expect.objectContaining({ credit_note_number: 'INV-2026-0001-GS1', invoice_number: 'INV-2026-0001', net_cents: note.body.net_cents, vat_cents: note.body.vat_cents, gross_cents: note.body.gross_cents, invoice_is_cancelled: 0 }),
    ]);
    const row = db.prepare('SELECT gross_cents, credited_cents, outstanding_cents FROM report_invoices').get();
    expect(row).toEqual({ gross_cents: 8920, credited_cents: note.body.gross_cents, outstanding_cents: 8920 - note.body.gross_cents });
  });

  it('the bookkeeping export books it as a reversal on its own date and number', async () => {
    const issued = addDays(today, -40);
    const id = await invoice(issued);
    await credit(id, [seminar(1)]).expect(201);
    // The period of the credit note alone: only the correction, not the invoice.
    const bookings = bookingsFor(db, { from: addDays(today, -1), to: today });
    expect(bookings).toEqual([
      expect.objectContaining({ kind: 'credit_note', date: today, document: 'INV-2026-0001-GS1', invoice_number: 'INV-2026-0001', rate: 19, gross_cents: 1190, vat_cents: 190 }),
    ]);
    expect(bookingsFor(db, { from: issued, to: today }).map((b) => b.kind)).toEqual(['invoice', 'invoice', 'credit_note']);
  });
});

describe('as an e-invoice', () => {
  const HAVE_XMLLINT = ((): boolean => {
    try {
      execFileSync('xmllint', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();
  const SCHEMA = join(import.meta.dirname, 'schema');

  it('is a 381 naming the invoice, with only its own lines', async () => {
    const id = await invoice();
    const note = await credit(id, [seminar(2)]).expect(201);
    const xml = (await request(app).get(`/api/invoices/${id}/xrechnung.xml?credit_note=${note.body.id}`).set('Cookie', as('view')).expect(200)).text;
    expect(xml).toContain('<ram:ID>INV-2026-0001-GS1</ram:ID>');
    expect(xml).toContain('<ram:TypeCode>381</ram:TypeCode>');
    expect(xml).toContain('<ram:IssuerAssignedID>INV-2026-0001</ram:IssuerAssignedID>');
    expect(xml).toContain('<ram:GrandTotalAmount>23.80</ram:GrandTotalAmount>');
    expect(xml).not.toContain('Fachbuch');
    await request(app).get(`/api/invoices/${id}/xrechnung.xml?credit_note=abc`).set('Cookie', as('view')).expect(422);
    const other = await invoice();
    await request(app).get(`/api/invoices/${other}/xrechnung.xml?credit_note=${note.body.id}`).set('Cookie', as('view')).expect(404);
  });

  it.skipIf(!HAVE_XMLLINT)('validates against the CII and ebInterface schemas', async () => {
    const id = await invoice();
    const note = await credit(id, [seminar(1)]).expect(201);
    const dir = mkdtempSync(join(tmpdir(), 'mod04-credit-'));
    try {
      const cii = join(dir, 'cii.xml');
      writeFileSync(cii, (await request(app).get(`/api/invoices/${id}/xrechnung.xml?credit_note=${note.body.id}`).set('Cookie', as('view')).expect(200)).text);
      execFileSync('xmllint', ['--noout', '--schema', join(SCHEMA, 'cii-en16931', 'FACTUR-X_EN16931.xsd'), cii], { stdio: 'pipe' });
      const eb = await request(app).get(`/api/invoices/${id}/ebinterface.xml?credit_note=${note.body.id}`).set('Cookie', as('view')).expect(200);
      expect(eb.text).toContain('DocumentType="CreditMemo"');
      const ebFile = join(dir, 'eb.xml');
      writeFileSync(ebFile, eb.text);
      execFileSync('xmllint', ['--noout', '--schema', join(SCHEMA, 'ebinterface-6p1', 'Invoice.xsd'), ebFile], { stdio: 'pipe' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
