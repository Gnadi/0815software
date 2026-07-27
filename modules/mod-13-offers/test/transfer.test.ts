import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { offerTransfer } from '../server/transfer-export.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import { computeTotals } from '../shared/money.js';
import { TRANSFER_VERSION, validateTransfer, type DocumentTransfer } from '../shared/transfer.js';
import type { OfferDetail } from '../shared/types.js';

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
  email: 'offers@0815software.example.at',
};

const SERVICE_TOKEN = 'test-machine-token';
const CLOCK = '2026-07-20';

let db: Database.Database;
let app: Express;
let cookie: string;

async function login(): Promise<string> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  expect(res.status).toBe(200);
  return res.headers['set-cookie']![0]!.split(';')[0]!;
}

/** Create a customer and an offer, send it, and have the customer accept it. */
async function acceptedOffer(
  lines: { description: string; quantity: number; unit_price_cents: number; vat_rate: number; discount_percent?: number }[],
): Promise<OfferDetail> {
  const customer = await request(app)
    .post('/api/customers')
    .set('Cookie', cookie)
    .send({
      name: 'Blaustern Café GmbH',
      contact_person: 'Anna Berger',
      email: 'buchhaltung@blaustern.example',
      vat_id: 'ATU12345678',
      address: 'Hauptstraße 12, 5020 Salzburg',
    });
  expect(customer.status).toBe(201);

  const draft = await request(app)
    .post('/api/offers')
    .set('Cookie', cookie)
    .send({
      customer_id: customer.body.id,
      title: 'Platform onboarding',
      intro: 'Thank you for your interest.',
      valid_until: '2026-08-31',
      lines,
    });
  expect(draft.status).toBe(201);

  await request(app).post(`/api/offers/${draft.body.id}/send`).set('Cookie', cookie).send({}).expect(200);
  await request(app).post(`/api/offers/${draft.body.id}/accept`).set('Cookie', cookie).send({}).expect(200);

  const detail = await request(app).get(`/api/offers/${draft.body.id}`).set('Cookie', cookie);
  expect(detail.status).toBe(200);
  return detail.body as OfferDetail;
}

beforeEach(async () => {
  db = openDb(':memory:');
  app = createApp({ db, auth, seller, publicBaseUrl: 'http://localhost:3013', clock: () => CLOCK, serviceToken: SERVICE_TOKEN });
  cookie = await login();
});

describe('GET /api/offers/:number/transfer — auth', () => {
  it('requires the platform machine token, not a staff session', async () => {
    const offer = await acceptedOffer([
      { description: 'Consulting', quantity: 10, unit_price_cents: 12000, vat_rate: 20 },
    ]);
    const number = offer.number!;

    await request(app).get(`/api/offers/${number}/transfer`).expect(401);
    // A logged-in human session is deliberately NOT enough: the endpoint exists
    // for another service in the stack.
    await request(app).get(`/api/offers/${number}/transfer`).set('Cookie', cookie).expect(401);
    await request(app).get(`/api/offers/${number}/transfer`).set('X-Service-Token', 'wrong').expect(401);
    await request(app).get(`/api/offers/${number}/transfer`).set('X-Service-Token', SERVICE_TOKEN).expect(200);
  });

  it('is closed when the module has no machine token configured', async () => {
    const standalone = createApp({ db, auth, seller, publicBaseUrl: 'http://localhost:3013', clock: () => CLOCK });
    const offer = await acceptedOffer([
      { description: 'Consulting', quantity: 1, unit_price_cents: 10000, vat_rate: 20 },
    ]);
    await request(standalone)
      .get(`/api/offers/${offer.number}/transfer`)
      .set('X-Service-Token', SERVICE_TOKEN)
      .expect(401);
  });
});

