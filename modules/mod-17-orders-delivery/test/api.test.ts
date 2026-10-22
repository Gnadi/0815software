import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import { moduleSummary } from '../server/summary.js';
import { noopPlatform, OfferFetchError, type AuditInfo } from '../server/platform.js';
import { validateSummary } from '../shared/summary.js';
import { TRANSFER_VERSION, transferLineNet, transferTotals, validateTransfer, type DocumentTransfer } from '../shared/transfer.js';
import { addDaysIso } from '../server/dates.js';
import { todayIso } from '../server/orders.js';

/**
 * Orders and delivery notes, end to end through the real app: what the domain
 * guarantees (delivery never past the order, numbers gapless, status derived,
 * documents fixed), the two hand-overs (offer in, delivery out), and who may
 * do what on the real routes.
 */

const auth: AuthConfig = { username: 'admin', password: 'test-password', secret: 'test-secret', ttlHours: 1, secureCookie: false };
const TOKEN = 'machine-token';
const today = todayIso();

let db: Database.Database;
let app: Express;
let offers: Record<string, unknown>;
let audits: AuditInfo[];

const as = (access: AccessLevel, actor = 'ada@example') => `${COOKIE_NAME}=${createToken(auth, actor, Date.now(), access)}`;

beforeEach(() => {
  db = openDb(':memory:');
  offers = {};
  audits = [];
  app = createApp({
    db,
    auth,
    serviceToken: TOKEN,
    platform: {
      ...noopPlatform,
      audit: async (info) => void audits.push(info),
      fetchOffer: async (number) => {
        if (!(number in offers)) throw new OfferFetchError(404, 'Offer not found');
        return offers[number];
      },
    },
  });
});

const ORDER = {
  customer: { name: 'Kunde GmbH', contact_person: 'Maria Huber', email: 'einkauf@kunde.example', vat_id: 'ATU12345678', address: 'Hauptplatz 1\n8010 Graz' },
  customer_reference: 'PO-4711',
  lines: [
    { description: 'Bürostuhl', quantity: 12, unit_price_cents: 24900, discount_percent: 5, vat_rate: 20 },
    { description: 'Montage', quantity: 1.5, unit_price_cents: 9000, discount_percent: 0, vat_rate: 20 },
  ],
};

async function order(values: Record<string, unknown> = ORDER) {
  return (await request(app).post('/api/orders').set('Cookie', as('edit')).send(values).expect(201)).body;
}

const deliver = (id: number, lines: { order_line_id: number; quantity: number }[], extra: Record<string, unknown> = {}, access: AccessLevel = 'edit') =>
  request(app).post(`/api/orders/${id}/delivery-notes`).set('Cookie', as(access, 'lager@example')).send({ lines, ...extra });

/** An accepted offer as MOD-13 exports it. */
function offerTransfer(reference = 'ANG-2026-0007'): DocumentTransfer {
  const lines = [
    { description: 'Schreibtisch', quantity: 4, unit_price_cents: 38900, discount_percent: 10, vat_rate: 20, net_cents: 0 },
    { description: 'Lieferung', quantity: 1, unit_price_cents: 4500, discount_percent: 0, vat_rate: 20, net_cents: 0 },
  ].map((l) => ({ ...l, net_cents: transferLineNet(l) }));
  return {
    transfer_version: TRANSFER_VERSION,
    origin: { kind: 'offer', module: 'mod-13-offers', reference, issued_at: '2026-10-01', accepted_at: `${addDaysIso(today, -3)}T09:00:00Z` },
    currency: 'EUR',
    customer: { name: 'Beispiel AG', contact_person: null, email: 'office@beispiel.example', vat_id: null, address_lines: ['Ring 5', '1010 Wien'], party_id: 42, source: 'mod-13-offers', external_id: '7' },
    lines,
    totals: transferTotals(lines),
    note: 'Wie besprochen',
  };
}

