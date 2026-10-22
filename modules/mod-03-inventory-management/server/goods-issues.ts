import type Database from 'better-sqlite3';
import type { FieldError, GoodsIssue } from '../shared/types.js';
import { DomainError, nowIso, round3, stockLevel } from './ledger.js';
import { reservedQuantity } from './reservations.js';

/**
 * Goods issue for a delivery in another module — the stock side of a
 * delivery note (MOD-17). A machine call, but always on behalf of the person
 * who wrote the delivery note, who is recorded.
 *
 * - **All or nothing.** Every SKU must exist and every line must be covered
 *   by the stock in the warehouse; otherwise nothing is booked and the
 *   refusal names each line. Stock never goes below zero here, as with an
 *   adjustment.
 * - **Once per delivery.** UNIQUE (source, reference): a retry, or a second
 *   attempt after a timeout, returns the first booking instead of issuing
 *   the goods twice.
 * - **Ledger only.** One negative `goods_issue` movement per product, with
 *   the delivery note number as reference. Levels stay `SUM(quantity)`.
 */

export interface GoodsIssueInput {
  source: string;
  reference: string;
  warehouseCode: string;
  actor: string;
  lines: { sku: string; quantity: number }[];
  /** The order this delivery belongs to: its reservation is what the issue uses. */
  orderReference?: string | null;
}

function issueById(db: Database.Database, id: number): GoodsIssue {
  const row = db
    .prepare(
      `SELECT g.id, g.source, g.reference, w.code AS warehouse_code, g.actor, g.created_at, g.warehouse_id
         FROM goods_issues g JOIN warehouses w ON w.id = g.warehouse_id WHERE g.id = ?`,
    )
    .get(id) as Omit<GoodsIssue, 'lines'> & { warehouse_id: number };
  // The movements this issue wrote: its reference, warehouse, timestamp and
  // the "<source> · <actor>" note it stamped — two sources may reuse a number.
  const lines = db
    .prepare(
      `SELECT p.sku, m.product_id, -m.quantity AS quantity FROM movements m JOIN products p ON p.id = m.product_id
        WHERE m.type = 'goods_issue' AND m.reference = ? AND m.warehouse_id = ? AND m.created_at = ? AND m.note = ?
        ORDER BY m.id`,
    )
    .all(row.reference, row.warehouse_id, row.created_at, `${row.source} · ${row.actor}`) as GoodsIssue['lines'];
  const { warehouse_id: _w, ...issue } = row;
  return { ...issue, lines: lines.map((l) => ({ ...l, quantity: round3(l.quantity) })) };
}

export function recordGoodsIssue(db: Database.Database, input: GoodsIssueInput): { issue: GoodsIssue; replayed: boolean } {
  return db.transaction(() => {
    const existing = db
      .prepare('SELECT id FROM goods_issues WHERE source = ? AND reference = ?')
      .get(input.source, input.reference) as { id: number } | undefined;
    if (existing) return { issue: issueById(db, existing.id), replayed: true };

    const errors: FieldError[] = [];
    const warehouse = db.prepare('SELECT id FROM warehouses WHERE code = ?').get(input.warehouseCode) as { id: number } | undefined;
    if (!warehouse) errors.push({ field: 'warehouse_code', message: `There is no warehouse ${input.warehouseCode}` });
    if (input.lines.length === 0) errors.push({ field: 'lines', message: 'A goods issue issues at least one line' });

    // The same SKU on two lines is issued once, summed — and checked summed.
    const byProduct = new Map<number, { sku: string; quantity: number; index: number }>();
    input.lines.forEach((line, i) => {
      const product = db.prepare('SELECT id FROM products WHERE sku = ?').get(line.sku) as { id: number } | undefined;
      if (!product) {
        errors.push({ field: `lines[${i}].sku`, message: `There is no product with SKU ${line.sku}` });
        return;
      }
      const seen = byProduct.get(product.id);
      byProduct.set(product.id, { sku: line.sku, quantity: round3((seen?.quantity ?? 0) + line.quantity), index: seen?.index ?? i });
    });
    if (warehouse) {
      // What other orders have reserved is not this delivery's to take.
      const own = input.orderReference ? { source: input.source, reference: input.orderReference } : undefined;
      for (const [productId, line] of byProduct) {
        const level = stockLevel(db, productId, warehouse.id);
        const heldForOthers = reservedQuantity(db, productId, warehouse.id, own);
        const usable = round3(level - heldForOthers);
        if (usable < line.quantity) {
          errors.push({
            field: `lines[${line.index}].quantity`,
            message:
              heldForOthers > 0
                ? `Only ${Math.max(0, usable)} of ${line.sku} in ${input.warehouseCode} are free (${level} on hand, ${heldForOthers} reserved for other orders), not ${line.quantity}`
                : `Only ${level} of ${line.sku} in ${input.warehouseCode}, not ${line.quantity}`,
          });
        }
      }
    }
    if (errors.length > 0) throw new DomainError(422, 'The goods cannot be issued', errors);

    const at = nowIso();
    const info = db
      .prepare('INSERT INTO goods_issues (source, reference, warehouse_id, actor, created_at, order_reference) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.source, input.reference, warehouse!.id, input.actor, at, input.orderReference ?? null);
    const insert = db.prepare(
      `INSERT INTO movements (product_id, warehouse_id, type, quantity, reference, note, created_at)
       VALUES (?, ?, 'goods_issue', ?, ?, ?, ?)`,
    );
    for (const [productId, line] of byProduct) {
      insert.run(productId, warehouse!.id, -line.quantity, input.reference, `${input.source} · ${input.actor}`, at);
    }
    return { issue: issueById(db, Number(info.lastInsertRowid)), replayed: false };
  })();
}