describe('GET /api/offers/:number/transfer — the shape', () => {
  it('exports an accepted offer as a valid, self-consistent transfer', async () => {
    const offer = await acceptedOffer([
      { description: 'Consulting — platform onboarding (10h)', quantity: 10, unit_price_cents: 12000, vat_rate: 20 },
      { description: 'Priority support, one year', quantity: 1, unit_price_cents: 90000, vat_rate: 20 },
    ]);

    const res = await request(app).get(`/api/offers/${offer.number}/transfer`).set('X-Service-Token', SERVICE_TOKEN);
    expect(res.status).toBe(200);
    const transfer = res.body as DocumentTransfer;

    expect(validateTransfer(transfer)).toEqual([]);
    expect(transfer.transfer_version).toBe(TRANSFER_VERSION);
    expect(transfer.currency).toBe('EUR');
    expect(transfer.origin).toMatchObject({
      kind: 'offer',
      module: 'mod-13-offers',
      reference: offer.number,
    });
    expect(transfer.origin.accepted_at).not.toBeNull();

    expect(transfer.customer).toMatchObject({
      name: 'Blaustern Café GmbH',
      contact_person: 'Anna Berger',
      email: 'buchhaltung@blaustern.example',
      vat_id: 'ATU12345678',
      source: 'mod-13-offers',
    });
    expect(transfer.customer.address_lines).toEqual(['Hauptstraße 12', '5020 Salzburg']);
    expect(transfer.customer.party_id).toBeNull();

    // The totals in the transfer are exactly the offer's own totals.
    expect(transfer.totals).toEqual({
      net_cents: offer.net_cents,
      vat_cents: offer.vat_cents,
      gross_cents: offer.gross_cents,
    });
    expect(transfer.lines).toHaveLength(2);
    expect(transfer.note).toBe('Thank you for your interest.');
  });

  it('leaks no MOD-13 internals', async () => {
    const offer = await acceptedOffer([
      { description: 'Consulting', quantity: 1, unit_price_cents: 10000, vat_rate: 20 },
    ]);
    const res = await request(app).get(`/api/offers/${offer.number}/transfer`).set('X-Service-Token', SERVICE_TOKEN);
    const keys = Object.keys(res.body).sort();
    expect(keys).toEqual(['currency', 'customer', 'lines', 'note', 'origin', 'totals', 'transfer_version']);
    // No status, no offer id, no revision chain, no public token.
    const serialized = JSON.stringify(res.body);
    for (const leak of ['public_token', 'supersedes', 'superseded', 'events', '"status"', 'offer_id']) {
      expect(serialized).not.toContain(leak);
    }
    expect(Object.keys(res.body.lines[0]).sort()).toEqual([
      'description',
      'discount_percent',
      'net_cents',
      'quantity',
      'unit_price_cents',
      'vat_rate',
    ]);
  });

  it('carries a per-line discount at full fidelity, with an exact net', async () => {
    const lines = [
      { description: 'Consulting', quantity: 7, unit_price_cents: 12345, vat_rate: 20, discount_percent: 12.5 },
      { description: 'Licence', quantity: 3, unit_price_cents: 4999, vat_rate: 10 },
    ];
    const offer = await acceptedOffer(lines);
    const res = await request(app).get(`/api/offers/${offer.number}/transfer`).set('X-Service-Token', SERVICE_TOKEN);
    const transfer = res.body as DocumentTransfer;

    expect(validateTransfer(transfer)).toEqual([]);
    expect(transfer.lines[0]!.discount_percent).toBe(12.5);
    expect(transfer.lines[0]!.unit_price_cents).toBe(12345);
    // The module's own money rules decided this; the transfer just carries it.
    const expected = computeTotals(
      lines.map((l) => ({
        quantity: l.quantity,
        unit_price_cents: l.unit_price_cents,
        vat_rate: l.vat_rate,
        discount_percent: l.discount_percent ?? 0,
      })),
    );
    expect(transfer.totals.net_cents).toBe(expected.net_cents);
    expect(transfer.totals.vat_cents).toBe(expected.vat_cents);
    expect(transfer.totals.gross_cents).toBe(expected.gross_cents);
  });

  it('mixes VAT rates without losing a cent', async () => {
    const offer = await acceptedOffer([
      { description: 'Zero rated', quantity: 1, unit_price_cents: 3333, vat_rate: 0 },
      { description: 'Reduced', quantity: 3, unit_price_cents: 1111, vat_rate: 10 },
      { description: 'Standard', quantity: 2, unit_price_cents: 777, vat_rate: 20 },
    ]);
    const res = await request(app).get(`/api/offers/${offer.number}/transfer`).set('X-Service-Token', SERVICE_TOKEN);
    expect(validateTransfer(res.body)).toEqual([]);
    expect(res.body.totals.gross_cents).toBe(offer.gross_cents);
  });
});

