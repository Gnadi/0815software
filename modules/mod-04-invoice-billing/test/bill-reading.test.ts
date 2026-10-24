import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { AccessLevel, ExtractInvoiceInput, InvoiceExtraction } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { noopPlatform, OfferFetchError, type PlatformHooks } from '../server/platform.js';
import type { BillProposal, BillRow } from '../shared/types.js';

/**
 * Reading a bill from its document (server/bill-reading.ts): PS-04 reads,
 * this module proposes — which creditor, which amounts, whether it was
 * entered before — and a person saves. PS-04 is a fake here that answers
 * like the real one (its own suite, test/extraction.test.ts, pins the
 * reading against the EN 16931 examples).
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 'test-secret', ttlHours: 1, secureCookie: false };
const seller: SellerConfig = {
  name: '0815software GmbH',
  addressLines: ['Beispielgasse 8/15', '1010 Wien', 'Austria'],
  vatId: 'ATU00000000',
  iban: 'AT61 1904 3002 3457 3201',
  bic: 'GIBAATWWXXX',
};
const as = (access: AccessLevel, actor: string) => `${COOKIE_NAME}=${createToken(auth, actor, Date.now(), access)}`;
const ADMIN = as('manage', 'admin');
const CLERK = as('edit', 'buchhaltung@example.com');
const VIEWER = as('view', 'eve@example.com');

const SHA = 'a'.repeat(64);
function extraction(fields: Partial<InvoiceExtraction['fields']> = {}, extra: Partial<InvoiceExtraction> = {}): InvoiceExtraction {
  return {
    source: 'e-invoice',
    syntax: 'cii',
    embedded: true,
    provider: 'mock',
    model: null,
    fields: {
      document_type: 'invoice',
      supplier_name: 'Widget GmbH',
      supplier_vat_id: 'DE123456789',
      iban: 'AT962011182202120077',
      bic: null,
      invoice_number: 'R-2026-118',
      issue_date: '2026-10-21',
      due_date: '2026-11-04',
      currency: 'EUR',
      net_cents: 100_000,
      tax_cents: 20_000,
      gross_cents: 120_000,
      payable_cents: 120_000,
      po_number: 'PO-2026-0007',
      payment_reference: 'R-2026-118',
      ...fields,
    },
    confidence: { gross_cents: 'exact' },
    lines: [],
    warnings: [],
    document_sha256: SHA,
    ...extra,
  };
}

let db: Database.Database;
let app: Express;
let asked: ExtractInvoiceInput[];
let answer: () => InvoiceExtraction;

const ai: PlatformHooks = {
  ...noopPlatform,
  aiConfigured: true,
  async extractInvoice(input) {
    asked.push(input);
    return answer();
  },
};

const read = (cookie = CLERK) => request(app).post('/api/bills/read').set('Cookie', cookie).send({ content_base64: Buffer.from('%PDF-1.7 …').toString('base64'), filename: 'r.pdf' });

beforeEach(() => {
  db = openDb(':memory:');
  asked = [];
  answer = () => extraction();
  app = createApp({ db, auth, seller, platform: ai });
});

describe('reading a supplier invoice into the bill form', () => {
  it('proposes the bill and the creditor to create; sends our own identity so it is never taken for the supplier', async () => {
    const res = (await read().expect(200)).body as { extraction: InvoiceExtraction; proposal: BillProposal };
    expect(res.proposal).toMatchObject({
      creditor: null,
      new_creditor: { name: 'Widget GmbH', iban: 'AT962011182202120077', bic: null },
      reference: 'R-2026-118',
      amount_cents: 120_000,
      net_cents: 100_000,
      due_date: '2026-11-04',
      po_number: 'PO-2026-0007',
      // The payment reference is the invoice number already: nothing to override.
      remittance: null,
      duplicate_of: null,
      read_from: 'e-invoice:cii:pdf',
      document_sha256: SHA,
    });
    expect(asked[0]!.own).toEqual({ names: ['0815software GmbH'], vat_ids: ['ATU00000000'], ibans: ['AT611904300234573201'] });
    // Nothing was saved.
    expect(db.prepare('SELECT COUNT(*) AS n FROM bills').get()).toEqual({ n: 0 });
  });

  it('finds the creditor by IBAN; by name only with a loud warning when the account differs', async () => {
    const c = (await request(app).post('/api/creditors').set('Cookie', ADMIN).send({ name: 'Widget GmbH', iban: 'AT96 2011 1822 0212 0077' }).expect(201)).body.id as number;
    expect(((await read().expect(200)).body.proposal as BillProposal).creditor).toEqual({ id: c, name: 'Widget GmbH', matched_by: 'iban' });

    answer = () => extraction({ iban: 'DE02120300000000202051' });
    const changed = (await read().expect(200)).body.proposal as BillProposal;
    expect(changed.creditor).toMatchObject({ id: c, matched_by: 'name' });
    expect(changed.warnings[0]).toBe('The invoice asks for payment to DE02120300000000202051, but Widget GmbH is on file with AT962011182202120077 — confirm the change with the supplier before paying');
  });

  it('a saved bill keeps where it was read from; the same document again, or the same number, is flagged', async () => {
    const c = (await request(app).post('/api/creditors').set('Cookie', ADMIN).send({ name: 'Widget GmbH', iban: 'AT96 2011 1822 0212 0077' }).expect(201)).body.id as number;
    const p = (await read().expect(200)).body.proposal as BillProposal;
    const saved = (
      await request(app)
        .post('/api/bills')
        .set('Cookie', CLERK)
        .send({ creditor_id: c, reference: p.reference, amount_cents: p.amount_cents, due_date: p.due_date, read_from: p.read_from, document_sha256: p.document_sha256 })
        .expect(201)
    ).body as BillRow;
    expect(saved).toMatchObject({ read_from: 'e-invoice:cii:pdf', document_sha256: SHA });

    const again = (await read().expect(200)).body.proposal as BillProposal;
    expect(again.duplicate_of).toBe(saved.id);
    expect(again.warnings[0]).toBe(`Already entered as bill #${saved.id}`);
    // A different file of the same invoice (a reprint): caught by the number.
    answer = () => extraction({}, { document_sha256: 'b'.repeat(64) });
    expect(((await read().expect(200)).body.proposal as BillProposal).duplicate_of).toBe(saved.id);

    await request(app).post('/api/bills').set('Cookie', CLERK).send({ creditor_id: c, reference: 'X', amount_cents: 1, due_date: '2026-11-30', read_from: 'guesswork' }).expect(422);
  });

  it('a part-paid invoice proposes what is still owed; the payment reference is kept when it differs', async () => {
    answer = () => extraction({ payable_cents: 70_000, payment_reference: 'Kd 4711 / R-2026-118' });
    const p = (await read().expect(200)).body.proposal as BillProposal;
    expect(p).toMatchObject({ amount_cents: 70_000, remittance: 'Kd 4711 / R-2026-118' });
  });

  it('PS-04\'s refusals reach the person as they are; an outage is a 502; a viewer cannot read bills in', async () => {
    answer = () => {
      throw new OfferFetchError(422, 'This PDF has no readable text layer (a scan?) — reading it takes a vision model');
    };
    expect((await read().expect(422)).body.error).toContain('vision model');
    answer = () => {
      throw new OfferFetchError(502, 'The AI platform is unreachable: ECONNREFUSED');
    };
    await read().expect(502);
    await read(VIEWER).expect(403);
    await request(app).post('/api/bills/read').set('Cookie', CLERK).send({}).expect(422);
  });

  it('takes a scan-sized document on this route, and only here', async () => {
    const scan = Buffer.alloc(4 * 1024 * 1024, 0xff).toString('base64');
    await request(app).post('/api/bills/read').set('Cookie', CLERK).send({ content_base64: scan }).expect(200);
    expect(asked[0]!.content_base64).toHaveLength(scan.length);
    await request(app).post('/api/creditors').set('Cookie', ADMIN).send({ name: 'x'.repeat(2 * 1024 * 1024), iban: 'AT96 2011 1822 0212 0077' }).expect(413);
  });

  it('without PS-04 the route says what is missing, and the form stays as it was', async () => {
    const standalone = createApp({ db: openDb(':memory:'), auth, seller });
    expect((await request(standalone).get('/api/settings/bill-reading').set('Cookie', ADMIN).expect(200)).body).toMatchObject({ available: false, model: null });
    await request(standalone).post('/api/bills/read').set('Cookie', ADMIN).send({ content_base64: 'eA==' }).expect(501);
  });
});

describe('which model may read invoices is the administrator\'s', () => {
  it('patterns only by default; a manager may name a model, which is then asked for', async () => {
    expect((await request(app).get('/api/settings/bill-reading').set('Cookie', CLERK).expect(200)).body).toMatchObject({ model: null, available: true });
    await read().expect(200);
    expect(asked[0]!.provider).toBeUndefined();

    await request(app).put('/api/settings/bill-reading').set('Cookie', CLERK).send({ model: 'anthropic' }).expect(403);
    await request(app).put('/api/settings/bill-reading').set('Cookie', ADMIN).send({ model: 'skynet' }).expect(422);
    const set = (await request(app).put('/api/settings/bill-reading').set('Cookie', ADMIN).send({ model: 'anthropic' }).expect(200)).body;
    expect(set).toMatchObject({ model: 'anthropic', updated_by: 'admin' });
    await read().expect(200);
    expect(asked[1]!.provider).toBe('anthropic');
  });
});
