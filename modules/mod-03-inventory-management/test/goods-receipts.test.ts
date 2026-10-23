import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { stockLevel } from '../server/ledger.js';
import type { AuthConfig } from '../server/auth.js';

/**
 * Goods received against another module's purchase order (server/goods-receipts.ts):
 * the mirror of a goods issue — a machine call on behalf of a named person,
 * all or nothing, and booked once per receipt however often it is retried.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's', ttlHours: 1, secureCookie: false };
const TOKEN = 'machine-token';

let db: Database.Database;
let app: Express;

const id = (table: string, column: string, value: string): number =>
  (db.prepare(`SELECT id FROM ${table} WHERE ${column} = ?`).get(value) as { id: number }).id;
const level = (sku: string, wh = 'MUC-1') => stockLevel(db, id('products', 'sku', sku), id('warehouses', 'code', wh));

const receive = (body: Record<string, unknown>, token: string | null = TOKEN) => {
  const req = request(app).post('/api/goods-receipts');
  if (token) req.set('X-Service-Token', token);
  return req.send({ source: 'mod-06-procurement-tracker', reference: 'PO-2026-0001/WE-1', warehouse_code: 'MUC-1', actor: 'lager@example', ...body });
};

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth, serviceToken: TOKEN });
});

describe('POST /api/goods-receipts', () => {
  it('books one positive movement per product, naming the receipt and the person', async () => {
    const before = level('PK-6002');
    const res = await receive({ lines: [{ sku: 'PK-6002', quantity: 2 }, { sku: 'PK-6002', quantity: 1.5 }] }).expect(201);
    expect(res.body).toMatchObject({ reference: 'PO-2026-0001/WE-1', warehouse_code: 'MUC-1', actor: 'lager@example', replayed: false, lines: [{ sku: 'PK-6002', quantity: 3.5 }] });
    expect(level('PK-6002')).toBe(before + 3.5);
    const movement = db.prepare("SELECT * FROM movements WHERE reference = 'PO-2026-0001/WE-1'").get() as { type: string; quantity: number; note: string };
    expect(movement).toMatchObject({ type: 'receipt', quantity: 3.5, note: 'mod-06-procurement-tracker · lager@example' });
  });

  it('books once per receipt: a retry returns the first booking', async () => {
    const before = level('PK-6002');
    await receive({ lines: [{ sku: 'PK-6002', quantity: 2 }] }).expect(201);
    const again = await receive({ lines: [{ sku: 'PK-6002', quantity: 9 }] }).expect(200);
    expect(again.body).toMatchObject({ replayed: true, lines: [{ sku: 'PK-6002', quantity: 2 }] });
    expect(level('PK-6002')).toBe(before + 2);
  });

  it('is all or nothing, and needs the machine token and a named person', async () => {
    const before = level('PK-6002');
    const res = await receive({ warehouse_code: 'XX-9', lines: [{ sku: 'PK-6002', quantity: 1 }, { sku: 'NOPE', quantity: 1 }] }).expect(422);
    expect(res.body.details.map((d: { field: string }) => d.field)).toEqual(['warehouse_code', 'lines[1].sku']);
    expect(level('PK-6002')).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM goods_receipts').get()).toEqual({ n: 0 });
    await receive({ lines: [{ sku: 'PK-6002', quantity: 1 }] }, null).expect(401);
    const bad = await receive({ actor: '', lines: [{ sku: 'PK-6002', quantity: -1 }] }).expect(422);
    expect(bad.body.details.map((d: { field: string }) => d.field)).toEqual(['actor', 'lines[0].quantity']);
  });
});
