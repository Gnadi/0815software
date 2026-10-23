import type Database from 'better-sqlite3';
import type { FieldError, GoodsIssue } from '../shared/types.js';
import { DomainError, nowIso, round3 } from './ledger.js';

/**
 * Goods received against a purchase order in another module — the stock side
 * of a goods receipt in MOD-06 (Procurement). The mirror of goods-issues.ts.
 *
 * - **All or nothing.** Every SKU and the warehouse must exist; otherwise
 *   nothing is booked and the refusal names each line.
 * - **Once per receipt.** UNIQUE (source, reference): a retry returns the
 *   first booking instead of counting the goods in twice.
 * - **Ledger only.** One positive `receipt` movement per product with the
 *   receipt's reference and "<source> · <person>" as note. The PO's progress
 *   is the calling module's; this module's own purchase orders are untouched.
 */

export interface GoodsReceiptInput {
  source: string;
  reference: string;
  warehouseCode: string;
  actor: string;
  lines: { sku: string; quantity: number }[];
}

/** Same shape as a goods issue: who, where, which products, how many. */
export type GoodsReceipt = GoodsIssue;

function receiptById(db: Database.Database, id: number): GoodsReceipt {
  const row = db
    .prepare(
      `SELECT g.id, g.source, g.reference, w.code AS warehouse_code, g.actor, g.created_at, g.warehouse_id
         FROM goods_receipts g JOIN warehouses w ON w.id = g.warehouse_id WHERE g.id = ?`,
    )
    .get(id) as Omit<GoodsReceipt, 'lines'> & { warehouse_id: number };
  const lines = db
    .prepare(
      `SELECT p.sku, m.product_id, m.quantity FROM movements m JOIN products p ON p.id = m.product_id
        WHERE m.type = 'receipt' AND m.reference = ? AND m.warehouse_id = ? AND m.created_at = ? AND m.note = ?
        ORDER BY m.id`,
    )
    .all(row.reference, row.warehouse_id, row.created_at, `${row.source} · ${row.actor}`) as GoodsReceipt['lines'];
  const { warehouse_id: _w, ...receipt } = row;
  return { ...receipt, lines: lines.map((l) => ({ ...l, quantity: round3(l.quantity) })) };
}

export function recordGoodsReceipt(db: Database.Database, input: GoodsReceiptInput): { receipt: GoodsReceipt; replayed: boolean } {
  return db.transaction(() => {
    const existing = db
      .prepare('SELECT id FROM goods_receipts WHERE source = ? AND reference = ?')
      .get(input.source, input.reference) as { id: number } | undefined;
    if (existing) return { receipt: receiptById(db, existing.id), replayed: true };

    const errors: FieldError[] = [];
    const warehouse = db.prepare('SELECT id FROM warehouses WHERE code = ?').get(input.warehouseCode) as { id: number } | undefined;
    if (!warehouse) errors.push({ field: 'warehouse_code', message: `There is no warehouse ${input.warehouseCode}` });
    if (input.lines.length === 0) errors.push({ field: 'lines', message: 'A goods receipt receives at least one line' });
    // The same SKU on two lines is received once, summed.
    const byProduct = new Map<number, number>();
    input.lines.forEach((line, i) => {
      const product = db.prepare('SELECT id FROM products WHERE sku = ?').get(line.sku) as { id: number } | undefined;
      if (!product) {
        errors.push({ field: `lines[${i}].sku`, message: `There is no product with SKU ${line.sku}` });
        return;
      }
      byProduct.set(product.id, round3((byProduct.get(product.id) ?? 0) + line.quantity));
    });
    if (errors.length > 0) throw new DomainError(422, 'The goods cannot be received', errors);

    const at = nowIso();
    const info = db
      .prepare('INSERT INTO goods_receipts (source, reference, warehouse_id, actor, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.source, input.reference, warehouse!.id, input.actor, at);
    const insert = db.prepare(
      `INSERT INTO movements (product_id, warehouse_id, type, quantity, reference, note, created_at)
       VALUES (?, ?, 'receipt', ?, ?, ?, ?)`,
    );
    for (const [productId, quantity] of byProduct) {
      insert.run(productId, warehouse!.id, quantity, input.reference, `${input.source} · ${input.actor}`, at);
    }
    return { receipt: receiptById(db, Number(info.lastInsertRowid)), replayed: false };
  })();
}
