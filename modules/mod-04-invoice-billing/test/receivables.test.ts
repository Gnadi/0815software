import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { noopPlatform, type PlatformHooks } from '../server/platform.js';
import type { AuthConfig } from '../server/auth.js';
import type { SellerConfig } from '../server/config.js';
import type { BankBooking } from '../shared/matching.js';

/**
 * Incoming payments, in the two postures this module has to hold.
 *
 * The first half is the one that matters most: **with no bank connection
 * configured, nothing about recording a payment changes.** PS-12 is an
 * addition to this module, not a dependency of it, and the standalone
 * behaviour is the baseline the rest is measured against.
 */

const auth: AuthConfig = { username: 'admin', password: 'test-password', secret: 's'.repeat(32), ttlHours: 12, secureCookie: false };
const seller: SellerConfig = {
  name: '0815software GmbH',
  address: 'Musterstrasse 1',
  city: '1010 Wien',
  country: 'AT',
  vatId: 'ATU12345678',
  iban: 'AT611904300234573201',
  bic: 'BKAUATWW',
  email: 'office@example.at',
};

let db: Database.Database;
let app: Express;
let cookie: string;

function booking(over: Partial<BankBooking> = {}): BankBooking {
  return {
    key: 'AT61|BANKREF-1',
    amount_text: '120.00',
    amount_cents: 12000,
    currency: 'EUR',
    credit: true,
    reversal: false,
    booking_date: '2026-08-15',
    counterparty_name: 'Testkunde GmbH',
    counterparty_iban: 'AT022050302101023600',
    remittance: null,
    creditor_reference: null,
    end_to_end_id: null,
    batch_count: null,
    ...over,
  };
}

/**
 * A platform that answers with whatever `bookings` holds when it is asked.
 *
 * Mutable on purpose: a test needs the invoice NUMBER in the remittance, and
 * the number is only known after the invoice is finalized.
 */
const bookings: BankBooking[] = [];
function withBookings(): PlatformHooks {
  return { ...noopPlatform, async fetchBankBookings() { return [...bookings]; } };
}

async function login(): Promise<void> {
  const res = await request(app).post('/api/login').send({ username: 'admin', password: 'test-password' });
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
}

/** A sent invoice for 120.00 to "Testkunde GmbH". */
async function sentInvoice(): Promise<{ id: number; number: string }> {
  const customer = await request(app)
    .post('/api/customers')
    .set('Cookie', cookie)
    .send({ name: 'Testkunde GmbH', address: 'Weg 1', city: '1010 Wien', country: 'AT' });
  const invoice = await request(app)
    .post('/api/invoices')
    .set('Cookie', cookie)
    .send({
      customer_id: customer.body.id,
      lines: [{ description: 'Beratung', quantity: 1, unit_price_cents: 10000, vat_rate: 20 }],
    });
  const finalized = await request(app)
    .post(`/api/invoices/${invoice.body.id}/finalize`)
    .set('Cookie', cookie)
    .send({ issue_date: '2026-08-01' });
  return { id: finalized.body.id as number, number: finalized.body.number as string };
}

async function build(platform: PlatformHooks = noopPlatform): Promise<void> {
  bookings.length = 0;
  db = openDb(':memory:');
  app = createApp({ db, auth, seller, platform });
  await login();
}

describe('with no bank connection at all', () => {
  beforeEach(async () => {
    await build();
  });

  it('records a payment by hand, exactly as it always did', async () => {
    const invoice = await sentInvoice();
    const res = await request(app)
      .post(`/api/invoices/${invoice.id}/payments`)
      .set('Cookie', cookie)
      .send({ amount_cents: 12000, date: '2026-08-15' });
    expect(res.status).toBe(201);
    expect(res.body.paid_cents).toBe(12000);
  });

  it('says plainly that suggestions need a bank, rather than answering nothing', async () => {
    const res = await request(app).get('/api/receivables/suggestions').set('Cookie', cookie);
    // 501, not an empty list: "nobody paid you" is a worse lie than an error.
    expect(res.status).toBe(501);
    expect(res.body.error).toMatch(/BANKING_URL is unset/);
    expect(res.body.error).toMatch(/record incoming payments on the invoice itself/);
  });
});

