import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import { buildPlatform, noopPlatform, type AuditInfo } from '../server/platform.js';
import type { SellerConfig } from '../server/config.js';

/**
 * What the admin configures (server/settings.ts) and the stock side of a
 * delivery note (server/stock.ts), against a stand-in MOD-03 speaking its
 * goods-issue contract over real HTTP.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's', ttlHours: 1, secureCookie: false };
const TOKEN = 'machine-token';
const ENV_SELLER: SellerConfig = { name: 'Env GmbH', addressLines: ['Envgasse 1', '1010 Wien'], vatId: 'ATU11111111' };
const as = (access: AccessLevel, actor = `${access}@example`) => `${COOKIE_NAME}=${createToken(auth, actor, Date.now(), access)}`;

/** A stand-in MOD-03: stock per SKU in MUC-1, goods issues idempotent on reference. */
let server: Server | null;
let inventoryUrl: string;
let stock: Record<string, number>;
let issues: { reference: string; actor: string; warehouse_code: string; lines: { sku: string; quantity: number }[]; token: unknown }[];
/** What the stand-in holds reserved, per order: the last PUT, or null once released. */
let reservations: Record<string, { actor: string; lines: { sku: string; quantity: number }[] } | null>;
let inventoryDown: boolean;

function startInventory(): Promise<void> {
  server = createServer((req, res) => {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (inventoryDown) return reply(503, { error: 'Inventory is down' });
    if (req.headers['x-service-token'] !== TOKEN) return reply(401, { error: 'Service token required' });
    if ((req.method === 'PUT' && req.url === '/api/reservations') || (req.method === 'POST' && req.url === '/api/reservations/release')) {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        if (req.method === 'POST') {
          reservations[body.reference] = null;
          return reply(200, { released: 1 });
        }
        reservations[body.reference] = { actor: body.actor, lines: body.lines };
        const short = body.lines
          .filter((l: { sku: string; quantity: number }) => (stock[l.sku] ?? 0) < l.quantity)
          .map((l: { sku: string; quantity: number }) => ({ sku: l.sku, open: l.quantity, available: stock[l.sku] ?? 0, missing: l.quantity - (stock[l.sku] ?? 0) }));
        reply(200, { reservations: [], short });
      });
      return;
    }
    if (req.method === 'GET' && req.url === '/api/goods-issues/warehouses') {
      return reply(200, { warehouses: [{ code: 'MUC-1', name: 'Main' }, { code: 'HH-1', name: 'Hamburg' }] });
    }
    if (req.method === 'POST' && req.url === '/api/goods-issues') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        if (issues.some((i) => i.reference === body.reference)) return reply(200, { replayed: true });
        const short = body.lines.find((l: { sku: string; quantity: number }) => (stock[l.sku] ?? 0) < l.quantity);
        if (short) {
          return reply(422, { error: 'The goods cannot be issued', details: [{ field: 'lines[0].quantity', message: `Only ${stock[short.sku] ?? 0} of ${short.sku} in MUC-1, not ${short.quantity}` }] });
        }
        for (const l of body.lines) stock[l.sku]! -= l.quantity;
        issues.push({ ...body, token: req.headers['x-service-token'] });
        reply(201, { replayed: false });
      });
      return;
    }
    reply(404, { error: 'not found' });
  });
  return new Promise((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
}

let db: Database.Database;
let app: Express;
let audits: AuditInfo[];

function boot(url: string | undefined): void {
  db = openDb(':memory:');
  audits = [];
  app = createApp({
    db,
    auth,
    seller: ENV_SELLER,
    platform: { ...buildPlatform({ inventoryUrl: url, serviceToken: TOKEN }), audit: async (info) => void audits.push(info) },
  });
}

beforeEach(async () => {
  stock = { 'CH-100': 20, 'DK-200': 1 };
  issues = [];
  reservations = {};
  inventoryDown = false;
  await startInventory();
  inventoryUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  boot(inventoryUrl);
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

const ORDER = {
  customer: { name: 'Kunde GmbH', address: 'Hauptplatz 1\n8010 Graz' },
  lines: [
    { sku: 'CH-100', description: 'Bürostuhl', quantity: 12, unit_price_cents: 24900, vat_rate: 20 },
    { description: 'Montage', quantity: 1, unit_price_cents: 45000, vat_rate: 20 },
    { sku: 'DK-200', description: 'Schreibtisch', quantity: 2, unit_price_cents: 38900, vat_rate: 20 },
  ],
};

async function order() {
  return (await request(app).post('/api/orders').set('Cookie', as('edit')).send(ORDER).expect(201)).body;
}

const enable = (warehouse = 'MUC-1') =>
  request(app).put('/api/settings').set('Cookie', as('manage', 'boss@example')).send({ stock_booking: true, stock_warehouse: warehouse });

describe('settings, set by the admin instead of only the environment', () => {
  it('falls back to the environment field by field, and the PDFs follow what is set', async () => {
    const before = (await request(app).get('/api/settings').set('Cookie', as('view')).expect(200)).body;
    expect(before).toMatchObject({
      seller: { name: 'Env GmbH', vat_id: 'ATU11111111' },
      seller_source: { name: 'env', address_lines: 'env', vat_id: 'env' },
      inventory: { configured: true, warehouses: [{ code: 'MUC-1', name: 'Main' }, { code: 'HH-1', name: 'Hamburg' }], error: null },
      updated_by: null,
    });

    await request(app).put('/api/settings').set('Cookie', as('edit')).send({ seller_name: 'Neu GmbH' }).expect(403);
    const saved = await request(app)
      .put('/api/settings')
      .set('Cookie', as('manage', 'boss@example'))
      .send({ seller_name: 'Neu GmbH', seller_address: ['Neugasse 2', '', '8010 Graz'], seller_vat_id: 'atu 22222222' })
      .expect(200);
    expect(saved.body).toMatchObject({
      seller: { name: 'Neu GmbH', address_lines: ['Neugasse 2', '8010 Graz'], vat_id: 'ATU22222222' },
      seller_source: { name: 'settings', address_lines: 'settings', vat_id: 'settings' },
      updated_by: 'boss@example',
    });
    expect(audits).toEqual([expect.objectContaining({ actor: 'boss@example', action: 'settings.changed', metadata: { fields: ['seller_name', 'seller_address', 'seller_vat_id'] } })]);

    const o = await order();
    const pdf = (await request(app).get(`/api/orders/${o.id}/pdf`).set('Cookie', as('view')).buffer(true).expect(200)).body as Buffer;
    expect(pdf.toString('latin1')).toContain('NEU GMBH');
    expect(pdf.toString('latin1')).not.toContain('ENV GMBH');

    // Clearing a field restores the environment value, not a blank letterhead.
    const cleared = await request(app).put('/api/settings').set('Cookie', as('manage')).send({ seller_name: '' }).expect(200);
    expect(cleared.body.seller).toMatchObject({ name: 'Env GmbH', vat_id: 'ATU11111111' });
  });

  it('refuses nonsense, a booking without a warehouse, and a warehouse MOD-03 does not have', async () => {
    const bad = await request(app).put('/api/settings').set('Cookie', as('manage')).send({ seller_vat_id: '12345', stock_booking: true }).expect(422);
    expect(bad.body.details.map((d: { field: string }) => d.field)).toEqual(['seller_vat_id', 'stock_warehouse']);
    const unknown = await enable('XX-9').expect(422);
    expect(unknown.body.details[0].message).toMatch(/no warehouse XX-9 — one of: MUC-1, HH-1/);
    await enable('HH-1').expect(200);
  });

  it('says when MOD-03 cannot be asked, rather than saving a warehouse blind', async () => {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    expect((await enable().expect(502)).body.error).toMatch(/cannot be checked/);
    const res = (await request(app).get('/api/settings').set('Cookie', as('view')).expect(200)).body;
    expect(res.inventory).toMatchObject({ configured: true, warehouses: null, error: expect.stringMatching(/unreachable/) });
  });
});

describe('a delivery note books its stock in MOD-03', () => {
  it('issues the article lines (not the services) from the warehouse set, naming the person', async () => {
    await enable().expect(200);
    const o = await order();
    const note = await request(app)
      .post(`/api/orders/${o.id}/delivery-notes`)
      .set('Cookie', as('edit', 'lager@example'))
      .send({ lines: [{ order_line_id: o.lines[0].id, quantity: 8 }, { order_line_id: o.lines[1].id, quantity: 1 }] })
      .expect(201);
    expect(note.body).toMatchObject({ stock_status: 'booked', stock_warehouse: 'MUC-1', stock_error: null });
    expect(issues).toEqual([
      { source: 'mod-17-orders-delivery', reference: note.body.number, order_reference: o.number, warehouse_code: 'MUC-1', actor: 'lager@example', lines: [{ sku: 'CH-100', quantity: 8 }], token: TOKEN },
    ]);
    expect(stock['CH-100']).toBe(12);
  });

  it('short stock: the delivery note stands, the failure says why, and a retry books it once', async () => {
    await enable().expect(200);
    const o = await order();
    const note = (await request(app).post(`/api/orders/${o.id}/delivery-notes`).set('Cookie', as('edit')).send({ lines: [{ order_line_id: o.lines[2].id, quantity: 2 }] }).expect(201)).body;
    expect(note).toMatchObject({ stock_status: 'failed', stock_error: 'The goods cannot be issued: Only 1 of DK-200 in MUC-1, not 2' });
    expect((await request(app).get(`/api/orders/${o.id}`).set('Cookie', as('view'))).body.status).toBe('partially_delivered');

    stock['DK-200'] = 5;
    await request(app).post(`/api/delivery-notes/${note.id}/book-stock`).set('Cookie', as('view')).expect(403);
    const retried = await request(app).post(`/api/delivery-notes/${note.id}/book-stock`).set('Cookie', as('edit')).expect(200);
    expect(retried.body).toMatchObject({ stock_status: 'booked', stock_error: null });
    await request(app).post(`/api/delivery-notes/${note.id}/book-stock`).set('Cookie', as('edit')).expect(200);
    expect(issues).toHaveLength(1);
    expect(stock['DK-200']).toBe(3);
    const events = (await request(app).get(`/api/orders/${o.id}`).set('Cookie', as('view'))).body.events.map((e: { type: string }) => e.type);
    expect(events).toEqual(['confirmed', 'delivered', 'stock_failed', 'stock_booked']);
  });

  it('books nothing while booking is off; a person can still book one by hand', async () => {
    const o = await order();
    const note = (await request(app).post(`/api/orders/${o.id}/delivery-notes`).set('Cookie', as('edit')).send({ lines: [{ order_line_id: o.lines[0].id, quantity: 1 }] }).expect(201)).body;
    expect(note.stock_status).toBeNull();
    expect(issues).toEqual([]);
    // Without a warehouse set, booking by hand fails visibly instead of guessing one.
    const manual = await request(app).post(`/api/delivery-notes/${note.id}/book-stock`).set('Cookie', as('edit')).expect(200);
    expect(manual.body).toMatchObject({ stock_status: 'failed', stock_error: 'No warehouse is set in Settings' });
  });

  it('an article number set after confirmation reaches the deliveries from then on', async () => {
    await enable().expect(200);
    const o = await order();
    const service = o.lines[1];
    await request(app).put(`/api/orders/${o.id}/lines/${service.id}/sku`).set('Cookie', as('view')).send({ sku: 'X' }).expect(403);
    const mapped = await request(app).put(`/api/orders/${o.id}/lines/${service.id}/sku`).set('Cookie', as('edit')).send({ sku: 'CH-100' }).expect(200);
    expect(mapped.body.lines[1].sku).toBe('CH-100');
    expect(mapped.body.events.at(-1)).toMatchObject({ type: 'sku', detail: 'line 2: — → CH-100', actor: 'edit@example' });
    await request(app).put(`/api/orders/${o.id}/lines/999/sku`).set('Cookie', as('edit')).send({ sku: 'X' }).expect(404);
    await request(app).post(`/api/orders/${o.id}/delivery-notes`).set('Cookie', as('edit')).send({ lines: [{ order_line_id: service.id, quantity: 1 }] }).expect(201);
    expect(issues[0]!.lines).toEqual([{ sku: 'CH-100', quantity: 1 }]);
  });
});

describe('without an inventory', () => {
  it('delivers as before and says plainly that stock cannot be booked', async () => {
    boot(undefined);
    await request(app).put('/api/settings').set('Cookie', as('manage')).send({ stock_booking: true, stock_warehouse: 'MUC-1' }).expect(200);
    const o = await order();
    const note = (await request(app).post(`/api/orders/${o.id}/delivery-notes`).set('Cookie', as('edit')).send({ lines: [{ order_line_id: o.lines[0].id, quantity: 1 }] }).expect(201)).body;
    expect(note.stock_status).toBeNull();
    await request(app).post(`/api/delivery-notes/${note.id}/book-stock`).set('Cookie', as('edit')).expect(501);
    expect((await request(app).get('/api/settings').set('Cookie', as('view'))).body.inventory).toEqual({ configured: false, warehouses: null, error: null });
    const standalone = createApp({ db, auth, platform: noopPlatform });
    await request(standalone).get('/api/settings').set('Cookie', as('view')).expect(200);
  });
});

describe('an order reserves its stock in MOD-03', () => {
  const enableReserving = () =>
    request(app).put('/api/settings').set('Cookie', as('manage')).send({ stock_reservation: true, stock_warehouse: 'MUC-1' }).expect(200);

  it('reserves the ordered article quantities on confirmation, naming the person', async () => {
    await enableReserving();
    const o = (await request(app).post('/api/orders').set('Cookie', as('edit', 'vertrieb@example')).send(ORDER).expect(201)).body;
    expect(reservations[o.number]).toEqual({ actor: 'vertrieb@example', lines: [{ sku: 'CH-100', quantity: 12 }, { sku: 'DK-200', quantity: 2 }] });
    // DK-200: 1 in stock, 2 ordered — the order stands, the shortage is named.
    expect(o.reservation).toMatchObject({ status: 'short', note: 'missing 1 × DK-200 in MUC-1' });
    expect(o.events.map((e: { type: string }) => e.type)).toEqual(['confirmed', 'stock_short']);
  });

  it('reserves again when an article number changes, and releases on cancellation', async () => {
    await enableReserving();
    const o = (await request(app).post('/api/orders').set('Cookie', as('edit')).send({ ...ORDER, lines: [ORDER.lines[1]] }).expect(201)).body;
    // A service only: nothing to reserve, nothing recorded.
    expect(o.reservation).toBeNull();
    expect(reservations).toEqual({});
    const mapped = (await request(app).put(`/api/orders/${o.id}/lines/${o.lines[0].id}/sku`).set('Cookie', as('edit')).send({ sku: 'CH-100' }).expect(200)).body;
    expect(mapped.reservation).toMatchObject({ status: 'reserved', note: 'in MUC-1' });
    expect(reservations[o.number]!.lines).toEqual([{ sku: 'CH-100', quantity: 1 }]);
    const cancelled = (await request(app).post(`/api/orders/${o.id}/cancel`).set('Cookie', as('manage', 'chef@example')).send({ reason: 'storniert' }).expect(200)).body;
    expect(cancelled.reservation).toMatchObject({ status: 'released' });
    expect(reservations[o.number]).toBeNull();
    expect(cancelled.events.at(-1)).toMatchObject({ type: 'stock_released', actor: 'chef@example' });
  });

  it('MOD-03 down: the order is confirmed, the failure is on it, and a retry reserves', async () => {
    await enableReserving();
    inventoryDown = true;
    const o = (await request(app).post('/api/orders').set('Cookie', as('edit')).send(ORDER).expect(201)).body;
    expect(o.reservation).toMatchObject({ status: 'failed', note: 'Inventory is down' });
    inventoryDown = false;
    stock['DK-200'] = 5;
    await request(app).post(`/api/orders/${o.id}/reserve-stock`).set('Cookie', as('view')).expect(403);
    const retried = (await request(app).post(`/api/orders/${o.id}/reserve-stock`).set('Cookie', as('edit')).expect(200)).body;
    expect(retried.reservation).toMatchObject({ status: 'reserved' });
  });

  it('reserves nothing while switched off; deliveries name their order so MOD-03 draws its reservation down', async () => {
    await request(app).put('/api/settings').set('Cookie', as('manage')).send({ stock_booking: true, stock_warehouse: 'MUC-1' }).expect(200);
    const o = await order();
    expect(o.reservation).toBeNull();
    expect(reservations).toEqual({});
    await request(app).post(`/api/orders/${o.id}/delivery-notes`).set('Cookie', as('edit')).send({ lines: [{ order_line_id: o.lines[0].id, quantity: 2 }] }).expect(201);
    expect(issues[0]).toMatchObject({ order_reference: o.number });
  });
});