describe('GET /api/offers/:number/transfer — only accepted offers', () => {
  async function offerInState(state: 'draft' | 'sent' | 'rejected' | 'withdrawn'): Promise<string | null> {
    const customer = await request(app)
      .post('/api/customers')
      .set('Cookie', cookie)
      .send({ name: 'Nordwind AG', email: 'r@nordwind.example' });
    const draft = await request(app)
      .post('/api/offers')
      .set('Cookie', cookie)
      .send({
        customer_id: customer.body.id,
        title: 'Quote',
        valid_until: '2026-08-31',
        lines: [{ description: 'Item', quantity: 1, unit_price_cents: 10000, vat_rate: 20 }],
      });
    if (state === 'draft') return null;
    await request(app).post(`/api/offers/${draft.body.id}/send`).set('Cookie', cookie).send({}).expect(200);
    if (state === 'rejected') {
      await request(app).post(`/api/offers/${draft.body.id}/reject`).set('Cookie', cookie).send({}).expect(200);
    }
    if (state === 'withdrawn') {
      await request(app).post(`/api/offers/${draft.body.id}/withdraw`).set('Cookie', cookie).send({}).expect(200);
    }
    const detail = await request(app).get(`/api/offers/${draft.body.id}`).set('Cookie', cookie);
    return (detail.body as OfferDetail).number;
  }

  it('refuses a sent-but-undecided offer with its status in the message', async () => {
    const number = await offerInState('sent');
    const res = await request(app).get(`/api/offers/${number}/transfer`).set('X-Service-Token', SERVICE_TOKEN);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/only an accepted offer can be billed/i);
    expect(res.body.error).toContain('sent');
  });

  it('refuses a rejected and a withdrawn offer', async () => {
    for (const state of ['rejected', 'withdrawn'] as const) {
      const number = await offerInState(state);
      const res = await request(app).get(`/api/offers/${number}/transfer`).set('X-Service-Token', SERVICE_TOKEN);
      expect(res.status, state).toBe(409);
    }
  });

  it('404s an unknown offer number', async () => {
    const res = await request(app).get('/api/offers/AN-2026-9999/transfer').set('X-Service-Token', SERVICE_TOKEN);
    expect(res.status).toBe(404);
  });

  it('refuses an offer that a revision superseded', async () => {
    const offer = await acceptedOffer([
      { description: 'Consulting', quantity: 1, unit_price_cents: 10000, vat_rate: 20 },
    ]);
    // Revising an accepted offer marks the original superseded; the successor is
    // the billable document, and the original must stop being exportable.
    const revised = await request(app).post(`/api/offers/${offer.id}/revise`).set('Cookie', cookie).send({});
    if (revised.status === 201) {
      const res = await request(app).get(`/api/offers/${offer.number}/transfer`).set('X-Service-Token', SERVICE_TOKEN);
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('superseded');
    }
  });
});

describe('offerTransfer() directly', () => {
  it('accepts an injected PS-11 party id and puts it on the wire', async () => {
    const offer = await acceptedOffer([
      { description: 'Consulting', quantity: 1, unit_price_cents: 10000, vat_rate: 20 },
    ]);
    const transfer = offerTransfer(db, offer.number!, { today: CLOCK, partyId: 4711 });
    expect(transfer.customer.party_id).toBe(4711);
    expect(validateTransfer(transfer)).toEqual([]);
  });
});

describe('validateTransfer', () => {
  const valid = (): DocumentTransfer => ({
    transfer_version: TRANSFER_VERSION,
    origin: { kind: 'offer', module: 'mod-13-offers', reference: 'AN-2026-0001', issued_at: null, accepted_at: null },
    currency: 'EUR',
    customer: {
      name: 'Blaustern Café GmbH',
      contact_person: null,
      email: null,
      vat_id: null,
      address_lines: [],
      party_id: null,
      source: 'mod-13-offers',
      external_id: '1',
    },
    lines: [
      { description: 'Item', quantity: 2, unit_price_cents: 1000, discount_percent: 0, vat_rate: 20, net_cents: 2000 },
    ],
    totals: { net_cents: 2000, vat_cents: 400, gross_cents: 2400 },
    note: null,
  });

  it('accepts a well-formed transfer', () => {
    expect(validateTransfer(valid())).toEqual([]);
  });

  it('rejects a future version outright', () => {
    const problems = validateTransfer({ ...valid(), transfer_version: 2 });
    expect(problems).toEqual([{ field: 'transfer_version', message: `must be ${TRANSFER_VERSION}, got 2` }]);
  });

  it('rejects a line whose net does not match its own arithmetic', () => {
    const bad = valid();
    bad.lines[0]!.net_cents = 1999;
    const problems = validateTransfer(bad);
    expect(problems.map((p) => p.field)).toContain('lines[0].net_cents');
  });

  it('rejects totals that do not add up — the check that stops a wrong invoice', () => {
    const bad = valid();
    bad.totals.gross_cents = 9999;
    const problems = validateTransfer(bad);
    expect(problems).toEqual([
      { field: 'totals.gross_cents', message: 'declared 9999 but the lines add up to 2400' },
    ]);
  });

  it('requires an origin reference, a customer name and at least one line', () => {
    expect(validateTransfer({ ...valid(), lines: [] }).map((p) => p.field)).toContain('lines');
    const noRef = valid();
    noRef.origin.reference = '   ';
    expect(validateTransfer(noRef).map((p) => p.field)).toContain('origin.reference');
    const noName = valid();
    noName.customer.name = '';
    expect(validateTransfer(noName).map((p) => p.field)).toContain('customer.name');
  });

  it('rejects a non-object and a bad currency', () => {
    expect(validateTransfer(null)).toEqual([{ field: 'transfer', message: 'must be an object' }]);
    expect(validateTransfer({ ...valid(), currency: 'euro' }).map((p) => p.field)).toContain('currency');
  });
});
