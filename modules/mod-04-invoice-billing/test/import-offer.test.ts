import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { noopPlatform, OfferFetchError, type PlatformHooks } from '../server/platform.js';
import { importTransfer } from '../server/transfer-import.js';
import { TRANSFER_VERSION, transferTotals, type DocumentTransfer } from '../shared/transfer.js';
import { computeTotals } from '../shared/money.js';
import type { InvoiceDetail } from '../shared/types.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

const seller: SellerConfig = {
  name: '0815software GmbH',
  addressLines: ['Beispielgasse 8/15', '1010 Wien', 'Austria'],
  vatId: 'ATU00000000',
  iban: 'AT00 0000 0000 0000 0000',
  bic: 'EXAMPLEX',
};

/** An accepted offer as MOD-13 puts it on the wire. */
function transfer(overrides: Partial<DocumentTransfer> = {}): DocumentTransfer {
  const lines = overrides.lines ?? [
    {
      description: 'Consulting — platform onboarding (10h)',
      quantity: 10,
      unit_price_cents: 12000,
      discount_percent: 0,
      vat_rate: 20,
      net_cents: 120000,
    },
    {
      description: 'Priority support, one year',
      quantity: 1,
      unit_price_cents: 90000,
      discount_percent: 0,
      vat_rate: 20,
      net_cents: 90000,
    },
  ];
  return {
    transfer_version: TRANSFER_VERSION,
    origin: {
      kind: 'offer',
      module: 'mod-13-offers',
      reference: 'AN-2026-0007',
      issued_at: '2026-07-18',
      accepted_at: '2026-07-20T12:00:00Z',
    },
    currency: 'EUR',
    customer: {
      name: 'Blaustern Café GmbH',
      contact_person: 'Anna Berger',
      email: 'buchhaltung@blaustern.example',
      vat_id: 'ATU12345678',
      address_lines: ['Hauptstraße 12', '5020 Salzburg'],
      party_id: null,
      source: 'mod-13-offers',
      external_id: '7',
    },
    lines,
    totals: transferTotals(lines),
    note: 'Thank you for your interest.',
    ...overrides,
  };
}

/** A platform that serves one offer and records what it was asked to do. */
function offerSource(
  offers: Record<string, DocumentTransfer>,
  opts: { partyId?: number | null; fail?: OfferFetchError } = {},
): { hooks: PlatformHooks; calls: { resolved: unknown[]; billed: unknown[] } } {
  const calls = { resolved: [] as unknown[], billed: [] as unknown[], linked: [] as unknown[] };
  return {
    calls,
    hooks: {
      ...noopPlatform,
      async fetchOffer(offerNumber: string) {
        if (opts.fail) throw opts.fail;
        const found = offers[offerNumber];
        if (!found) throw new OfferFetchError(404, 'Offer not found');
        return found;
      },
      async resolveParty(info) {
        calls.resolved.push(info);
        return opts.partyId ?? null;
      },
      async linkParty(partyId: number, localCustomerId: number) {
        calls.linked.push({ partyId, localCustomerId });
      },
      async offerBilled(info) {
        calls.billed.push(info);
      },
    },
  };
}

let db: Database.Database;
let cookie: string;

async function login(app: Express): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  expect(res.status).toBe(200);
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

function build(platform: PlatformHooks): Express {
  return createApp({ db, auth, seller, platform });
}

beforeEach(() => {
  db = openDb(':memory:');
});

