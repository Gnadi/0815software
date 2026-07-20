/**
 * Types shared between the API server and the React client.
 * The wire format of every /api response is described here.
 */

export const ORDER_STATUSES = ['placed', 'confirmed', 'shipped', 'delivered', 'cancelled'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

export interface CustomerProfile {
  id: number;
  email: string;
  name: string;
  company: string;
  created_at: string;
}

export interface OrderSummary {
  id: number;
  order_no: string;
  status: OrderStatus;
  currency: string;
  total_cents: number;
  placed_at: string;
  item_count: number;
  document_count: number;
}

export interface OrderItem {
  id: number;
  sku: string;
  description: string;
  quantity: number;
  unit_price_cents: number;
}

export interface OrderEvent {
  id: number;
  status: OrderStatus;
  at: string;
  note: string | null;
}

export interface DocumentMeta {
  id: number;
  order_id: number | null;
  order_no: string | null;
  doc_type: string;
  title: string;
  filename: string;
  size_bytes: number;
  created_at: string;
}

export interface OrderDetailResponse {
  order: OrderSummary;
  items: OrderItem[];
  events: OrderEvent[];
  documents: DocumentMeta[];
}

/** Format an integer amount of cents as e.g. "1,298.00 EUR". */
export function formatMoney(cents: number, currency: string): string {
  const units = (cents / 100).toLocaleString('en-IE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${units} ${currency}`;
}
