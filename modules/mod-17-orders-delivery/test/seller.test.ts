import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import { buildPlatform, noopPlatform } from '../server/platform.js';
import { PlatformSeller } from '../server/seller.js';
import type { SellerConfig } from '../server/config.js';

/**
 * The letterhead from PS-11's `self` party (server/seller.ts): below what the
 * admin sets, above the environment, kept through an outage — and no call at
 * all when PS-11 is not wired.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's', ttlHours: 1, secureCookie: false };
const ENV: SellerConfig = { name: 'Env GmbH', addressLines: ['Envgasse 1', '1010 Wien'], vatId: 'ATU11111111' };
const view = `${COOKIE_NAME}=${createToken(auth, 'v@example', Date.now(), 'view')}`;
const manage = `${COOKIE_NAME}=${createToken(auth, 'boss@example', Date.now(), 'manage')}`;

/** A stand-in PS-11 answering GET /api/self, counting the calls. */
let server: Server | null;
let customersUrl: string;
let self: Record<string, unknown> | null;
let calls: number;

beforeEach(async () => {
  self = { id: 1, name: 'Stack AG', vat_id: 'ATU33333333', address_lines: ['Platz 3', '4020 Linz'], email: null, contact_person: null };
  calls = 0;
  server = createServer((req, res) => {
    calls += 1;
    res.writeHead(req.url === '/api/self' ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ party: self }));
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  customersUrl = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
});

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = null;
});

async function settingsOf(platformSeller: PlatformSeller | undefined) {
  const db = openDb(':memory:');
  const app = createApp({ db, auth, seller: ENV, platformSeller });
  return { app, get: async () => (await request(app).get('/api/settings').set('Cookie', view).expect(200)).body };
}

describe('the letterhead from PS-11', () => {
  it('PS-11 beats the environment, and Settings beat PS-11, field by field', async () => {
    const platform = buildPlatform({ customersUrl });
    const seller = new PlatformSeller();
    expect(await seller.refresh(() => platform.fetchSelf())).toBe(true);
    const { app, get } = await settingsOf(seller);
    expect(await get()).toMatchObject({
      seller: { name: 'Stack AG', address_lines: ['Platz 3', '4020 Linz'], vat_id: 'ATU33333333' },
      seller_source: { name: 'ps-11', address_lines: 'ps-11', vat_id: 'ps-11' },
    });
    await request(app).put('/api/settings').set('Cookie', manage).send({ seller_name: 'Filiale Graz' }).expect(200);
    expect(await get()).toMatchObject({ seller: { name: 'Filiale Graz', vat_id: 'ATU33333333' }, seller_source: { name: 'settings', vat_id: 'ps-11' } });
    const order = await request(app)
      .post('/api/orders')
      .set('Cookie', `${COOKIE_NAME}=${createToken(auth, 'e@example', Date.now(), 'edit')}`)
      .send({ customer: { name: 'K' }, lines: [{ description: 'x', quantity: 1, unit_price_cents: 100, vat_rate: 20 }] })
      .expect(201);
    const pdf = ((await request(app).get(`/api/orders/${order.body.id}/pdf`).set('Cookie', view).buffer(true).expect(200)).body as Buffer).toString('latin1');
    expect(pdf).toContain('Platz 3');
    expect(pdf).toContain('ATU33333333');
  });

  it('a blank field in PS-11 falls through to the environment instead of blanking it', async () => {
    self = { ...self!, vat_id: null, address_lines: [] };
    const seller = new PlatformSeller();
    await seller.refresh(() => buildPlatform({ customersUrl }).fetchSelf());
    const { get } = await settingsOf(seller);
    expect(await get()).toMatchObject({
      seller: { name: 'Stack AG', address_lines: ['Envgasse 1', '1010 Wien'], vat_id: 'ATU11111111' },
      seller_source: { name: 'ps-11', address_lines: 'env', vat_id: 'env' },
    });
  });

  it('keeps the last party through an outage; no party at all means the environment', async () => {
    const platform = buildPlatform({ customersUrl });
    const seller = new PlatformSeller();
    await seller.refresh(() => platform.fetchSelf());
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    expect(await seller.refresh(() => platform.fetchSelf())).toBe(true);
    expect(seller.current?.name).toBe('Stack AG');
    // PS-11 answering "no self party" is an answer, not an outage.
    expect(await seller.refresh(async () => null)).toBe(false);
    const { get } = await settingsOf(seller);
    expect((await get()).seller_source).toEqual({ name: 'env', address_lines: 'env', vat_id: 'env' });
  });
});

describe('standalone: the module needs no other module or service', () => {
  it('without CUSTOMERS_URL no call is made and the environment stands', async () => {
    const seller = new PlatformSeller();
    expect(await seller.refresh(() => buildPlatform({}).fetchSelf())).toBe(false);
    expect(await seller.refresh(() => noopPlatform.fetchSelf())).toBe(false);
    expect(calls).toBe(0);
    const { get } = await settingsOf(undefined);
    expect(await get()).toMatchObject({ seller: { name: 'Env GmbH' }, inventory: { configured: false } });
  });

  it('every peer-dependent action answers 501 and says which variable to set', async () => {
    const db = openDb(':memory:');
    const app = createApp({ db, auth });
    const edit = `${COOKIE_NAME}=${createToken(auth, 'e@example', Date.now(), 'edit')}`;
    const imported = await request(app).post('/api/orders/import-offer').set('Cookie', edit).send({ offer_number: 'AN-1' }).expect(501);
    expect(imported.body.error).toMatch(/OFFERS_URL/);
    const order = await request(app)
      .post('/api/orders')
      .set('Cookie', edit)
      .send({ customer: { name: 'K' }, lines: [{ sku: 'X-1', description: 'x', quantity: 2, unit_price_cents: 100, vat_rate: 20 }] })
      .expect(201);
    const note = await request(app)
      .post(`/api/orders/${order.body.id}/delivery-notes`)
      .set('Cookie', edit)
      .send({ lines: [{ order_line_id: order.body.lines[0].id, quantity: 2 }] })
      .expect(201);
    expect(note.body.stock_status).toBeNull();
    expect((await request(app).post(`/api/delivery-notes/${note.body.id}/book-stock`).set('Cookie', edit).expect(501)).body.error).toMatch(/INVENTORY_URL/);
    // Billing comes from MOD-04, which calls in; without a machine token those routes stay shut.
    await request(app).get(`/api/delivery-notes/${note.body.number}/transfer`).set('X-Service-Token', 'x').expect(401);
  });
});
