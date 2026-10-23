import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import type { AccessLevel } from '@0815software/platform-clients';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { COOKIE_NAME, createToken, type AuthConfig } from '../server/auth.js';
import { noopPlatform, PeerError, type GoodsReceiptRequest, type PlatformHooks } from '../server/platform.js';
import type { PoDetail } from '../shared/types.js';

/**
 * Receiving and the three-way match (server/receiving.ts): what arrived is
 * recorded against an ordered PO, append-only and never beyond what was
 * ordered; article lines are booked into MOD-03 best-effort; and the match
 * answers whether an invoiced net amount may be paid.
 *
 * The PO: 10 × widgets (SKU W-1) at 50 € and 2 × installation (a service, no
 * SKU) at 100 € — 700 € net, one approval tier.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 'test-secret', ttlHours: 1, secureCookie: false };
const TOKEN = 'machine-token';
const as = (access: AccessLevel, actor: string) => `${COOKIE_NAME}=${createToken(auth, actor, Date.now(), access)}`;
const ADMIN = as('manage', 'admin');
const CLERK = as('edit', 'lager@example.com');
const VIEWER = as('view', 'eve@example.com');

let db: Database.Database;
let app: Express;
let booked: GoodsReceiptRequest[];
let inventoryAnswer: 'ok' | 'refuse';
let po: PoDetail;

const inventory: PlatformHooks = {
  ...noopPlatform,
  inventoryConfigured: true,
  async inventoryWarehouses() {
    return [{ code: 'MUC-1', name: 'Munich' }];
  },
  async receiveGoods(request) {
    if (inventoryAnswer === 'refuse') throw new PeerError(422, 'The goods cannot be received: There is no product with SKU W-1');
    booked.push(request);
  },
};

const post = (path: string, values: Record<string, unknown>, cookie = ADMIN) => request(app).post(path).set('Cookie', cookie).send(values);

async function orderedPo(): Promise<PoDetail> {
  const supplier = (await post('/api/suppliers', { name: 'Widget GmbH' }).expect(201)).body.id;
  const created = (
    await post('/api/pos', {
      supplier_id: supplier,
      lines: [
        { description: 'Widget', quantity: 10, unit: 'pc', unit_price_cents: 5000, sku: 'W-1' },
        { description: 'Installation', quantity: 2, unit: 'h', unit_price_cents: 10000 },
      ],
    }).expect(201)
  ).body as PoDetail;
  await post(`/api/pos/${created.id}/submit`, {}).expect(200);
  await post(`/api/pos/${created.id}/approvals`, { tier: 1, approver: 'Team lead' }).expect(201);
  return (await post(`/api/pos/${created.id}/mark-ordered`, {}).expect(200)).body as PoDetail;
}

const receive = (lines: [number, number][], extra: Record<string, unknown> = {}, cookie = ADMIN) =>
  post(`/api/pos/${po.id}/receipts`, { lines: lines.map(([i, quantity]) => ({ po_line_id: po.lines[i]!.id, quantity })), ...extra }, cookie);
const match = (invoiced: number, number = po.number) =>
  request(app).post('/api/match').set('X-Service-Token', TOKEN).send({ po_number: number, invoiced_net_cents: invoiced });

beforeEach(async () => {
  db = openDb(':memory:');
  booked = [];
  inventoryAnswer = 'ok';
  app = createApp({ db, auth, serviceToken: TOKEN, platform: inventory });
  po = await orderedPo();
});

describe('receiving', () => {
  it('records what arrived; received and the receipt status are derived', async () => {
    expect(po).toMatchObject({ receipt_status: 'none', received_cents: 0 });
    const after = (await receive([[0, 4]], { received_on: '2026-10-01', note: 'Pallet 1' }, CLERK).expect(201)).body as PoDetail;
    expect(after.lines.map((l) => l.received_quantity)).toEqual([4, 0]);
    expect(after).toMatchObject({ receipt_status: 'partial', received_cents: 20000 });
    expect(after.receipts[0]).toMatchObject({ number: `${po.number}/WE-1`, kind: 'receipt', received_on: '2026-10-01', actor: 'lager@example.com' });
    const done = (await receive([[0, 6], [1, 2]]).expect(201)).body as PoDetail;
    expect(done).toMatchObject({ receipt_status: 'complete', received_cents: 70000 });
    expect(done.receipts.map((r) => r.number)).toEqual([`${po.number}/WE-1`, `${po.number}/WE-2`]);
  });

  it('never more than was ordered, only on an ordered PO, and not by a viewer', async () => {
    await receive([[0, 8]]).expect(201);
    const over = await receive([[0, 3]]).expect(422);
    expect(over.body.details[0].message).toBe('Line 1: only 2 still to arrive');
    await receive([[0, -1]]).expect(422);
    await receive([[0, 1]], {}, VIEWER).expect(403);
    await post(`/api/pos/${po.id}/close`, {}).expect(200);
    await receive([[0, 1]]).expect(409);
    const draft = (await post('/api/pos', { supplier_id: po.supplier_id, lines: [{ description: 'X', quantity: 1, unit: 'pc', unit_price_cents: 1 }] }).expect(201)).body;
    await post(`/api/pos/${draft.id}/receipts`, { lines: [{ po_line_id: draft.lines[0].id, quantity: 1 }] }).expect(409);
  });

  it('a miscount is corrected by a correction with a reason — the first receipt stays', async () => {
    await receive([[0, 5]]).expect(201);
    await receive([[0, -2]], { kind: 'correction' }).expect(422);
    const corrected = (await receive([[0, -2]], { kind: 'correction', note: 'Two were counted twice' }).expect(201)).body as PoDetail;
    expect(corrected.lines[0]!.received_quantity).toBe(3);
    expect(corrected.receipts.map((r) => [r.kind, r.lines[0]!.quantity])).toEqual([
      ['receipt', 5],
      ['correction', -2],
    ]);
    await receive([[0, -4]], { kind: 'correction', note: 'Too much' }).expect(422);
  });
});

describe('booking the stock in MOD-03', () => {
  const setWarehouse = () => request(app).put('/api/settings/matching').set('Cookie', ADMIN).send({ tolerance_percent: 2, tolerance_cap_cents: 5000, receiving_warehouse: 'MUC-1' });

  it('books the article lines into the receiving warehouse, once, in the person\'s name', async () => {
    await setWarehouse().expect(200);
    const after = (await receive([[0, 4], [1, 1]], {}, CLERK).expect(201)).body as PoDetail;
    expect(booked).toEqual([{ reference: `${po.number}/WE-1`, warehouseCode: 'MUC-1', actor: 'lager@example.com', lines: [{ sku: 'W-1', quantity: 4 }] }]);
    expect(after.receipts[0]).toMatchObject({ stock_status: 'booked', stock_warehouse: 'MUC-1', stock_error: null });
    await post(`/api/receipts/${after.receipts[0]!.id}/book-stock`, {}).expect(409);
  });

  it('a refusal is recorded on the receipt and booked again later — the goods arrived either way', async () => {
    await setWarehouse().expect(200);
    inventoryAnswer = 'refuse';
    const after = (await receive([[0, 4]]).expect(201)).body as PoDetail;
    expect(after.receipts[0]).toMatchObject({ stock_status: 'failed', stock_error: 'The goods cannot be received: There is no product with SKU W-1' });
    expect(after.lines[0]!.received_quantity).toBe(4);
    inventoryAnswer = 'ok';
    const retried = (await post(`/api/receipts/${after.receipts[0]!.id}/book-stock`, {}).expect(200)).body as PoDetail;
    expect(retried.receipts[0]!.stock_status).toBe('booked');
    expect(booked).toHaveLength(1);
  });

  it('without a warehouse, for services only, or for a correction, nothing is booked — and it says why', async () => {
    const noWarehouse = (await receive([[0, 1]]).expect(201)).body as PoDetail;
    expect(noWarehouse.receipts[0]).toMatchObject({ stock_status: 'not_booked', stock_error: 'No receiving warehouse is set in Settings' });
    await setWarehouse().expect(200);
    const service = (await receive([[1, 1]]).expect(201)).body as PoDetail;
    expect(service.receipts[1]!.stock_status).toBeNull();
    const correction = (await receive([[0, -1]], { kind: 'correction', note: 'Damaged' }).expect(201)).body as PoDetail;
    expect(correction.receipts[2]).toMatchObject({ stock_status: 'not_booked', stock_error: 'A correction is not booked — adjust the stock in MOD-03' });
    expect(booked).toEqual([]);
  });

  it('a SKU can be set on a frozen PO, until it is closed', async () => {
    const after = (await request(app).put(`/api/pos/${po.id}/lines/${po.lines[1]!.id}/sku`).set('Cookie', CLERK).send({ sku: 'SVC-1' }).expect(200)).body as PoDetail;
    expect(after.lines[1]!.sku).toBe('SVC-1');
    await post(`/api/pos/${po.id}/close`, {}).expect(200);
    await request(app).put(`/api/pos/${po.id}/lines/${po.lines[1]!.id}/sku`).set('Cookie', ADMIN).send({ sku: null }).expect(409);
  });
});

describe('the three-way match', () => {
  it('matched up to what arrived plus the tolerance; awaiting receipt up to what was ordered; beyond that over-invoiced', async () => {
    await receive([[0, 4]]).expect(201); // 200 € arrived of 700 € ordered
    expect((await match(20000).expect(200)).body).toMatchObject({ result: 'matched', ordered_cents: 70000, received_cents: 20000, tolerance_cents: 400, difference_cents: 0 });
    // 2 % of 200 € = 4 €: an invoice of 204 € still matches, 204.01 € does not.
    expect((await match(20400)).body.result).toBe('matched');
    expect((await match(20401)).body).toMatchObject({ result: 'awaiting_receipt', difference_cents: 401 });
    // The cap: 2 % of 700 € would be 14 €; at most 50 € anyway. 714 € is awaiting, 714.01 € over.
    expect((await match(71400)).body.result).toBe('awaiting_receipt');
    expect((await match(71401)).body).toMatchObject({ result: 'over_invoiced', tolerance_cents: 1400 });
    // Once everything is there, the full amount matches.
    await receive([[0, 6], [1, 2]]).expect(201);
    expect((await match(70000)).body.result).toBe('matched');
  });

  it('the tolerance is the office\'s: a cap below the percentage wins', async () => {
    await receive([[0, 10], [1, 2]]).expect(201);
    await request(app).put('/api/settings/matching').set('Cookie', ADMIN).send({ tolerance_percent: 5, tolerance_cap_cents: 1000 }).expect(200);
    expect((await match(71000)).body).toMatchObject({ result: 'matched', tolerance_cents: 1000 });
    expect((await match(71001)).body.result).toBe('over_invoiced');
    await request(app).put('/api/settings/matching').set('Cookie', CLERK).send({ tolerance_percent: 50 }).expect(403);
    await request(app).put('/api/settings/matching').set('Cookie', ADMIN).send({ tolerance_percent: 50 }).expect(422);
  });

  it('a PO that was never ordered owes nothing; an unknown one is 404; it takes the machine token', async () => {
    const draft = (await post('/api/pos', { supplier_id: po.supplier_id, lines: [{ description: 'X', quantity: 1, unit: 'pc', unit_price_cents: 100 }] }).expect(201)).body;
    expect((await match(0, draft.number)).body.result).toBe('not_ordered');
    await match(100, 'PO-1999-0001').expect(404);
    await request(app).post('/api/match').set('Cookie', ADMIN).send({ po_number: po.number, invoiced_net_cents: 1 }).expect(401);
    await request(app).post('/api/match').set('X-Service-Token', TOKEN).send({ po_number: po.number, invoiced_net_cents: -1 }).expect(422);
  });
});
