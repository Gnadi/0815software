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
  /** MOD-03 article number; null for a service or an unmapped line (not booked). */
  sku: string | null;
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
  /**
   * The stock reservation in MOD-03, as it last answered: null while none
   * was asked for; `short` names what the warehouse cannot cover yet.
   */
  reservation: { status: 'reserved' | 'short' | 'failed' | 'released'; note: string | null; at: string } | null;
}

export interface DeliveryNoteLine {
  order_line_id: number;
  position: number;
  description: string;
  sku: string | null;
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
  /**
   * The goods issue in MOD-03: null while nothing has been booked (booking
   * off, no article numbers, or no inventory wired), `booked`, or `failed`
   * with the reason — which a retry clears.
   */
  stock_status: 'booked' | 'failed' | null;
  stock_warehouse: string | null;
  stock_at: string | null;
  stock_error: string | null;
}

/** Where a letterhead field comes from: this screen, PS-11's `self` party, or the environment. */
export type SellerSource = 'settings' | 'ps-11' | 'env';

/** What the admin sets on the Settings screen. Empty = fall back (see `source`). */
export interface Settings {
  seller_name: string | null;
  /** One line per entry. */
  seller_address: string[] | null;
  seller_vat_id: string | null;
  /** Book a goods issue in MOD-03 for every delivery note with article numbers. */
  stock_booking: boolean;
  /** The MOD-03 warehouse code goods are issued from. */
  stock_warehouse: string | null;
  /** Reserve the article lines in MOD-03 as soon as an order is confirmed. */
  stock_reservation: boolean;
}

export interface SettingsResponse {
  settings: Settings;
  /** The letterhead as the PDFs print it, and where each field comes from. */
  seller: { name: string; address_lines: string[]; vat_id: string };
  seller_source: { name: SellerSource; address_lines: SellerSource; vat_id: SellerSource };
  /** Whether MOD-03 is wired (INVENTORY_URL), and its warehouses when it answered. */
  inventory: { configured: boolean; warehouses: { code: string; name: string }[] | null; error: string | null };
  updated_at: string | null;
  updated_by: string | null;
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
