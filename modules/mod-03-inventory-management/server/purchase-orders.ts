import type Database from 'better-sqlite3';
import type {
  PoStatus,
  PurchaseOrder,
  PurchaseOrderDetail,
  PurchaseOrderLine,
} from '../shared/types.js';
import { DomainError, getWarehouse, nowIso, round3 } from './ledger.js';

interface PoRow {
  id: number;
  po_number: string;
  supplier_id: number;
  status: PoStatus;
  created_at: string;
}

function getPo(db: Database.Database, id: number): PoRow {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id = ?').get(id) as PoRow | undefined;
  if (!po) throw new DomainError(404, 'Purchase order not found');
  return po;
}

function poLines(db: Database.Database, poId: number): PurchaseOrderLine[] {
  return db
    .prepare(
      `SELECT l.id, l.po_id, l.product_id, p.sku, p.name AS product_name, p.unit,
              l.qty_ordered, l.qty_received
       FROM purchase_order_lines l JOIN products p ON p.id = l.product_id
       WHERE l.po_id = ? ORDER BY l.id`,
    )
    .all(poId) as PurchaseOrderLine[];
}

export function listPurchaseOrders(db: Database.Database): (PurchaseOrder & {
  line_count: number;
  qty_ordered: number;
  qty_received: number;
})[] {
  return db
    .prepare(
      `SELECT o.id, o.po_number, o.supplier_id, s.name AS supplier_name, o.status, o.created_at,
              COUNT(l.id) AS line_count,
              COALESCE(SUM(l.qty_ordered), 0) AS qty_ordered,
              COALESCE(SUM(l.qty_received), 0) AS qty_received
       FROM purchase_orders o
       JOIN suppliers s ON s.id = o.supplier_id
       LEFT JOIN purchase_order_lines l ON l.po_id = o.id
       GROUP BY o.id ORDER BY o.id DESC`,
    )
    .all() as (PurchaseOrder & { line_count: number; qty_ordered: number; qty_received: number })[];
}

export function purchaseOrderDetail(db: Database.Database, id: number): PurchaseOrderDetail {
  const po = getPo(db, id);
  const supplier = db.prepare('SELECT name FROM suppliers WHERE id = ?').get(po.supplier_id) as {
    name: string;
  };
  return { ...po, supplier_name: supplier.name, lines: poLines(db, id) };
}

export interface CreatePoInput {
  supplierId: number;
  lines: { productId: number; quantity: number }[];
  createdAt?: string;
}

/** Create a draft PO with lines and a generated PO number. Atomic. */
export function createPurchaseOrder(db: Database.Database, input: CreatePoInput): number {
  const supplier = db.prepare('SELECT id FROM suppliers WHERE id = ?').get(input.supplierId);
  if (!supplier) throw new DomainError(404, 'Supplier not found');
  for (const line of input.lines) {
    const product = db.prepare('SELECT id FROM products WHERE id = ?').get(line.productId);
    if (!product) throw new DomainError(404, `Product ${line.productId} not found`);
  }

  return db.transaction(() => {
    const next = db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM purchase_orders').get() as {
      n: number;
    };
    const info = db
      .prepare(
        `INSERT INTO purchase_orders (po_number, supplier_id, status, created_at)
         VALUES (?, ?, 'draft', ?)`,
      )
      .run(`PO-${String(1000 + next.n)}`, input.supplierId, input.createdAt ?? nowIso());
    const poId = Number(info.lastInsertRowid);
    const insertLine = db.prepare(
      'INSERT INTO purchase_order_lines (po_id, product_id, qty_ordered) VALUES (?, ?, ?)',
    );
    for (const line of input.lines) insertLine.run(poId, line.productId, line.quantity);
    return poId;
  })();
}

/** draft → ordered. Any other starting status is a conflict. */
export function markOrdered(db: Database.Database, id: number): void {
  const po = getPo(db, id);
  if (po.status !== 'draft') {
    throw new DomainError(409, `Only draft purchase orders can be marked ordered (status: ${po.status})`);
  }
  db.prepare("UPDATE purchase_orders SET status = 'ordered' WHERE id = ?").run(id);
}

/** Drafts can be deleted; anything ordered is history and stays. */
export function deleteDraft(db: Database.Database, id: number): void {
  const po = getPo(db, id);
  if (po.status !== 'draft') {
    throw new DomainError(409, `Only draft purchase orders can be deleted (status: ${po.status})`);
  }
  db.prepare('DELETE FROM purchase_orders WHERE id = ?').run(id);
}

export interface ReceiveInput {
  warehouseId: number;
  lines: { lineId: number; quantity: number }[];
  createdAt?: string;
}

/**
 * Receive goods against a PO. In ONE transaction:
 *   - append a po_receipt ledger movement per received line
 *   - bump qty_received on each line
 *   - recompute the PO status (partially_received / received)
 * Over-receipt (line total above qty_ordered) rejects the whole request.
 */
export function receivePurchaseOrder(
  db: Database.Database,
  poId: number,
  input: ReceiveInput,
): PoStatus {
  const po = getPo(db, poId);
  if (po.status !== 'ordered' && po.status !== 'partially_received') {
    throw new DomainError(409, `Purchase order cannot be received (status: ${po.status})`);
  }
  getWarehouse(db, input.warehouseId);
  if (input.lines.length === 0) {
    throw new DomainError(422, 'Validation failed', [
      { field: 'lines', message: 'At least one line with a quantity is required' },
    ]);
  }

  return db.transaction(() => {
    const lines = poLines(db, poId);
    const createdAt = input.createdAt ?? nowIso();
    for (const item of input.lines) {
      const line = lines.find((l) => l.id === item.lineId);
      if (!line) throw new DomainError(404, `Line ${item.lineId} does not belong to this purchase order`);
      const open = round3(line.qty_ordered - line.qty_received);
      if (item.quantity > open) {
        throw new DomainError(422, 'Validation failed', [
          {
            field: `line_${line.id}`,
            message: `Cannot receive ${item.quantity} ${line.unit} of ${line.sku} — only ${open} open`,
          },
        ]);
      }
      db.prepare(
        `INSERT INTO movements (product_id, warehouse_id, type, quantity, reference, note, created_at)
         VALUES (?, ?, 'po_receipt', ?, ?, NULL, ?)`,
      ).run(line.product_id, input.warehouseId, item.quantity, po.po_number, createdAt);
      db.prepare('UPDATE purchase_order_lines SET qty_received = qty_received + ? WHERE id = ?').run(
        item.quantity,
        line.id,
      );
    }

    const remaining = db
      .prepare(
        'SELECT COUNT(*) AS open FROM purchase_order_lines WHERE po_id = ? AND qty_received < qty_ordered',
      )
      .get(poId) as { open: number };
    const status: PoStatus = remaining.open === 0 ? 'received' : 'partially_received';
    db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(status, poId);
    return status;
  })();
}
