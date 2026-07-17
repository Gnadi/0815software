import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type Database from 'better-sqlite3';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import type { AuthConfig } from '../server/auth.js';
import type { StockRow } from '../shared/types.js';

const auth: AuthConfig = {
  username: 'admin',
  password: 'test-password',
  secret: 'test-secret',
  ttlHours: 1,
  secureCookie: false,
};

let db: Database.Database;
let app: Express;
let cookie: string;

/** Ground truth: sum the ledger directly in SQL. */
function ledgerLevel(productId: number, warehouseId?: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(quantity), 0) AS level FROM movements
       WHERE product_id = ? ${warehouseId ? 'AND warehouse_id = ?' : ''}`,
    )
    .get(...(warehouseId ? [productId, warehouseId] : [productId])) as { level: number };
  return Math.round(row.level * 1000) / 1000;
}

function productId(sku: string): number {
  return (db.prepare('SELECT id FROM products WHERE sku = ?').get(sku) as { id: number }).id;
}

async function stockRow(sku: string): Promise<StockRow> {
  const res = await request(app).get('/api/stock').set('Cookie', cookie);
  const row = (res.body.rows as StockRow[]).find((r) => r.sku === sku);
  expect(row, `stock row for ${sku}`).toBeDefined();
  return row!;
}

beforeAll(async () => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth });

  const res = await request(app)
    .post('/api/login')
    .send({ username: 'admin', password: 'test-password' });
  cookie = res.headers['set-cookie']![0]!.split(';')[0]!;
});

describe('auth', () => {
  it('rejects unauthenticated requests with 401', async () => {
    for (const path of ['/api/stock', '/api/products', '/api/purchase-orders', '/api/stock/export.csv']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(401);
    }
    const post = await request(app).post('/api/movements').send({});
    expect(post.status).toBe(401);
  });

  it('rejects bad credentials', async () => {
    const res = await request(app).post('/api/login').send({ username: 'admin', password: 'wrong' });
    expect(res.status).toBe(401);
  });

  it('accepts good credentials and sets an HttpOnly session cookie', async () => {
    const res = await request(app)
      .post('/api/login')
      .send({ username: 'admin', password: 'test-password' });
    expect(res.status).toBe(200);
    expect(res.headers['set-cookie']![0]).toContain('mod03_session=');
    expect(res.headers['set-cookie']![0]).toContain('HttpOnly');
  });
});

describe('stock levels are derived from the ledger', () => {
  it('every overview level equals the SQL sum of its movements', async () => {
    const res = await request(app).get('/api/stock').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const rows = res.body.rows as StockRow[];
    expect(rows.length).toBe(10);
    for (const row of rows) {
      for (const [warehouseId, level] of Object.entries(row.levels)) {
        expect(level, `${row.sku} @ warehouse ${warehouseId}`).toBe(
          ledgerLevel(row.id, Number(warehouseId)),
        );
      }
      expect(row.total, `${row.sku} total`).toBe(ledgerLevel(row.id));
    }
  });

  it('matches the hand-computed seed history (receipts − transfers + PO receipts)', async () => {
    // HW-1002: +60 MUC, +25 HH, 10 MUC→HH, +20 MUC via PO-1001.
    const row = await stockRow('HW-1002');
    expect(row.total).toBe(105);
    expect(Object.values(row.levels).sort((a, b) => a - b)).toEqual([35, 70]);
  });

  it('a receipt raises the level by exactly its quantity', async () => {
    const before = (await stockRow('PK-6003')).total;
    const res = await request(app)
      .post('/api/movements')
      .set('Cookie', cookie)
      .send({ type: 'receipt', product_id: productId('PK-6003'), warehouse_id: 1, quantity: 25, reference: 'DN-TEST-1' });
    expect(res.status).toBe(201);
    expect(res.body.type).toBe('receipt');
    expect((await stockRow('PK-6003')).total).toBe(before + 25);
  });

  it('flags products at or below their reorder point and filters ?low=1', async () => {
    const low = await request(app).get('/api/stock?low=1').set('Cookie', cookie);
    const lowSkus = (low.body.rows as StockRow[]).map((r) => r.sku).sort();
    expect(lowSkus).toEqual(['AC-4002', 'PK-6002']);
    expect((low.body.rows as StockRow[]).every((r) => r.total <= r.reorder_point)).toBe(true);
  });

  it('supports search on sku and name', async () => {
    const res = await request(app).get('/api/stock?search=scanner').set('Cookie', cookie);
    const skus = (res.body.rows as StockRow[]).map((r) => r.sku).sort();
    expect(skus).toEqual(['AC-4002', 'HW-1002']);
  });
});

describe('transfers', () => {
  it('moves stock atomically and conserves the total', async () => {
    const pid = productId('CB-5001');
    const before = await stockRow('CB-5001');
    const fromLevel = before.levels[1] ?? 0;
    const toLevel = before.levels[3] ?? 0;

    const res = await request(app)
      .post('/api/transfers')
      .set('Cookie', cookie)
      .send({ product_id: pid, from_warehouse_id: 1, to_warehouse_id: 3, quantity: 120 });
    expect(res.status).toBe(201);
    expect(res.body.reference).toMatch(/^TRF-\d+$/);

    const after = await stockRow('CB-5001');
    expect(after.levels[1]).toBe(fromLevel - 120);
    expect(after.levels[3]).toBe(toLevel + 120);
    expect(after.total).toBe(before.total); // conservation

    // Both legs exist, share the reference, and sum to zero.
    const legs = db
      .prepare('SELECT type, quantity FROM movements WHERE reference = ? ORDER BY type DESC')
      .all(res.body.reference) as { type: string; quantity: number }[];
    expect(legs).toEqual([
      { type: 'transfer_out', quantity: -120 },
      { type: 'transfer_in', quantity: 120 },
    ]);
  });

  it('rejects a transfer exceeding available stock with 422 and writes nothing', async () => {
    const pid = productId('HW-1001');
    const before = await stockRow('HW-1001');
    const movementCount = (db.prepare('SELECT COUNT(*) AS c FROM movements').get() as { c: number }).c;

    const res = await request(app)
      .post('/api/transfers')
      .set('Cookie', cookie)
      .send({ product_id: pid, from_warehouse_id: 2, to_warehouse_id: 1, quantity: 9999 });
    expect(res.status).toBe(422);
    expect(res.body.details[0].message).toContain('Insufficient stock');

    const after = await stockRow('HW-1001');
    expect(after.levels).toEqual(before.levels);
    expect((db.prepare('SELECT COUNT(*) AS c FROM movements').get() as { c: number }).c).toBe(movementCount);
  });

  it('rejects a transfer to the same warehouse', async () => {
    const res = await request(app)
      .post('/api/transfers')
      .set('Cookie', cookie)
      .send({ product_id: productId('HW-1001'), from_warehouse_id: 1, to_warehouse_id: 1, quantity: 1 });
    expect(res.status).toBe(422);
  });

  it('rejects non-positive quantities', async () => {
    const res = await request(app)
      .post('/api/transfers')
      .set('Cookie', cookie)
      .send({ product_id: productId('HW-1001'), from_warehouse_id: 1, to_warehouse_id: 2, quantity: -5 });
    expect(res.status).toBe(422);
  });
});

describe('adjustments', () => {
  it('rejects an adjustment without a note with 422', async () => {
    const res = await request(app)
      .post('/api/movements')
      .set('Cookie', cookie)
      .send({ type: 'adjustment', product_id: productId('AC-4003'), warehouse_id: 1, quantity: -1 });
    expect(res.status).toBe(422);
    expect(res.body.details.some((d: { field: string }) => d.field === 'note')).toBe(true);
  });

  it('records a noted adjustment and updates the level', async () => {
    const before = (await stockRow('AC-4003')).total;
    const res = await request(app)
      .post('/api/movements')
      .set('Cookie', cookie)
      .send({
        type: 'adjustment',
        product_id: productId('AC-4003'),
        warehouse_id: 1,
        quantity: -3,
        note: 'Damaged in handling, scrapped',
      });
    expect(res.status).toBe(201);
    expect((await stockRow('AC-4003')).total).toBe(before - 3);
  });

  it('rejects an adjustment that would take stock below zero', async () => {
    const res = await request(app)
      .post('/api/movements')
      .set('Cookie', cookie)
      .send({
        type: 'adjustment',
        product_id: productId('AC-4003'),
        warehouse_id: 3,
        quantity: -500,
        note: 'bogus',
      });
    expect(res.status).toBe(422);
  });
});

describe('products CRUD', () => {
  it('round-trips a product', async () => {
    const created = await request(app)
      .post('/api/products')
      .set('Cookie', cookie)
      .send({ sku: 'TS-9001', name: 'Test Widget', unit: 'pcs', reorder_point: 4 });
    expect(created.status).toBe(201);
    const pid = created.body.id as number;

    const updated = await request(app)
      .put(`/api/products/${pid}`)
      .set('Cookie', cookie)
      .send({ sku: 'TS-9001', name: 'Test Widget XL', unit: 'box', reorder_point: 6 });
    expect(updated.status).toBe(200);
    expect(updated.body.name).toBe('Test Widget XL');
    expect(updated.body.unit).toBe('box');

    const detail = await request(app).get(`/api/products/${pid}`).set('Cookie', cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.stock).toHaveLength(3);
    expect(detail.body.stock.every((s: { level: number }) => s.level === 0)).toBe(true);

    const deleted = await request(app).delete(`/api/products/${pid}`).set('Cookie', cookie);
    expect(deleted.status).toBe(200);
    const gone = await request(app).get(`/api/products/${pid}`).set('Cookie', cookie);
    expect(gone.status).toBe(404);
  });

  it('validates sku format, duplicates, and reorder point', async () => {
    const bad = await request(app)
      .post('/api/products')
      .set('Cookie', cookie)
      .send({ sku: 'lower case!', name: '', reorder_point: -2 });
    expect(bad.status).toBe(422);
    const fields = bad.body.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['sku', 'name', 'reorder_point']));

    const dup = await request(app)
      .post('/api/products')
      .set('Cookie', cookie)
      .send({ sku: 'HW-1001', name: 'Duplicate', unit: 'pcs' });
    expect(dup.status).toBe(422);
  });

  it('refuses to delete a product with ledger history (409)', async () => {
    const res = await request(app)
      .delete(`/api/products/${productId('HW-1001')}`)
      .set('Cookie', cookie);
    expect(res.status).toBe(409);
  });

  it('serves movement history newest-first with warehouse codes', async () => {
    const res = await request(app)
      .get(`/api/products/${productId('HW-1002')}/movements`)
      .set('Cookie', cookie);
    expect(res.status).toBe(200);
    const movements = res.body.movements as { type: string; warehouse_code: string; created_at: string }[];
    expect(movements.length).toBeGreaterThanOrEqual(5);
    expect(movements.map((m) => m.type)).toEqual(
      expect.arrayContaining(['receipt', 'transfer_out', 'transfer_in', 'po_receipt']),
    );
    const dates = movements.map((m) => m.created_at);
    expect([...dates].sort().reverse()).toEqual(dates);
  });
});

describe('purchase orders', () => {
  async function createOrderedPo(): Promise<{ poId: number; lineIds: number[] }> {
    const created = await request(app)
      .post('/api/purchase-orders')
      .set('Cookie', cookie)
      .send({
        supplier_id: 1,
        lines: [
          { product_id: productId('AC-4002'), quantity: 10 },
          { product_id: productId('PK-6002'), quantity: 6 },
        ],
      });
    expect(created.status).toBe(201);
    expect(created.body.status).toBe('draft');
    const poId = created.body.id as number;
    const ordered = await request(app).post(`/api/purchase-orders/${poId}/order`).set('Cookie', cookie);
    expect(ordered.status).toBe(200);
    expect(ordered.body.status).toBe('ordered');
    return { poId, lineIds: created.body.lines.map((l: { id: number }) => l.id) };
  }

  it('lists the seeded POs in every status', async () => {
    const res = await request(app).get('/api/purchase-orders').set('Cookie', cookie);
    expect(res.status).toBe(200);
    const statuses = res.body.purchase_orders.map((po: { status: string }) => po.status);
    expect(statuses).toEqual(
      expect.arrayContaining(['draft', 'ordered', 'partially_received', 'received']),
    );
  });

  it('partial receipt updates stock via the ledger and sets partially_received, then received', async () => {
    const { poId, lineIds } = await createOrderedPo();
    const dockBefore = (await stockRow('AC-4002')).total;
    const filmBefore = (await stockRow('PK-6002')).total;

    // Receive 4 of 10 docks into Hamburg — partial.
    const partial = await request(app)
      .post(`/api/purchase-orders/${poId}/receive`)
      .set('Cookie', cookie)
      .send({ warehouse_id: 2, lines: [{ line_id: lineIds[0], quantity: 4 }] });
    expect(partial.status).toBe(200);
    expect(partial.body.status).toBe('partially_received');
    expect(partial.body.lines[0].qty_received).toBe(4);
    expect((await stockRow('AC-4002')).total).toBe(dockBefore + 4);
    expect((await stockRow('AC-4002')).levels[2]).toBe(ledgerLevel(productId('AC-4002'), 2));

    // Receive the rest of both lines — received.
    const full = await request(app)
      .post(`/api/purchase-orders/${poId}/receive`)
      .set('Cookie', cookie)
      .send({
        warehouse_id: 2,
        lines: [
          { line_id: lineIds[0], quantity: 6 },
          { line_id: lineIds[1], quantity: 6 },
        ],
      });
    expect(full.status).toBe(200);
    expect(full.body.status).toBe('received');
    expect((await stockRow('AC-4002')).total).toBe(dockBefore + 10);
    expect((await stockRow('PK-6002')).total).toBe(filmBefore + 6);

    // The ledger movements carry the PO number as reference.
    const detail = await request(app).get(`/api/purchase-orders/${poId}`).set('Cookie', cookie);
    const refs = db
      .prepare("SELECT COUNT(*) AS c FROM movements WHERE type = 'po_receipt' AND reference = ?")
      .get(detail.body.po_number) as { c: number };
    expect(refs.c).toBe(3);
  });

  it('rejects over-receipt with 422 and leaves stock and status untouched', async () => {
    const { poId, lineIds } = await createOrderedPo();
    const before = (await stockRow('AC-4002')).total;

    const res = await request(app)
      .post(`/api/purchase-orders/${poId}/receive`)
      .set('Cookie', cookie)
      .send({ warehouse_id: 1, lines: [{ line_id: lineIds[0], quantity: 11 }] });
    expect(res.status).toBe(422);
    expect(res.body.details[0].message).toContain('only 10 open');

    expect((await stockRow('AC-4002')).total).toBe(before);
    const detail = await request(app).get(`/api/purchase-orders/${poId}`).set('Cookie', cookie);
    expect(detail.body.status).toBe('ordered');
    expect(detail.body.lines[0].qty_received).toBe(0);
  });

  it('over-receipt across two partial receipts is also rejected', async () => {
    const { poId, lineIds } = await createOrderedPo();
    await request(app)
      .post(`/api/purchase-orders/${poId}/receive`)
      .set('Cookie', cookie)
      .send({ warehouse_id: 1, lines: [{ line_id: lineIds[0], quantity: 7 }] });
    const res = await request(app)
      .post(`/api/purchase-orders/${poId}/receive`)
      .set('Cookie', cookie)
      .send({ warehouse_id: 1, lines: [{ line_id: lineIds[0], quantity: 4 }] });
    expect(res.status).toBe(422);
    expect(res.body.details[0].message).toContain('only 3 open');
  });

  it('refuses to receive a draft (409) and to double-order (409)', async () => {
    const created = await request(app)
      .post('/api/purchase-orders')
      .set('Cookie', cookie)
      .send({ supplier_id: 2, lines: [{ product_id: productId('CB-5001'), quantity: 50 }] });
    const poId = created.body.id as number;

    const receive = await request(app)
      .post(`/api/purchase-orders/${poId}/receive`)
      .set('Cookie', cookie)
      .send({ warehouse_id: 1, lines: [{ line_id: created.body.lines[0].id, quantity: 1 }] });
    expect(receive.status).toBe(409);

    await request(app).post(`/api/purchase-orders/${poId}/order`).set('Cookie', cookie);
    const again = await request(app).post(`/api/purchase-orders/${poId}/order`).set('Cookie', cookie);
    expect(again.status).toBe(409);
  });

  it('deletes drafts only', async () => {
    const created = await request(app)
      .post('/api/purchase-orders')
      .set('Cookie', cookie)
      .send({ supplier_id: 3, lines: [{ product_id: productId('PK-6001'), quantity: 100 }] });
    const del = await request(app)
      .delete(`/api/purchase-orders/${created.body.id}`)
      .set('Cookie', cookie);
    expect(del.status).toBe(200);

    const seededReceived = await request(app).get('/api/purchase-orders').set('Cookie', cookie);
    const received = seededReceived.body.purchase_orders.find(
      (po: { status: string }) => po.status === 'received',
    );
    const notDraft = await request(app)
      .delete(`/api/purchase-orders/${received.id}`)
      .set('Cookie', cookie);
    expect(notDraft.status).toBe(409);
  });

  it('validates the create payload', async () => {
    const res = await request(app)
      .post('/api/purchase-orders')
      .set('Cookie', cookie)
      .send({ supplier_id: 1, lines: [] });
    expect(res.status).toBe(422);
    const missing = await request(app)
      .post('/api/purchase-orders')
      .set('Cookie', cookie)
      .send({ supplier_id: 999, lines: [{ product_id: productId('HW-1001'), quantity: 1 }] });
    expect(missing.status).toBe(404);
  });
});

describe('CSV export', () => {
  it('exports current stock with one column per warehouse and correct totals', async () => {
    const res = await request(app).get('/api/stock/export.csv').set('Cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('stock-levels.csv');

    const lines = res.text.trim().split('\r\n');
    expect(lines[0]).toBe('sku,name,unit,reorder_point,MUC-1,HH-1,B-1,total');

    const stock = await request(app).get('/api/stock').set('Cookie', cookie);
    expect(lines.length).toBe(1 + (stock.body.rows as StockRow[]).length);

    const hw1002 = lines.find((l) => l.startsWith('HW-1002,'))!;
    const cells = hw1002.split(',');
    const [muc, hh, b, total] = cells.slice(4).map(Number);
    expect(muc! + hh! + b!).toBe(total);
    expect(total).toBe(ledgerLevel(productId('HW-1002')));
  });

  it('quotes cells containing commas', async () => {
    const res = await request(app).get('/api/stock/export.csv?search=AC-4001').set('Cookie', cookie);
    expect(res.text).toContain('Thermal Label Roll (10x)'); // no comma → not quoted
    // …but a product name with a comma is:
    await request(app)
      .post('/api/products')
      .set('Cookie', cookie)
      .send({ sku: 'TS-9002', name: 'Bracket, stainless', unit: 'pcs' });
    const quoted = await request(app).get('/api/stock/export.csv?search=TS-9002').set('Cookie', cookie);
    expect(quoted.text).toContain('"Bracket, stainless"');
  });
});