describe('with a bank connection', () => {
  it('proposes the invoice the payer quoted', async () => {
    await build(withBookings());
    const invoice = await sentInvoice();
    bookings.push(booking({ remittance: `Rechnung ${invoice.number}` }));

    const res = await request(app).get('/api/receivables/suggestions').set('Cookie', cookie).expect(200);
    expect(res.body.proposals).toHaveLength(1);
    expect(res.body.proposals[0]).toMatchObject({
      reason: 'remittance_number',
      amount_cents: 12000,
      settles_invoice: true,
      invoice: { id: invoice.id, number: invoice.number },
    });
  });

  it('records nothing until a human confirms', async () => {
    await build(withBookings());
    const invoice = await sentInvoice();
    bookings.push(booking({ remittance: `Rechnung ${invoice.number}` }));
    await request(app).get('/api/receivables/suggestions').set('Cookie', cookie).expect(200);

    // Asking for suggestions must not move money.
    const before = await request(app).get(`/api/invoices/${invoice.id}`).set('Cookie', cookie);
    expect(before.body.paid_cents).toBe(0);

    await request(app)
      .post('/api/receivables/apply')
      .set('Cookie', cookie)
      .send({ applications: [{ booking_key: 'AT61|BANKREF-1', invoice_id: invoice.id, amount_cents: 12000, date: '2026-08-15' }] })
      .expect(200);

    const after = await request(app).get(`/api/invoices/${invoice.id}`).set('Cookie', cookie);
    expect(after.body.paid_cents).toBe(12000);
  });

  /**
   * The invariant the UNIQUE index on `payments.external_ref` exists for.
   *
   * Bookings are fetched again on every visit to the screen, a statement can be
   * re-read from stored bytes, and a bank re-offers a file whose receipt it
   * never saw. One arrival must still become one payment.
   */
  it('cannot record the same arrival twice', async () => {
    await build(withBookings());
    const invoice = await sentInvoice();
    bookings.push(booking({ remittance: `Rechnung ${invoice.number}` }));
    const application = { booking_key: 'AT61|BANKREF-1', invoice_id: invoice.id, amount_cents: 12000, date: '2026-08-15' };

    await request(app).post('/api/receivables/apply').set('Cookie', cookie).send({ applications: [application] }).expect(200);
    const second = await request(app)
      .post('/api/receivables/apply')
      .set('Cookie', cookie)
      .send({ applications: [application] })
      .expect(200);

    // Reported, not thrown: confirming twice is a no-op, not a failure.
    expect(second.body.outcomes[0].status).toBe('already_applied');
    const detail = await request(app).get(`/api/invoices/${invoice.id}`).set('Cookie', cookie);
    expect(detail.body.paid_cents).toBe(12000);
  });

  it('stops proposing a booking once it has been recorded', async () => {
    await build(withBookings());
    const invoice = await sentInvoice();
    bookings.push(booking({ remittance: `Rechnung ${invoice.number}` }));
    await request(app)
      .post('/api/receivables/apply')
      .set('Cookie', cookie)
      .send({ applications: [{ booking_key: 'AT61|BANKREF-1', invoice_id: invoice.id, amount_cents: 12000, date: '2026-08-15' }] })
      .expect(200);

    const res = await request(app).get('/api/receivables/suggestions').set('Cookie', cookie).expect(200);
    expect(res.body.proposals).toEqual([]);
    expect(res.body.unmatched[0].why).toBe('already_applied');
  });

  it('reports what it could not place, which is the number that matters', async () => {
    await build(withBookings());
    await sentInvoice();
    bookings.push(booking({ key: 'A', amount_cents: 777, remittance: 'Spende' }), booking({ key: 'B', credit: false }));
    const res = await request(app).get('/api/receivables/suggestions').set('Cookie', cookie).expect(200);
    expect(res.body.proposals).toEqual([]);
    // A debit is not an operator's problem; an unplaceable credit is.
    expect(res.body.unmatched_count).toBe(1);
  });

  it('keeps going when one confirmation is refused, and says which', async () => {
    await build(withBookings());
    const invoice = await sentInvoice();
    bookings.push(booking());
    const res = await request(app)
      .post('/api/receivables/apply')
      .set('Cookie', cookie)
      .send({
        applications: [
          { booking_key: 'A', invoice_id: invoice.id, amount_cents: 5000, date: '2026-08-15' },
          // More than is open — refused, and the first must still stand.
          { booking_key: 'B', invoice_id: invoice.id, amount_cents: 999999, date: '2026-08-15' },
        ],
      })
      .expect(200);

    expect(res.body.outcomes[0].status).toBe('recorded');
    expect(res.body.outcomes[1].status).toBe('refused');
    expect(res.body.outcomes[1].message).toMatch(/exceeds the open amount/);
    const detail = await request(app).get(`/api/invoices/${invoice.id}`).set('Cookie', cookie);
    expect(detail.body.paid_cents).toBe(5000);
  });

  it('refuses a malformed confirmation before touching anything', async () => {
    await build(withBookings());
    const res = await request(app)
      .post('/api/receivables/apply')
      .set('Cookie', cookie)
      .send({ applications: [{ invoice_id: 'x', amount_cents: -1 }] });
    expect(res.status).toBe(422);
    expect(res.body.details.map((d: { field: string }) => d.field)).toEqual([
      'applications[0].booking_key',
      'applications[0].invoice_id',
      'applications[0].amount_cents',
    ]);
  });

  it('needs a session, like every other route here', async () => {
    await build(withBookings());
    await request(app).get('/api/receivables/suggestions').expect(401);
    await request(app).post('/api/receivables/apply').send({ applications: [] }).expect(401);
  });
});