describe('POST /api/invoices/import-offer', () => {
  it('turns an accepted offer into a correct draft invoice', async () => {
    const doc = transfer();
    const source = offerSource({ 'AN-2026-0007': doc });
    const app = build(source.hooks);
    cookie = await login(app);

    const res = await request(app)
      .post('/api/invoices/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' });
    expect(res.status).toBe(201);
    const invoice = res.body as InvoiceDetail & { imported: boolean };

    expect(invoice.imported).toBe(true);
    expect(invoice.status).toBe('draft');
    // A draft has no number: numbering still happens at finalization.
    expect(invoice.number).toBeNull();
    expect(invoice.customer_name).toBe('Blaustern Café GmbH');
    expect(invoice.lines).toHaveLength(2);
    expect(invoice.lines[0]!.description).toBe('Consulting — platform onboarding (10h)');
    expect(invoice.lines[0]!.quantity).toBe(10);
    expect(invoice.lines[0]!.unit_price_cents).toBe(12000);
    expect(invoice.note).toBe('Thank you for your interest.');
  });

  it('carries totals and VAT through the round trip exactly', async () => {
    const doc = transfer();
    const app = build(offerSource({ 'AN-2026-0007': doc }).hooks);
    cookie = await login(app);

    const res = await request(app)
      .post('/api/invoices/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' });
    const invoice = res.body as InvoiceDetail;

    expect(invoice.net_cents).toBe(doc.totals.net_cents);
    expect(invoice.vat_cents).toBe(doc.totals.vat_cents);
    expect(invoice.gross_cents).toBe(doc.totals.gross_cents);
    // And the invoice's own money module agrees, independently.
    const recomputed = computeTotals(
      invoice.lines.map((l) => ({
        quantity: l.quantity,
        unit_price_cents: l.unit_price_cents,
        vat_rate: l.vat_rate,
      })),
    );
    expect(recomputed.gross_cents).toBe(doc.totals.gross_cents);
  });

  it('preserves the exact money of a discounted line this module cannot express', async () => {
    // MOD-13 lines carry a per-line discount; invoice lines do not. Folding must
    // not lose or invent a cent, so the line becomes a single-quantity line at
    // its exact net with the arithmetic spelled out.
    const lines = [
      {
        description: 'Consulting',
        quantity: 7,
        unit_price_cents: 12345,
        discount_percent: 12.5,
        vat_rate: 20,
        net_cents: Math.round(7 * 12345 * 0.875),
      },
    ];
    const doc = transfer({ lines, totals: transferTotals(lines) });
    const app = build(offerSource({ 'AN-2026-0007': doc }).hooks);
    cookie = await login(app);

    const res = await request(app)
      .post('/api/invoices/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' });
    const invoice = res.body as InvoiceDetail;

    expect(invoice.lines[0]!.quantity).toBe(1);
    expect(invoice.lines[0]!.unit_price_cents).toBe(lines[0]!.net_cents);
    expect(invoice.lines[0]!.description).toContain('12.5%');
    expect(invoice.gross_cents).toBe(doc.totals.gross_cents);
  });

  it('is a no-op on a repeat import — a retry never double-bills', async () => {
    const app = build(offerSource({ 'AN-2026-0007': transfer() }).hooks);
    cookie = await login(app);

    const first = await request(app)
      .post('/api/invoices/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/invoices/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' });
    expect(second.status).toBe(200);
    expect(second.body.imported).toBe(false);
    expect(second.body.id).toBe(first.body.id);

    const list = await request(app).get('/api/invoices').set('Cookie', cookie);
    expect(list.body.invoices).toHaveLength(1);
    const customers = await request(app).get('/api/customers').set('Cookie', cookie);
    expect(customers.body.customers).toHaveLength(1);
  });

  it('records the origin offer number on the invoice', async () => {
    const app = build(offerSource({ 'AN-2026-0007': transfer() }).hooks);
    cookie = await login(app);
    const res = await request(app)
      .post('/api/invoices/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' });
    const row = db.prepare('SELECT origin_offer_number FROM invoices WHERE id = ?').get(res.body.id) as {
      origin_offer_number: string;
    };
    expect(row.origin_offer_number).toBe('AN-2026-0007');
  });

  it('rejects an offer the source refuses (unaccepted) with its status', async () => {
    const source = offerSource({}, { fail: new OfferFetchError(409, 'Only an accepted offer can be billed — this one is sent') });
    const app = build(source.hooks);
    cookie = await login(app);
    const res = await request(app)
      .post('/api/invoices/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' });
    // A non-404 upstream refusal is surfaced as a bad gateway with the reason.
    expect(res.status).toBe(502);
    expect(res.body.error).toContain('accepted offer');

    const list = await request(app).get('/api/invoices').set('Cookie', cookie);
    expect(list.body.invoices).toHaveLength(0);
  });

  it('404s an offer number the source does not know', async () => {
    const app = build(offerSource({ 'AN-2026-0007': transfer() }).hooks);
    cookie = await login(app);
    const res = await request(app)
      .post('/api/invoices/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-9999' });
    expect(res.status).toBe(404);
  });

  it('requires an offer number', async () => {
    const app = build(offerSource({}).hooks);
    cookie = await login(app);
    const res = await request(app).post('/api/invoices/import-offer').set('Cookie', cookie).send({});
    expect(res.status).toBe(422);
    expect(res.body.errors ?? res.body.details).toBeDefined();
  });

  it('says so plainly when no offer source is configured', async () => {
    // The standalone posture: OFFERS_URL unset, so fetchOffer returns null.
    const app = build(noopPlatform);
    cookie = await login(app);
    const res = await request(app)
      .post('/api/invoices/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' });
    expect(res.status).toBe(501);
    expect(res.body.error).toContain('OFFERS_URL');
  });

  it('requires a session — the import is not a public endpoint', async () => {
    const app = build(offerSource({ 'AN-2026-0007': transfer() }).hooks);
    await request(app).post('/api/invoices/import-offer').send({ offer_number: 'AN-2026-0007' }).expect(401);
  });

  it('refuses a transfer whose totals do not add up', async () => {
    const doc = transfer();
    doc.totals.gross_cents = 1;
    const app = build(offerSource({ 'AN-2026-0007': doc }).hooks);
    cookie = await login(app);
    const res = await request(app)
      .post('/api/invoices/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' });
    expect(res.status).toBe(422);
    const fields = (res.body.errors ?? res.body.details ?? []).map((e: { field: string }) => e.field);
    expect(fields).toContain('totals.gross_cents');
  });

  it('refuses a currency it cannot invoice', async () => {
    const app = build(offerSource({ 'AN-2026-0007': transfer({ currency: 'CHF' }) }).hooks);
    cookie = await login(app);
    const res = await request(app)
      .post('/api/invoices/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('CHF');
  });
});

