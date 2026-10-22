import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Express } from 'express';
import { createApp } from '../server/app.js';
import { openDb } from '../server/db.js';
import { seed } from '../server/seed.js';
import { stockLevel } from '../server/ledger.js';
import type { AuthConfig } from '../server/auth.js';

/**
 * Goods issue for another module's delivery note (server/goods-issues.ts):
 * a machine call on behalf of a named person, all or nothing, never below
 * zero, and booked once per delivery however often it is retried.
 */

const auth: AuthConfig = { username: 'admin', password: 'pw', secret: 's', ttlHours: 1, secureCookie: false };
const TOKEN = 'machine-token';

let db: Database.Database;
let app: Express;

const id = (table: string, column: string, value: string): number =>
  (db.prepare(`SELECT id FROM ${table} WHERE ${column} = ?`).get(value) as { id: number }).id;
const level = (sku: string, wh = 'MUC-1') => stockLevel(db, id('products', 'sku', sku), id('warehouses', 'code', wh));

const issue = (body: Record<string, unknown>, token: string | null = TOKEN) => {
  const req = request(app).post('/api/goods-issues');
  if (token) req.set('X-Service-Token', token);
  return req.send({ source: 'mod-17-orders-delivery', reference: 'LS-2026-0001', warehouse_code: 'MUC-1', actor: 'lager@example', ...body });
};

beforeEach(() => {
  db = openDb(':memory:');
  seed(db);
  app = createApp({ db, auth, serviceToken: TOKEN });
});

describe('POST /api/goods-issues', () => {
  it('books one negative movement per product, naming the delivery note and the person', async () => {
    const before = level('PK-6002');
    const res = await issue({ lines: [{ sku: 'PK-6002', quantity: 2 }, { sku: 'PK-6002', quantity: 1.5 }] }).expect(201);
    expect(res.body).toMatchObject({ reference: 'LS-2026-0001', warehouse_code: 'MUC-1', actor: 'lager@example', replayed: false, lines: [{ sku: 'PK-6002', quantity: 3.5 }] });
    expect(level('PK-6002')).toBe(before - 3.5);
    const movement = db.prepare("SELECT * FROM movements WHERE type = 'goods_issue'").get() as { quantity: number; reference: string; note: string };
    expect(movement).toMatchObject({ quantity: -3.5, reference: 'LS-2026-0001', note: 'mod-17-orders-delivery · lager@example' });
  });

  it('books once per delivery: a retry returns the first booking', async () => {
    const before = level('PK-6002');
    await issue({ lines: [{ sku: 'PK-6002', quantity: 2 }] }).expect(201);
    const again = await issue({ lines: [{ sku: 'PK-6002', quantity: 5 }] }).expect(200);
    expect(again.body).toMatchObject({ replayed: true, lines: [{ sku: 'PK-6002', quantity: 2 }] });
    expect(level('PK-6002')).toBe(before - 2);
    // Another source may use the same number for something else.
    await issue({ source: 'other-module', lines: [{ sku: 'PK-6002', quantity: 1 }] }).expect(201);
    expect(level('PK-6002')).toBe(before - 3);
  });

  it('is all or nothing: an unknown SKU or short stock books nothing and names each line', async () => {
    const before = level('PK-6002');
    const res = await issue({ warehouse_code: 'MUC-1', lines: [{ sku: 'PK-6002', quantity: 1 }, { sku: 'NOPE', quantity: 1 }, { sku: 'PK-6003', quantity: 100_000 }] }).expect(422);
    expect(res.body.details.map((d: { field: string }) => d.field)).toEqual(['lines[1].sku', 'lines[2].quantity']);
    expect(res.body.details[1].message).toMatch(/^Only \d+ of PK-6003 in MUC-1, not 100000$/);
    expect(level('PK-6002')).toBe(before);
    expect(db.prepare('SELECT COUNT(*) AS n FROM goods_issues').get()).toEqual({ n: 0 });
    // Short stock refused means the delivery note can be booked later, once stock is there.
    await issue({ warehouse_code: 'XX-9', lines: [{ sku: 'PK-6002', quantity: 1 }] }).expect(422);
  });

  it('needs the machine token and a named person', async () => {
    await issue({ lines: [{ sku: 'PK-6002', quantity: 1 }] }, null).expect(401);
    await issue({ lines: [{ sku: 'PK-6002', quantity: 1 }] }, 'wrong').expect(401);
    const res = await issue({ actor: '', lines: [{ sku: 'PK-6002', quantity: 0 }] }).expect(422);
    expect(res.body.details.map((d: { field: string }) => d.field)).toEqual(['actor', 'lines[0].quantity']);
    const standalone = createApp({ db, auth });
    await request(standalone).post('/api/goods-issues').set('X-Service-Token', TOKEN).send({}).expect(401);
  });

  it('lists the warehouses to issue from, for the caller to choose', async () => {
    const res = await request(app).get('/api/goods-issues/warehouses').set('X-Service-Token', TOKEN).expect(200);
    expect(res.body.warehouses.map((w: { code: string }) => w.code)).toEqual(['MUC-1', 'HH-1', 'B-1']);
    await request(app).get('/api/goods-issues/warehouses').expect(401);
  });
});

describe('upgrading a database from before goods issues', () => {
  it('rebuilds the movements table once, keeping every row, and then accepts goods issues', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mod03-gi-'));
    const path = join(dir, 'data.db');
    try {
      const fresh = openDb(path);
      seed(fresh);
      const rows = fresh.prepare('SELECT * FROM movements ORDER BY id').all();
      // Put the old CHECK back, as a database of the previous release has it.
      fresh.pragma('foreign_keys = OFF');
      fresh.exec(`
        CREATE TABLE movements_old (
          id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id),
          warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
          type TEXT NOT NULL CHECK (type IN ('receipt', 'transfer_out', 'transfer_in', 'adjustment', 'po_receipt')),
          quantity REAL NOT NULL CHECK (quantity != 0), reference TEXT, note TEXT, created_at TEXT NOT NULL);
        INSERT INTO movements_old SELECT * FROM movements;
        DROP TABLE movements;
        ALTER TABLE movements_old RENAME TO movements;
        CREATE INDEX idx_movements_product ON movements (product_id, warehouse_id);
      `);
      fresh.close();

      const upgraded = openDb(path);
      expect(upgraded.prepare('SELECT * FROM movements ORDER BY id').all()).toEqual(rows);
      expect(upgraded.pragma('foreign_key_check')).toEqual([]);
      const product = (upgraded.prepare("SELECT id FROM products WHERE sku = 'PK-6002'").get() as { id: number }).id;
      upgraded
        .prepare("INSERT INTO movements (product_id, warehouse_id, type, quantity, created_at) VALUES (?, 1, 'goods_issue', -1, 'x')")
        .run(product);
      upgraded.close();
      // Opening again changes nothing.
      const again = openDb(path);
      expect((again.prepare('SELECT COUNT(*) AS n FROM movements').get() as { n: number }).n).toBe(rows.length + 1);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
