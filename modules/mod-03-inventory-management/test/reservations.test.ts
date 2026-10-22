import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { stockLevel } from '../server/ledger.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';

/**
 * Reservations (server/reservations.ts): stock promised to an order. What is
 * still reserved is derived from what the order needs minus what its goods
 * issues took; a goods issue may not take what is reserved for other orders.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's', ttlHours: 1, secureCookie: false };
const TOKEN = 'machine-token';
const SOURCE = 'mod-17-orders-delivery';
let db: Database.Database;
let app: Express;

const view = `${COOKIE_NAME}=${createToken(auth, 'v@example', Date.now(), 'view')}`;
const sku = 'PK-6002';
const level = () =>
  stockLevel(
    db,
    (db.prepare('SELECT id FROM products WHERE sku = ?').get(sku) as { id: number }).id,
    (db.prepare("SELECT id FROM warehouses WHERE code = 'MUC-1'").get() as { id: number }).id,
  );

const reserve = (reference: string, quantity: number, extra: Record<string, unknown> = {}) =>
  request(app)
    .put('/api/reservations')
    .set('X-Service-Token', TOKEN)
    .send({ source: SOURCE, reference, warehouse_code: 'MUC-1', actor: 'vertrieb@example', lines: [{ sku, quantity }], ...extra });

const issue = (reference: string, quantity: number, orderReference: string | null) =>
  request(app)
    .post('/api/goods-issues')
    .set('X-Service-Token', TOKEN)
    .send({ source: SOURCE, reference, warehouse_code: 'MUC-1', actor: 'lager@example', order_reference: orderReference, lines: [{ sku, quantity }] });

const stockRow = async () =>
  ((await request(app).get('/api/stock').set('Cookie', view).expect(200)).body.rows as { sku: string; total: number; reserved: number; available: number }[]).find(
    (r) => r.sku === sku,
  )!;

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth, serviceToken: TOKEN });
});

describe('reserving', () => {
  it('reserves for an order, shows reserved and available, and a delivery draws it down', async () => {
    const onHand = level();
    const res = await reserve('AB-2026-0001', 5).expect(200);
    expect(res.body).toMatchObject({ reservations: [{ reference: 'AB-2026-0001', sku, quantity: 5, open: 5, actor: 'vertrieb@example' }], short: [] });
    expect(await stockRow()).toMatchObject({ total: onHand, reserved: 5, available: onHand - 5 });

    // The order's own delivery uses its reservation — still reserved goes down by itself.
    await issue('LS-2026-0001', 3, 'AB-2026-0001').expect(201);
    expect(await stockRow()).toMatchObject({ total: onHand - 3, reserved: 2, available: onHand - 5 });
    await issue('LS-2026-0002', 2, 'AB-2026-0001').expect(201);
    expect(await stockRow()).toMatchObject({ reserved: 0, available: onHand - 5 });
    expect((await request(app).get('/api/reservations').set('Cookie', view).expect(200)).body.reservations).toEqual([]);
  });

  it('a delivery cannot take what is reserved for another order', async () => {
    const onHand = level();
    await reserve('AB-2026-0001', onHand - 1).expect(200);
    const refused = await issue('LS-2026-0009', 2, 'AB-2026-0002').expect(422);
    expect(refused.body.details[0].message).toBe(
      `Only 1 of ${sku} in MUC-1 are free (${onHand} on hand, ${onHand - 1} reserved for other orders), not 2`,
    );
    // A delivery without an order is held to the same rule.
    await issue('LS-2026-0010', 2, null).expect(422);
    await issue('LS-2026-0011', 1, 'AB-2026-0002').expect(201);
    // The reserving order itself may take all of it.
    await issue('LS-2026-0012', onHand - 1, 'AB-2026-0001').expect(201);
  });

  it('is accepted even when stock is short, and says by how much', async () => {
    const onHand = level();
    await reserve('AB-2026-0001', onHand).expect(200);
    const short = await reserve('AB-2026-0002', 4).expect(200);
    expect(short.body.short).toEqual([{ sku, open: 4, available: 0, missing: 4 }]);
    expect(await stockRow()).toMatchObject({ reserved: onHand + 4, available: -4 });
  });

  it('setting again replaces, a product dropped from the order is released, and release is idempotent', async () => {
    await reserve('AB-2026-0001', 5).expect(200);
    await reserve('AB-2026-0001', 2).expect(200);
    expect((await stockRow()).reserved).toBe(2);
    await reserve('AB-2026-0001', 0, { lines: [{ sku: 'PK-6003', quantity: 1 }] }).expect(200);
    expect((await stockRow()).reserved).toBe(0);
    const release = () =>
      request(app).post('/api/reservations/release').set('X-Service-Token', TOKEN).send({ source: SOURCE, reference: 'AB-2026-0001', actor: 'chef@example' });
    expect((await release().expect(200)).body.released).toBe(1);
    expect((await release().expect(200)).body.released).toBe(0);
    expect(db.prepare('SELECT released_by FROM reservations WHERE reference = ?').all('AB-2026-0001')).toEqual([
      { released_by: 'vertrieb@example' },
      { released_by: 'chef@example' },
    ]);
  });

  it('refuses unknown articles or warehouses outright, and needs the machine token', async () => {
    const bad = await reserve('AB-2026-0001', 1, { warehouse_code: 'XX-9', lines: [{ sku: 'NOPE', quantity: 1 }] }).expect(422);
    expect(bad.body.details.map((d: { field: string }) => d.field)).toEqual(['warehouse_code', 'lines[0].sku']);
    await request(app).put('/api/reservations').send({}).expect(401);
    await request(app).put('/api/reservations').set('Cookie', view).send({}).expect(401);
    await request(app).post('/api/reservations/release').send({}).expect(401);
  });
});
