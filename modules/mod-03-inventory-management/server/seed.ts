import type Database from 'better-sqlite3';
import { recordAdjustment, recordReceipt, transfer } from './ledger.js';
import { createPurchaseOrder, markOrdered, receivePurchaseOrder } from './purchase-orders.js';

/**
 * Example dataset: 3 warehouses, 10 products, 3 suppliers, a few months
 * of movement history and purchase orders in every status. All stock is
 * written THROUGH the ledger functions (never raw counters), so the seeded
 * database satisfies the same invariants as a live one.
 *
 * Idempotent: the dataset is relational, so seeding is all-or-nothing —
 * if any warehouses exist the seed is skipped entirely.
 */
export function seed(db: Database.Database): void {
  const { count } = db.prepare('SELECT COUNT(*) AS count FROM warehouses').get() as { count: number };
  if (count > 0) {
    console.log(`[seed] database already contains ${count} warehouses, skipping`);
    return;
  }

  db.transaction(() => {
    // ── Warehouses ─────────────────────────────────────────────────────
    const insertWarehouse = db.prepare('INSERT INTO warehouses (code, name) VALUES (?, ?)');
    for (const [code, name] of [
      ['MUC-1', 'Main Warehouse Munich'],
      ['HH-1', 'North Hub Hamburg'],
      ['B-1', 'Overflow Storage Berlin'],
    ]) {
      insertWarehouse.run(code, name);
    }
    const wh = (code: string): number =>
      (db.prepare('SELECT id FROM warehouses WHERE code = ?').get(code) as { id: number }).id;
    const MUC = wh('MUC-1');
    const HH = wh('HH-1');
    const B = wh('B-1');

    // ── Suppliers ──────────────────────────────────────────────────────
    const insertSupplier = db.prepare('INSERT INTO suppliers (name, email) VALUES (?, ?)');
    for (const [name, email] of [
      ['PrintTec Supplies AG', 'sales@printtec.example.ch'],
      ['Nordkabel GmbH', 'orders@nordkabel.example.de'],
      ['Steiner Verpackung KG', 'office@steiner-verpackung.example.at'],
    ]) {
      insertSupplier.run(name, email);
    }
    const sup = (name: string): number =>
      (db.prepare('SELECT id FROM suppliers WHERE name = ?').get(name) as { id: number }).id;

    // ── Products ───────────────────────────────────────────────────────
    const insertProduct = db.prepare(
      'INSERT INTO products (sku, name, unit, reorder_point) VALUES (?, ?, ?, ?)',
    );
    const products: [string, string, string, number][] = [
      ['HW-1001', 'Industrial Label Printer', 'pcs', 5],
      ['HW-1002', 'Barcode Scanner MK II', 'pcs', 20],
      ['HW-1003', 'Rugged Handheld Terminal', 'pcs', 8],
      ['AC-4001', 'Thermal Label Roll (10x)', 'box', 40],
      ['AC-4002', 'Scanner Charging Dock', 'pcs', 10],
      ['AC-4003', 'Protective Case', 'pcs', 15],
      ['CB-5001', 'Network Cable Cat6', 'm', 100],
      ['PK-6001', 'Shipping Carton M', 'pcs', 200],
      ['PK-6002', 'Stretch Film Roll', 'pcs', 12],
      ['PK-6003', 'Packing Tape 50m', 'pcs', 30],
    ];
    for (const p of products) insertProduct.run(...p);
    const prod = (sku: string): number =>
      (db.prepare('SELECT id FROM products WHERE sku = ?').get(sku) as { id: number }).id;

    // ── Opening stock (plain receipts with delivery-note references) ───
    const receipts: [string, number, number, string, string][] = [
      ['HW-1001', MUC, 12, 'DN-2026-0301', '2026-05-04T09:12:00Z'],
      ['HW-1002', MUC, 60, 'DN-2026-0301', '2026-05-04T09:20:00Z'],
      ['HW-1002', HH, 25, 'DN-2026-0307', '2026-05-06T11:05:00Z'],
      ['HW-1003', MUC, 10, 'DN-2026-0311', '2026-05-08T08:44:00Z'],
      ['AC-4001', MUC, 120, 'DN-2026-0315', '2026-05-11T13:30:00Z'],
      ['AC-4001', HH, 40, 'DN-2026-0316', '2026-05-12T10:02:00Z'],
      ['AC-4002', MUC, 8, 'DN-2026-0319', '2026-05-13T15:41:00Z'],
      ['AC-4003', MUC, 40, 'DN-2026-0319', '2026-05-13T15:48:00Z'],
      ['CB-5001', MUC, 500, 'DN-2026-0322', '2026-05-15T09:00:00Z'],
      ['PK-6001', MUC, 600, 'DN-2026-0325', '2026-05-18T14:12:00Z'],
      ['PK-6001', HH, 250, 'DN-2026-0326', '2026-05-19T09:55:00Z'],
      ['PK-6002', MUC, 20, 'DN-2026-0328', '2026-05-20T10:31:00Z'],
      ['PK-6003', MUC, 80, 'DN-2026-0328', '2026-05-20T10:35:00Z'],
    ];
    for (const [sku, warehouseId, quantity, reference, createdAt] of receipts) {
      recordReceipt(db, { productId: prod(sku), warehouseId, quantity, reference, createdAt });
    }

    // ── Inter-warehouse transfers (paired legs, conserving totals) ─────
    transfer(db, {
      productId: prod('HW-1002'), fromWarehouseId: MUC, toWarehouseId: HH, quantity: 10,
      note: 'Rebalance for Hamburg pilot customers', createdAt: '2026-06-02T08:15:00Z',
    });
    transfer(db, {
      productId: prod('AC-4001'), fromWarehouseId: MUC, toWarehouseId: B, quantity: 30,
      note: 'Overflow — Munich racks full', createdAt: '2026-06-05T16:20:00Z',
    });
    transfer(db, {
      productId: prod('PK-6001'), fromWarehouseId: MUC, toWarehouseId: B, quantity: 100,
      note: 'Overflow — Munich racks full', createdAt: '2026-06-05T16:24:00Z',
    });

    // ── Stocktake adjustments (note is mandatory) ──────────────────────
    recordAdjustment(db, {
      productId: prod('AC-4003'), warehouseId: MUC, quantity: -2,
      note: 'Stocktake 2026-06: two cases crushed in rack 14', createdAt: '2026-06-15T07:50:00Z',
    });
    recordAdjustment(db, {
      productId: prod('PK-6002'), warehouseId: MUC, quantity: -10,
      note: 'Stocktake 2026-06: pallet wrap water damage, scrapped', createdAt: '2026-06-15T08:05:00Z',
    });
    recordAdjustment(db, {
      productId: prod('HW-1001'), warehouseId: MUC, quantity: 1,
      note: 'Stocktake 2026-06: unit found mis-shelved in returns area', createdAt: '2026-06-15T08:20:00Z',
    });

    // ── Purchase orders in every status ────────────────────────────────
    // PO-1001 — fully received (label rolls + scanners from PrintTec).
    const po1 = createPurchaseOrder(db, {
      supplierId: sup('PrintTec Supplies AG'),
      lines: [
        { productId: prod('AC-4001'), quantity: 80 },
        { productId: prod('HW-1002'), quantity: 20 },
      ],
      createdAt: '2026-06-10T09:00:00Z',
    });
    markOrdered(db, po1);
    const lines1 = db
      .prepare('SELECT id FROM purchase_order_lines WHERE po_id = ? ORDER BY id')
      .all(po1) as { id: number }[];
    receivePurchaseOrder(db, po1, {
      warehouseId: MUC,
      lines: [
        { lineId: lines1[0]!.id, quantity: 80 },
        { lineId: lines1[1]!.id, quantity: 20 },
      ],
      createdAt: '2026-06-24T10:40:00Z',
    });

    // PO-1002 — partially received (4 of 10 terminals arrived in Hamburg).
    const po2 = createPurchaseOrder(db, {
      supplierId: sup('PrintTec Supplies AG'),
      lines: [
        { productId: prod('HW-1003'), quantity: 10 },
        { productId: prod('PK-6002'), quantity: 24 },
      ],
      createdAt: '2026-06-28T11:30:00Z',
    });
    markOrdered(db, po2);
    const lines2 = db
      .prepare('SELECT id FROM purchase_order_lines WHERE po_id = ? ORDER BY id')
      .all(po2) as { id: number }[];
    receivePurchaseOrder(db, po2, {
      warehouseId: HH,
      lines: [{ lineId: lines2[0]!.id, quantity: 4 }],
      createdAt: '2026-07-09T09:25:00Z',
    });

    // PO-1003 — ordered, nothing received yet.
    const po3 = createPurchaseOrder(db, {
      supplierId: sup('Nordkabel GmbH'),
      lines: [
        { productId: prod('CB-5001'), quantity: 300 },
        { productId: prod('PK-6003'), quantity: 60 },
      ],
      createdAt: '2026-07-06T14:00:00Z',
    });
    markOrdered(db, po3);

    // PO-1004 — draft, still being put together.
    createPurchaseOrder(db, {
      supplierId: sup('Steiner Verpackung KG'),
      lines: [
        { productId: prod('HW-1001'), quantity: 5 },
        { productId: prod('AC-4002'), quantity: 10 },
      ],
      createdAt: '2026-07-14T16:45:00Z',
    });
  })();

  const movements = db.prepare('SELECT COUNT(*) AS c FROM movements').get() as { c: number };
  console.log(
    `[seed] inserted 3 warehouses, 10 products, 3 suppliers, 4 purchase orders, ${movements.c} ledger movements`,
  );
}

// CLI entry: npm run seed
const { pathToFileURL } = await import('node:url');
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { openDb } = await import('./db.js');
  const { configFromEnv } = await import('./config.js');
  const config = configFromEnv();
  const db = openDb(config.databasePath);
  seed(db);
  db.close();
  console.log(`[seed] done — database at ${config.databasePath}`);
}
