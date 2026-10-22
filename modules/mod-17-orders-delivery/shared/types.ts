/** Wire types shared by the server and the client. */

/** What is stored: an order is open until someone cancels the rest of it. */
export const STORED_ORDER_STATUSES = ['open', 'cancelled'] as const;
export type StoredOrderStatus = (typeof STORED_ORDER_STATUSES)[number];

/** What is shown — derived from the delivery notes on every read, never stored. */
export const ORDER_STATUSES = ['open', 'partially_delivered', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** The customer as the order was placed — a copy, frozen with the order. */
export interface OrderCustomer {
  name: string;
  contact_person: string | null;
  email: string | null;
  vat_id: string | null;
  address_lines: string[];
}

export interface OrderLine {
  id: number;
  position: number;
  description: string;
  quantity: number;
  unit_price_cents: number;
  discount_percent: number;
  vat_rate: number;
  /** round(quantity × unit price × (1 − discount/100)) — derived, never stored. */
  net_cents: number;
  /** Sum over the delivery notes — derived. */
  delivered_quantity: number;
  /** quantity − delivered, or 0 once the order is cancelled — derived. */
  remaining_quantity: number;
}

export interface Totals {
  net_cents: number;
  vat_cents: number;
  gross_cents: number;
}

export interface OrderRow {
  id: number;
  /** "AB-<year>-<seq>" — the order confirmation number, gapless per year. */
  number: string;
  status: OrderStatus;
  order_date: string;
  customer_name: string;
  /** The customer's own order number (Ihre Bestellung), if they gave one. */
  customer_reference: string | null;
  /** The offer this order came from, e.g. "mod-13-offers:ANG-2026-0004". */
  source_reference: string | null;
  totals: Totals;
  delivery_note_count: number;
  created_at: string;
}

export interface OrderEvent {
  id: number;
  type: string;
  detail: string | null;
  actor: string;
  at: string;
}

export interface OrderDetail extends OrderRow {
  customer: OrderCustomer;
  note: string | null;
  lines: OrderLine[];
  delivery_notes: DeliveryNote[];
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_by: string;
  events: OrderEvent[];
}

export interface DeliveryNoteLine {
  order_line_id: number;
  position: number;
  description: string;
  quantity: number;
}

/** A delivery that happened — numbered, append-only, never edited. */
export interface DeliveryNote {
  id: number;
  /** "LS-<year>-<seq>", gapless per year. */
  number: string;
  order_id: number;
  order_number: string;
  delivered_on: string;
  note: string | null;
  lines: DeliveryNoteLine[];
  created_by: string;
  created_at: string;
  /** When a billing module took this delivery over, and as what. Null until then. */
  invoiced_at: string | null;
  invoice_reference: string | null;
}

export interface FieldError {
  field: string;
  message: string;
}

/** What GET /api/me answers: who is signed in, and what they may do here. */
export interface Me {
  username: string;
  access: 'view' | 'edit' | 'manage';
}
