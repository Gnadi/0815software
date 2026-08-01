import type Database from 'better-sqlite3';
import type { MovementRow, StockRow, Warehouse } from '../shared/types.js';

/** A LIKE pattern that matches the term literally — see the ESCAPE clauses below. */
function likeTerm(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** Error with an HTTP status and optional per-field details. */
export class DomainError extends Error {
  status: number;
  details: { field: string; message: string }[];

  constructor(status: number, message: string, details: { field: string; message: string }[] = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/** SQLite REAL sums accumulate float noise — normalise to 3 decimals. */
export function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function requireRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) throw new DomainError(404, `${what} not found`);
  return row;
}

export function getWarehouse(db: Database.Database, id: number): Warehouse {
  return requireRow(
    db.prepare('SELECT * FROM warehouses WHERE id = ?').get(id) as Warehouse | undefined,
    'Warehouse',
  );
}

export function getProduct(db: Database.Database, id: number): { id: number } {
  return requireRow(
    db.prepare('SELECT id FROM products WHERE id = ?').get(id) as { id: number } | undefined,
    'Product',
  );
}

/** Current level for one (product, warehouse) — the sum of its ledger. */
export function stockLevel(db: Database.Database, productId: number, warehouseId: number): number {
  const row = db
    .prepare(
      'SELECT COALESCE(SUM(quantity), 0) AS level FROM movements WHERE product_id = ? AND warehouse_id = ?',
    )
    .get(productId, warehouseId) as { level: number };
  return round3(row.level);
}

/** Per-warehouse levels for one product (warehouses without movements → 0). */
export function stockByWarehouse(
  db: Database.Database,
  productId: number,
): { warehouse_id: number; code: string; name: string; level: number }[] {
  const rows = db
    .prepare(
      `SELECT w.id AS warehouse_id, w.code, w.name, COALESCE(SUM(m.quantity), 0) AS level
       FROM warehouses w
       LEFT JOIN movements m ON m.warehouse_id = w.id AND m.product_id = ?
       GROUP BY w.id ORDER BY w.id`,
    )
    .all(productId) as { warehouse_id: number; code: string; name: string; level: number }[];
  return rows.map((r) => ({ ...r, level: round3(r.level) }));
}

/**
 * Stock overview: one row per product with per-warehouse levels and total.
 * `low` means total ≤ reorder point.
 */
export function stockOverview(
  db: Database.Database,
  opts: { search?: string; lowOnly?: boolean } = {},
): StockRow[] {
  const search = opts.search?.trim();
  const products = db
    .prepare(
      `SELECT id, sku, name, unit, reorder_point FROM products
       ${search ? 'WHERE sku LIKE ? ESCAPE \'\\\' OR name LIKE ? ESCAPE \'\\\'' : ''}
       ORDER BY sku`,
    )
    .all(...(search ? [likeTerm(search), likeTerm(search)] : [])) as Omit<
    StockRow,
    'levels' | 'total' | 'low'
  >[];

  const sums = db
    .prepare(
      'SELECT product_id, warehouse_id, SUM(quantity) AS level FROM movements GROUP BY product_id, warehouse_id',
    )
    .all() as { product_id: number; warehouse_id: number; level: number }[];

  const byProduct = new Map<number, Record<number, number>>();
  for (const s of sums) {
    const levels = byProduct.get(s.product_id) ?? {};
    levels[s.warehouse_id] = round3(s.level);
    byProduct.set(s.product_id, levels);
  }

  const rows = products.map((p): StockRow => {
    const levels = byProduct.get(p.id) ?? {};
    const total = round3(Object.values(levels).reduce((a, b) => a + b, 0));
    return { ...p, levels, total, low: total <= p.reorder_point };
  });
  return opts.lowOnly ? rows.filter((r) => r.low) : rows;
}

export function movementHistory(db: Database.Database, productId: number): MovementRow[] {
  return db
    .prepare(
      `SELECT m.*, w.code AS warehouse_code FROM movements m
       JOIN warehouses w ON w.id = m.warehouse_id
       WHERE m.product_id = ? ORDER BY m.created_at DESC, m.id DESC`,
    )
    .all(productId) as MovementRow[];
}

export interface MovementInput {
  productId: number;
  warehouseId: number;
  quantity: number;
  reference?: string | null;
  note?: string | null;
  createdAt?: string;
}

function insertMovement(
  db: Database.Database,
  type: string,
  input: MovementInput,
): number {
  const info = db
    .prepare(
      `INSERT INTO movements (product_id, warehouse_id, type, quantity, reference, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.productId,
      input.warehouseId,
      type,
      input.quantity,
      input.reference ?? null,
      input.note ?? null,
      input.createdAt ?? nowIso(),
    );
  return Number(info.lastInsertRowid);
}

/** Goods in (outside a PO). Quantity must be positive. */
export function recordReceipt(db: Database.Database, input: MovementInput): number {
  getProduct(db, input.productId);
  getWarehouse(db, input.warehouseId);
  return insertMovement(db, 'receipt', input);
}

/**
 * Stocktake correction. Quantity may be negative but must not take the
 * level below zero, and a note explaining the correction is mandatory
 * (enforced again here, not just at the API edge).
 */
export function recordAdjustment(db: Database.Database, input: MovementInput): number {
  if (!input.note || input.note.trim() === '') {
    throw new DomainError(422, 'Validation failed', [
      { field: 'note', message: 'Adjustments require a note' },
    ]);
  }
  getProduct(db, input.productId);
  getWarehouse(db, input.warehouseId);
  return db.transaction(() => {
    if (input.quantity < 0) {
      const level = stockLevel(db, input.productId, input.warehouseId);
      if (level + input.quantity < 0) {
        throw new DomainError(422, 'Validation failed', [
          {
            field: 'quantity',
            message: `Adjustment would take stock below zero (current level ${level})`,
          },
        ]);
      }
    }
    return insertMovement(db, 'adjustment', input);
  })();
}

export interface TransferInput {
  productId: number;
  fromWarehouseId: number;
  toWarehouseId: number;
  quantity: number;
  reference?: string | null;
  note?: string | null;
  createdAt?: string;
}

/**
 * Move stock between warehouses: one transfer_out (-qty) and one
 * transfer_in (+qty) appended in a single SQLite transaction, sharing a
 * reference. Total stock is conserved by construction; the transfer is
 * rejected if the source warehouse does not hold enough.
 */
export function transfer(
  db: Database.Database,
  input: TransferInput,
): { reference: string; outId: number; inId: number } {
  if (input.fromWarehouseId === input.toWarehouseId) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'to_warehouse_id', message: 'Source and destination warehouse must differ' },
    ]);
  }
  getProduct(db, input.productId);
  getWarehouse(db, input.fromWarehouseId);
  getWarehouse(db, input.toWarehouseId);

  return db.transaction(() => {
    const available = stockLevel(db, input.productId, input.fromWarehouseId);
    if (available < input.quantity) {
      throw new DomainError(422, 'Validation failed', [
        {
          field: 'quantity',
          message: `Insufficient stock in source warehouse (available ${available})`,
        },
      ]);
    }
    const next = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM movements').get() as {
      n: number;
    };
    const reference = input.reference?.trim() || `TRF-${String(next.n).padStart(4, '0')}`;
    const createdAt = input.createdAt ?? nowIso();
    const common = { reference, note: input.note, createdAt };
    const outId = insertMovement(db, 'transfer_out', {
      productId: input.productId,
      warehouseId: input.fromWarehouseId,
      quantity: -input.quantity,
      ...common,
    });
    const inId = insertMovement(db, 'transfer_in', {
      productId: input.productId,
      warehouseId: input.toWarehouseId,
      quantity: input.quantity,
      ...common,
    });
    return { reference, outId, inId };
  })();
}