describe('an order is confirmed as it is written', () => {
  it('gets a gapless number per year and keeps its lines and money exactly', async () => {
    const first = await order();
    const second = await order();
    const year = today.slice(0, 4);
    expect([first.number, second.number]).toEqual([`AB-${year}-0001`, `AB-${year}-0002`]);
    // 12 × 249.00 − 5 % = 2838.60; 1.5 × 90.00 = 135.00; VAT 20 % on 2973.60.
    expect(first.lines.map((l: { net_cents: number }) => l.net_cents)).toEqual([283860, 13500]);
    expect(first.totals).toEqual({ net_cents: 297360, vat_cents: 59472, gross_cents: 356832 });
    expect(first).toMatchObject({ status: 'open', created_by: 'ada@example', customer: { address_lines: ['Hauptplatz 1', '8010 Graz'] } });
    // No route edits an order.
    await request(app).put(`/api/orders/${first.id}`).set('Cookie', as('manage')).send(ORDER).expect(404);
  });

  it('refuses a bad order with every field error at once, and consumes no number', async () => {
    const res = await request(app)
      .post('/api/orders')
      .set('Cookie', as('edit'))
      .send({ customer: { name: '' }, order_date: addDaysIso(today, 1), lines: [{ description: '', quantity: 0.0001, unit_price_cents: -1, vat_rate: 21 }] })
      .expect(422);
    expect(res.body.details.map((d: { field: string }) => d.field)).toEqual([
      'customer.name',
      'order_date',
      'lines[0].description',
      'lines[0].quantity',
      'lines[0].unit_price_cents',
      'lines[0].vat_rate',
    ]);
    expect((await order()).number).toBe(`AB-${today.slice(0, 4)}-0001`);
  });
});

describe('delivering, in as many parts as it takes', () => {
  it('derives delivered, open and the status from the delivery notes', async () => {
    const o = await order();
    const [chairs, assembly] = o.lines;
    const first = await deliver(o.id, [{ order_line_id: chairs.id, quantity: 8 }], { note: 'Teil 1' }).expect(201);
    expect(first.body).toMatchObject({ number: `LS-${today.slice(0, 4)}-0001`, order_number: o.number, created_by: 'lager@example', invoiced_at: null });

    let detail = (await request(app).get(`/api/orders/${o.id}`).set('Cookie', as('view'))).body;
    expect(detail.status).toBe('partially_delivered');
    expect(detail.lines.map((l: { delivered_quantity: number; remaining_quantity: number }) => [l.delivered_quantity, l.remaining_quantity])).toEqual([[8, 4], [0, 1.5]]);

    // Fractions add up exactly: 0.7 + 0.8 of 1.5 is all of it.
    await deliver(o.id, [{ order_line_id: assembly.id, quantity: 0.7 }]).expect(201);
    await deliver(o.id, [{ order_line_id: chairs.id, quantity: 4 }, { order_line_id: assembly.id, quantity: 0.8 }]).expect(201);
    detail = (await request(app).get(`/api/orders/${o.id}`).set('Cookie', as('view'))).body;
    expect(detail.status).toBe('delivered');
    expect(detail.delivery_notes.map((n: { number: string }) => n.number.slice(-4))).toEqual(['0001', '0002', '0003']);
    expect(detail.events.map((e: { type: string }) => e.type)).toEqual(['confirmed', 'delivered', 'delivered', 'delivered']);
  });

  it('never delivers more than is open, a line twice, or a line of another order', async () => {
    const o = await order();
    const other = await order();
    const [chairs] = o.lines;
    await deliver(o.id, [{ order_line_id: chairs.id, quantity: 10 }]).expect(201);
    const over = await deliver(o.id, [{ order_line_id: chairs.id, quantity: 3 }]).expect(422);
    expect(over.body.details[0].message).toMatch(/2 left to deliver, not 3/);
    const twice = await deliver(o.id, [{ order_line_id: chairs.id, quantity: 1 }, { order_line_id: chairs.id, quantity: 1 }]).expect(422);
    expect(twice.body.details.map((d: { message: string }) => d.message)).toContain('Line 1 appears twice');
    await deliver(o.id, [{ order_line_id: other.lines[0].id, quantity: 1 }]).expect(422);
    // A refused delivery consumes no number.
    expect((await deliver(o.id, [{ order_line_id: chairs.id, quantity: 2 }]).expect(201)).body.number).toBe(`LS-${today.slice(0, 4)}-0002`);
  });

  it('a delivery happened: not in the future, not before the order', async () => {
    const o = await order({ ...ORDER, order_date: addDaysIso(today, -3) });
    const line = { order_line_id: o.lines[0].id, quantity: 1 };
    expect((await deliver(o.id, [line], { delivered_on: addDaysIso(today, 1) }).expect(422)).body.details[0].field).toBe('delivered_on');
    expect((await deliver(o.id, [line], { delivered_on: addDaysIso(today, -4) }).expect(422)).body.details[0].field).toBe('delivered_on');
    await deliver(o.id, [line], { delivered_on: addDaysIso(today, -3) }).expect(201);
  });

  it('cancelling stops further deliveries but keeps the ones that happened', async () => {
    const o = await order();
    await deliver(o.id, [{ order_line_id: o.lines[0].id, quantity: 2 }]).expect(201);
    await request(app).post(`/api/orders/${o.id}/cancel`).set('Cookie', as('edit')).send({ reason: 'x' }).expect(403);
    await request(app).post(`/api/orders/${o.id}/cancel`).set('Cookie', as('manage')).send({}).expect(422);
    const cancelled = await request(app).post(`/api/orders/${o.id}/cancel`).set('Cookie', as('manage')).send({ reason: 'Kunde storniert Rest' }).expect(200);
    expect(cancelled.body).toMatchObject({ status: 'cancelled', cancel_reason: 'Kunde storniert Rest' });
    expect(cancelled.body.lines[0]).toMatchObject({ delivered_quantity: 2, remaining_quantity: 0 });
    expect(cancelled.body.delivery_notes).toHaveLength(1);
    await deliver(o.id, [{ order_line_id: o.lines[0].id, quantity: 1 }]).expect(409);
    await request(app).post(`/api/orders/${o.id}/cancel`).set('Cookie', as('manage')).send({ reason: 'again' }).expect(409);
  });

  it('a fully delivered order has nothing left to cancel', async () => {
    const o = await order({ ...ORDER, lines: [ORDER.lines[1]] });
    await deliver(o.id, [{ order_line_id: o.lines[0].id, quantity: 1.5 }]).expect(201);
    await request(app).post(`/api/orders/${o.id}/cancel`).set('Cookie', as('manage')).send({ reason: 'x' }).expect(409);
  });
});

