/**
 * Domain types shared between the Express API and the React client.
 * The single source of truth for movement types and purchase-order
 * statuses lives here so server and client can never disagree.
 */

/**
 * Ledger movement types. Quantities are stored SIGNED:
 *   receipt       +qty   goods arriving outside a PO (returns, found stock)
 *   transfer_out  -qty   one leg of an inter-warehouse transfer
 *   transfer_in   +qty   the other leg, always written in the same transaction
 *   adjustment    ±qty   stocktake correction — requires a note
 *   po_receipt    +qty   goods received against a purchase order line
 */
export const MOVEMENT_TYPES = [
  'receipt',
  'transfer_out',
  'transfer_in',
  'adjustment',
  'po_receipt',
] as const;
export type MovementType = (typeof MOVEMENT_TYPES)[number];

export const PO_STATUSES = ['draft', 'ordered', 'partially_received', 'received'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const UNITS = ['pcs', 'box', 'kg', 'm', 'l'] as const;
export type Unit = (typeof UNITS)[number];

export interface Warehouse {
  id: number;
  code: string;
  name: string;
}

export interface Product {
  id: number;
  sku: string;
  name: string;
  unit: Unit;
  reorder_point: number;
}

export interface Supplier {
  id: number;
  name: string;
  email: string | null;
}

export interface Movement {
  id: number;
  product_id: number;
  warehouse_id: number;
  type: MovementType;
  /** Signed quantity — negative for outbound movements. */
  quantity: number;
  reference: string | null;
  note: string | null;
  created_at: string;
}

/** Movement joined with warehouse code for history views. */
export interface MovementRow extends Movement {
  warehouse_code: string;
}

/** One row of the stock overview: a product with per-warehouse levels. */
export interface StockRow {
  id: number;
  sku: string;
  name: string;
  unit: Unit;
  reorder_point: number;
  /** Level per warehouse id (only warehouses with movements appear). */
  levels: Record<number, number>;
  total: number;
  low: boolean;
}

export interface PurchaseOrderLine {
  id: number;
  po_id: number;
  product_id: number;
  sku: string;
  product_name: string;
  unit: Unit;
  qty_ordered: number;
  qty_received: number;
}

export interface PurchaseOrder {
  id: number;
  po_number: string;
  supplier_id: number;
  supplier_name: string;
  status: PoStatus;
  created_at: string;
}

export interface PurchaseOrderDetail extends PurchaseOrder {
  lines: PurchaseOrderLine[];
}

export interface FieldError {
  field: string;
  message: string;
}
