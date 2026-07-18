/**
 * Domain types shared between the Express API and the React client.
 * The single source of truth for order statuses and VAT rates lives
 * here so server and client can never disagree.
 */

import type { Totals } from './money.js';

/**
 * Order lifecycle. Stored transitions are strictly forward, one step at
 * a time:
 *
 *   placed → confirmed → shipped → delivered
 *      │         │
 *      └─────────┴── cancel (restores stock) → cancelled
 *
 * Skipping a step (e.g. delivered before shipped) is a 422; cancelling
 * a shipped or delivered order is a 409 — the goods are gone.
 */
export const ORDER_STATUSES = ['placed', 'confirmed', 'shipped', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** The only allowed forward step per status (null = terminal). */
export const NEXT_STATUS: Record<OrderStatus, OrderStatus | null> = {
  placed: 'confirmed',
  confirmed: 'shipped',
  shipped: 'delivered',
  delivered: null,
  cancelled: null,
};

/** Derived from paid_at — never a stored enum that could drift. */
export const PAYMENT_STATUSES = ['unpaid', 'paid'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface Category {
  id: number;
  name: string;
  position: number;
  created_at: string;
}

export interface Product {
  id: number;
  sku: string;
  name: string;
  description: string;
  /** Gross (VAT-inclusive) sticker price in integer cents. */
  unit_price_cents: number;
  vat_rate: number;
  stock: number;
  category_id: number;
  /** Optional accent color (hex) for the generated SVG placeholder mark. */
  accent: string | null;
  /** Archived products are hidden from the shop but keep old orders intact. */
  archived: 0 | 1;
  created_at: string;
}

/** Product as the public shop sees it (joined category, no archived flag). */
export interface ShopProduct extends Omit<Product, 'archived'> {
  category_name: string;
}

/** One cart line, joined with the LIVE product (prices are not snapshotted in carts). */
export interface CartLine {
  product_id: number;
  sku: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
  vat_rate: number;
  accent: string | null;
  /** Live availability: current stock, 0 when the product was archived. */
  available: number;
  line_gross_cents: number;
}

export interface Cart {
  lines: CartLine[];
  totals: Totals;
  item_count: number;
}

/** SNAPSHOT of a product at checkout time — never re-reads the catalogue. */
export interface OrderLine {
  id: number;
  order_id: number;
  position: number;
  product_id: number;
  sku: string;
  name: string;
  quantity: number;
  unit_price_cents: number;
  vat_rate: number;
  line_gross_cents: number;
}

export interface OrderEvent {
  id: number;
  order_id: number;
  status: OrderStatus;
  at: string;
  note: string | null;
}

/** One row of the admin order list — money and payment status derived. */
export interface OrderRow {
  id: number;
  ref: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  customer_name: string;
  email: string;
  item_count: number;
  net_cents: number;
  vat_cents: number;
  gross_cents: number;
  created_at: string;
}

export interface OrderDetail extends OrderRow {
  address: string;
  paid_at: string | null;
  cancelled_at: string | null;
  lines: OrderLine[];
  vat_breakdown: Totals['by_rate'];
  events: OrderEvent[];
}

/** What a guest sees via the signed lookup link — no admin-only fields. */
export interface GuestOrder {
  ref: string;
  status: OrderStatus;
  payment_status: PaymentStatus;
  customer_name: string;
  created_at: string;
  lines: Pick<OrderLine, 'sku' | 'name' | 'quantity' | 'unit_price_cents' | 'vat_rate' | 'line_gross_cents'>[];
  totals: Totals;
  events: Pick<OrderEvent, 'status' | 'at'>[];
}

export interface FieldError {
  field: string;
  message: string;
}

/** A cart/checkout line that cannot be fulfilled at current stock. */
export interface ShortageItem {
  product_id: number;
  sku: string;
  name: string;
  requested: number;
  available: number;
}