describe('the customer half', () => {
  it('resolves through PS-11 and stores the party id when it is configured', async () => {
    const source = offerSource({ 'AN-2026-0007': transfer() }, { partyId: 4711 });
    const app = build(source.hooks);
    cookie = await login(app);
    const res = await request(app)
      .post('/api/invoices/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' });

    expect(source.calls.resolved).toHaveLength(1);
    expect(source.calls.resolved[0]).toMatchObject({
      name: 'Blaustern Café GmbH',
      vatId: 'ATU12345678',
      source: 'mod-13-offers',
      externalId: '7',
    });
    const row = db.prepare('SELECT party_id FROM customers WHERE id = ?').get(res.body.customer_id) as {
      party_id: number | null;
    };
    expect(row.party_id).toBe(4711);
    // ...and this module registers its OWN id against the master party, so
    // PS-11 records that both modules refer to it.
    expect(source.calls.linked).toEqual([{ partyId: 4711, localCustomerId: res.body.customer_id }]);
  });

  it('registers no reference when PS-11 is not configured', async () => {
    const source = offerSource({ 'AN-2026-0007': transfer() });
    const app = build(source.hooks);
    cookie = await login(app);
    await request(app).post('/api/invoices/import-offer').set('Cookie', cookie).send({ offer_number: 'AN-2026-0007' });
    expect(source.calls.linked).toEqual([]);
  });

  it('matches an existing local customer by VAT id, however it was typed', async () => {
    const app = build(offerSource({ 'AN-2026-0007': transfer() }).hooks);
    cookie = await login(app);
    const existing = await request(app)
      .post('/api/customers')
      .set('Cookie', cookie)
      .send({ name: 'Blaustern Cafe', vat_id: 'atu 1234 5678' });
    expect(existing.status).toBe(201);

    const res = await request(app)
      .post('/api/invoices/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' });
    expect(res.body.customer_id).toBe(existing.body.id);

    const customers = await request(app).get('/api/customers').set('Cookie', cookie);
    expect(customers.body.customers).toHaveLength(1);
  });

  it('matches by email when there is no VAT id, and enriches without clobbering', async () => {
    const doc = transfer();
    doc.customer.vat_id = null;
    const app = build(offerSource({ 'AN-2026-0007': doc }).hooks);
    cookie = await login(app);
    const existing = await request(app)
      .post('/api/customers')
      .set('Cookie', cookie)
      .send({ name: 'Blaustern (old name)', email: 'BUCHHALTUNG@blaustern.example' });

    const res = await request(app)
      .post('/api/invoices/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' });
    expect(res.body.customer_id).toBe(existing.body.id);

    const customer = await request(app).get(`/api/customers/${existing.body.id}`).set('Cookie', cookie);
    // The known name survives; the missing address is filled in.
    expect(customer.body.name).toBe('Blaustern (old name)');
    expect(customer.body.address).toContain('Hauptstraße 12');
  });

  it('creates the customer when nothing matches', async () => {
    const app = build(offerSource({ 'AN-2026-0007': transfer() }).hooks);
    cookie = await login(app);
    const res = await request(app)
      .post('/api/invoices/import-offer')
      .set('Cookie', cookie)
      .send({ offer_number: 'AN-2026-0007' });
    const customer = await request(app).get(`/api/customers/${res.body.customer_id}`).set('Cookie', cookie);
    expect(customer.body.name).toBe('Blaustern Café GmbH');
    expect(customer.body.vat_id).toBe('ATU12345678');
    expect(customer.body.address).toBe('Hauptstraße 12\n5020 Salzburg');
  });
});

