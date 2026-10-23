import type Database from 'better-sqlite3';
import type { FieldError, Reservation, ReservationOutcome } from '../shared/types.js';
import { DomainError, nowIso, round3, stockLevel } from './ledger.js';

/**
 * Reservations — stock promised to an order before it is delivered.
 *
 * - **Derived, never stored: what is still reserved.** A reservation records
 *   what the order needs in total. Still reserved = that minus what goods
 *   issues for the same order (source + order reference) have taken. A
 *   delivery note lowers it; nothing has to remember to.
 * - **Available = on hand − still reserved**, per product and warehouse. It
 *   may go below zero: an order is a fact even when stock is short, and a
 *   negative available is the shortage made visible, not an error.
 * - **A goods issue respects other orders.** It may take what is on hand
 *   minus what is still reserved for OTHER orders — its own reservation is
 *   exactly what it is meant to use (server/goods-issues.ts).
 * - **Setting is idempotent.** PUT the order's lines; products no longer on
 *   it are released. Releasing (a cancelled order) is idempotent too.
 */

interface Row {
  id: number;
  source: string;
  reference: string;
  product_id: number;
  warehouse_id: number;
  quantity: number;
  actor: string;
  created_at: string;
  updated_at: string;
  released_at: string | null;
}

/** What goods issues for this order have taken of this product, in this warehouse. */
function issuedFor(db: Database.Database, source: string, orderReference: string, productId: number, warehouseId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(-SUM(m.quantity), 0) AS issued
         FROM goods_issues g
         JOIN movements m ON m.type = 'goods_issue' AND m.reference = g.reference AND m.warehouse_id = g.warehouse_id
                         AND m.created_at = g.created_at AND m.note = g.source || ' · ' || g.actor
        WHERE g.source = ? AND g.order_reference = ? AND m.product_id = ? AND g.warehouse_id = ?`,
    )
    .get(source, orderReference, productId, warehouseId) as { issued: number };
  return round3(row.issued);
}

function openOf(db: Database.Database, row: Row): number {
  if (row.released_at !== null) return 0;
  return round3(Math.max(0, row.quantity - issuedFor(db, row.source, row.reference, row.product_id, row.warehouse_id)));
}

/** Still reserved for a product in a warehouse — optionally leaving one order out. */
export function reservedQuantity(
  db: Database.Database,
  productId: number,
  warehouseId: number,
  except?: { source: string; reference: string },
): number {
  const rows = db
    .prepare('SELECT * FROM reservations WHERE product_id = ? AND warehouse_id = ? AND released_at IS NULL')
    .all(productId, warehouseId) as Row[];
  return round3(
    rows
      .filter((r) => !(except && r.source === except.source && r.reference === except.reference))
      .reduce((sum, r) => sum + openOf(db, r), 0),
  );
}

function toReservation(db: Database.Database, row: Row): Reservation {
  const product = db.prepare('SELECT sku, name FROM products WHERE id = ?').get(row.product_id) as { sku: string; name: string };
  const warehouse = db.prepare('SELECT code FROM warehouses WHERE id = ?').get(row.warehouse_id) as { code: string };
  return {
    id: row.id,
    source: row.source,
    reference: row.reference,
    sku: product.sku,
    product_name: product.name,
    warehouse_code: warehouse.code,
    quantity: row.quantity,
    open: openOf(db, row),
    actor: row.actor,
    updated_at: row.updated_at,
  };
}

/** Still reserved per product over all warehouses — for the stock overview. */
export function reservedByProduct(db: Database.Database): Map<number, number> {
  const rows = db.prepare('SELECT * FROM reservations WHERE released_at IS NULL').all() as Row[];
  const out = new Map<number, number>();
  for (const row of rows) out.set(row.product_id, round3((out.get(row.product_id) ?? 0) + openOf(db, row)));
  return out;
}

/** Every reservation with something still reserved, oldest first. */
export function listReservations(db: Database.Database): Reservation[] {
  const rows = db.prepare('SELECT * FROM reservations WHERE released_at IS NULL ORDER BY created_at, id').all() as Row[];
  return rows.map((r) => toReservation(db, r)).filter((r) => r.open > 0);
}

export interface ReserveInput {
  source: string;
  reference: string;
  warehouseCode: string;
  actor: string;
  lines: { sku: string; quantity: number }[];
}

/**
 * Set what an order reserves. Unknown SKUs or warehouse refuse the whole
 * call (a data error to fix); a shortage does not (see above) — it is
 * reported per product.
 */
export function setReservations(db: Database.Database, input: ReserveInput): ReservationOutcome {
  return db.transaction((): ReservationOutcome => {
    const errors: FieldError[] = [];
    const warehouse = db.prepare('SELECT id FROM warehouses WHERE code = ?').get(input.warehouseCode) as { id: number } | undefined;
    if (!warehouse) errors.push({ field: 'warehouse_code', message: `There is no warehouse ${input.warehouseCode}` });
    const wanted = new Map<number, { sku: string; quantity: number }>();
    input.lines.forEach((line, i) => {
      const product = db.prepare('SELECT id FROM products WHERE sku = ?').get(line.sku) as { id: number } | undefined;
      if (!product) {
        errors.push({ field: `lines[${i}].sku`, message: `There is no product with SKU ${line.sku}` });
        return;
      }
      const seen = wanted.get(product.id);
      wanted.set(product.id, { sku: line.sku, quantity: round3((seen?.quantity ?? 0) + line.quantity) });
    });
    if (errors.length > 0) throw new DomainError(422, 'The stock cannot be reserved', errors);

    const at = nowIso();
    const existing = db
      .prepare('SELECT * FROM reservations WHERE source = ? AND reference = ?')
      .all(input.source, input.reference) as Row[];
    // Products no longer on the order: released.
    for (const row of existing) {
      if (!wanted.has(row.product_id) && row.released_at === null) {
        db.prepare('UPDATE reservations SET released_at = ?, released_by = ? WHERE id = ?').run(at, input.actor, row.id);
      }
    }
    const upsert = db.prepare(
      `INSERT INTO reservations (source, reference, product_id, warehouse_id, quantity, actor, created_at, updated_at)
       VALUES (@source, @reference, @product, @warehouse, @quantity, @actor, @at, @at)
       ON CONFLICT (source, reference, product_id) DO UPDATE SET
         warehouse_id = excluded.warehouse_id, quantity = excluded.quantity, actor = excluded.actor,
         updated_at = excluded.updated_at, released_at = NULL, released_by = NULL`,
    );
    for (const [productId, line] of wanted) {
      upsert.run({ source: input.source, reference: input.reference, product: productId, warehouse: warehouse!.id, quantity: line.quantity, actor: input.actor, at });
    }

    const reservations = (
      db.prepare('SELECT * FROM reservations WHERE source = ? AND reference = ? AND released_at IS NULL ORDER BY id').all(input.source, input.reference) as Row[]
    ).map((r) => toReservation(db, r));
    const short = reservations.flatMap((r) => {
      const productId = (db.prepare('SELECT id FROM products WHERE sku = ?').get(r.sku) as { id: number }).id;
      const free = round3(stockLevel(db, productId, warehouse!.id) - reservedQuantity(db, productId, warehouse!.id, input));
      return r.open > free ? [{ sku: r.sku, open: r.open, available: Math.max(0, free), missing: round3(r.open - Math.max(0, free)) }] : [];
    });
    return { reservations, short };
  })();
}

/** Release everything an order reserved. Idempotent. */
export function releaseReservations(db: Database.Database, source: string, reference: string, actor: string): number {
  return db
    .prepare('UPDATE reservations SET released_at = ?, released_by = ? WHERE source = ? AND reference = ? AND released_at IS NULL')
    .run(nowIso(), actor, source, reference).changes;
}