describe('the hand-over in: an accepted offer becomes an order', () => {
  it('takes the offer over cent for cent, keeps the customer identity, and only once', async () => {
    offers['ANG-2026-0007'] = offerTransfer();
    const first = await request(app).post('/api/orders/import-offer').set('Cookie', as('edit')).send({ offer_number: 'ANG-2026-0007' }).expect(201);
    expect(first.body).toMatchObject({
      imported: true,
      order_date: addDaysIso(today, -3),
      source_reference: 'mod-13-offers:ANG-2026-0007',
      customer: { name: 'Beispiel AG', address_lines: ['Ring 5', '1010 Wien'] },
      totals: (offers['ANG-2026-0007'] as DocumentTransfer).totals,
    });
    const again = await request(app).post('/api/orders/import-offer').set('Cookie', as('edit')).send({ offer_number: 'ANG-2026-0007' }).expect(200);
    expect(again.body).toMatchObject({ id: first.body.id, imported: false });
    expect(audits.filter((a) => a.action === 'order.confirmed')).toHaveLength(1);
  });

  it('refuses anything but an offer, a transfer that does not add up, and an unknown offer', async () => {
    offers.DEAL = { ...offerTransfer('DEAL-3'), origin: { ...offerTransfer().origin, kind: 'deal', reference: 'DEAL-3' } };
    expect((await request(app).post('/api/orders/import-offer').set('Cookie', as('edit')).send({ offer_number: 'DEAL' }).expect(422)).body.error).toMatch(/is a deal/);
    const broken = offerTransfer('ANG-2026-0008');
    offers.BROKEN = { ...broken, totals: { ...broken.totals, gross_cents: broken.totals.gross_cents + 1 } };
    await request(app).post('/api/orders/import-offer').set('Cookie', as('edit')).send({ offer_number: 'BROKEN' }).expect(422);
    await request(app).post('/api/orders/import-offer').set('Cookie', as('edit')).send({ offer_number: 'NOPE' }).expect(404);
    await request(app).post('/api/orders/import-offer').set('Cookie', as('view')).send({ offer_number: 'NOPE' }).expect(403);
  });

  it('says plainly when no offer source is configured', async () => {
    const standalone = createApp({ db, auth });
    await request(standalone).post('/api/orders/import-offer').set('Cookie', as('edit')).send({ offer_number: 'ANG-1' }).expect(501);
  });
});