describe('the hand-off is recorded', () => {
  it('audits the import once, and not again on a replay', async () => {
    const source = offerSource({ 'AN-2026-0007': transfer() });
    const app = build(source.hooks);
    cookie = await login(app);
    await request(app).post('/api/invoices/import-offer').set('Cookie', cookie).send({ offer_number: 'AN-2026-0007' });
    await request(app).post('/api/invoices/import-offer').set('Cookie', cookie).send({ offer_number: 'AN-2026-0007' });

    expect(source.calls.billed).toHaveLength(1);
    expect(source.calls.billed[0]).toMatchObject({
      offerNumber: 'AN-2026-0007',
      customerName: 'Blaustern Café GmbH',
      actor: 'admin',
    });
  });
});

describe('importTransfer() directly', () => {
  it('is idempotent on the origin reference across separate calls', () => {
    const doc = transfer();
    const first = importTransfer(db, doc);
    const second = importTransfer(db, doc);
    expect(second.replayed).toBe(true);
    expect(second.invoiceId).toBe(first.invoiceId);
  });

  it('treats two different offers for the same customer as two invoices', () => {
    const a = importTransfer(db, transfer());
    const b = importTransfer(
      db,
      transfer({ origin: { kind: 'offer', module: 'mod-13-offers', reference: 'AN-2026-0008', issued_at: null, accepted_at: null } }),
    );
    expect(b.invoiceId).not.toBe(a.invoiceId);
    expect(b.customerId).toBe(a.customerId);
  });

  it('rejects a malformed transfer with field-level detail', () => {
    expect(() => importTransfer(db, { transfer_version: 99 })).toThrow(/not billable/);
  });
});