describe('the hand-over out: a delivery note is billed on its own', () => {
  it('exports what was delivered at the order prices, as a valid `delivery` transfer', async () => {
    offers['ANG-2026-0007'] = offerTransfer();
    const o = (await request(app).post('/api/orders/import-offer').set('Cookie', as('edit')).send({ offer_number: 'ANG-2026-0007' }).expect(201)).body;
    const note = (await deliver(o.id, [{ order_line_id: o.lines[0].id, quantity: 3 }]).expect(201)).body;

    await request(app).get(`/api/delivery-notes/${note.number}/transfer`).expect(401);
    const transfer = (await request(app).get(`/api/delivery-notes/${note.number}/transfer`).set('X-Service-Token', TOKEN).expect(200)).body as DocumentTransfer;
    expect(validateTransfer(transfer)).toEqual([]);
    expect(transfer.origin).toMatchObject({ kind: 'delivery', module: 'mod-17-orders-delivery', reference: note.number, issued_at: today });
    // 3 of 4 desks at 389.00 − 10 %: 1050.30 net.
    expect(transfer.lines).toEqual([{ description: 'Schreibtisch', quantity: 3, unit_price_cents: 38900, discount_percent: 10, vat_rate: 20, net_cents: 105030 }]);
    expect(transfer.totals).toEqual({ net_cents: 105030, vat_cents: 21006, gross_cents: 126036 });
    // The customer travels with the identity it came with.
    expect(transfer.customer).toMatchObject({ party_id: 42, source: 'mod-13-offers', external_id: '7' });
    expect(transfer.note).toContain(o.number);
  });

  it('records the billing hand-over once, naming the person', async () => {
    const o = await order();
    const note = (await deliver(o.id, [{ order_line_id: o.lines[0].id, quantity: 1 }]).expect(201)).body;
    await request(app).post(`/api/delivery-notes/${note.number}/invoiced`).send({ reference: 'x' }).expect(401);
    const first = await request(app)
      .post(`/api/delivery-notes/${note.number}/invoiced`)
      .set('X-Service-Token', TOKEN)
      .send({ reference: 'mod-04-invoice-billing:draft 12', actor: 'bea@example' })
      .expect(200);
    expect(first.body).toMatchObject({ invoice_reference: 'mod-04-invoice-billing:draft 12', invoiced_at: expect.any(String) });
    const again = await request(app).post(`/api/delivery-notes/${note.number}/invoiced`).set('X-Service-Token', TOKEN).send({ reference: 'other' }).expect(200);
    expect(again.body.invoice_reference).toBe('mod-04-invoice-billing:draft 12');
    const events = (await request(app).get(`/api/orders/${o.id}`).set('Cookie', as('view'))).body.events;
    expect(events.at(-1)).toMatchObject({ type: 'invoiced', actor: 'bea@example' });
    await request(app).get('/api/delivery-notes/LS-1999-0001/transfer').set('X-Service-Token', TOKEN).expect(404);
  });
});

describe('documents', () => {
  it('renders the confirmation and the delivery note — the latter without prices', async () => {
    const o = await order();
    const note = (await deliver(o.id, [{ order_line_id: o.lines[0].id, quantity: 5 }]).expect(201)).body;
    const confirmation = await request(app).get(`/api/orders/${o.id}/pdf`).set('Cookie', as('view')).buffer(true).expect(200);
    const text = (confirmation.body as Buffer).toString('latin1');
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('ORDER CONFIRMATION');
    expect(text).toContain('3.568,32');
    const delivery = await request(app).get(`/api/delivery-notes/${note.id}/pdf`).set('Cookie', as('view')).buffer(true).expect(200);
    const dn = (delivery.body as Buffer).toString('latin1');
    expect(dn).toContain('DELIVERY NOTE');
    expect(dn).toContain(note.number);
    expect(dn).not.toContain('249,00');
  });
});

describe('who may do what, on the real routes', () => {
  it('view reads and changes nothing', async () => {
    const o = await order();
    await request(app).get('/api/orders').set('Cookie', as('view')).expect(200);
    await request(app).post('/api/orders').set('Cookie', as('view')).send(ORDER).expect(403);
    await deliver(o.id, [{ order_line_id: o.lines[0].id, quantity: 1 }], {}, 'view').expect(403);
  });

  it('edit confirms and delivers; cancelling needs manage', async () => {
    const o = await order();
    await deliver(o.id, [{ order_line_id: o.lines[0].id, quantity: 1 }], {}, 'edit').expect(201);
    await request(app).post(`/api/orders/${o.id}/cancel`).set('Cookie', as('edit')).send({ reason: 'x' }).expect(403);
  });
});

describe('the shell summary', () => {
  it('satisfies the shell contract and counts what is to deliver and to bill', async () => {
    seed(db);
    const summary = moduleSummary(db);
    expect(validateSummary(summary)).toEqual([]);
    expect(summary.tiles.map((t) => [t.key, t.value])).toEqual([
      ['to_deliver', '2'],
      ['not_invoiced', '1'],
    ]);
  });
});
