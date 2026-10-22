import type { DeliveryNote, FieldError, Me, OrderDetail, OrderRow, OrderStatus, Settings, SettingsResponse } from '../shared/types';

export class ApiError extends Error {
  status: number;
  details: FieldError[];

  constructor(status: number, message: string, details: FieldError[] = []) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let details: FieldError[] = [];
    try {
      const body = (await res.json()) as { error?: string; details?: FieldError[] };
      if (body.error) message = body.error;
      if (body.details) details = body.details;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, details);
  }
  return (await res.json()) as T;
}

function send(method: string, values?: Record<string, unknown>): RequestInit {
  return { method, body: values ? JSON.stringify(values) : undefined };
}

/**
 * What the server says about signing in: with single sign-on the credentials
 * belong to PS-01 Identity, without it to this module's own admin account.
 */
export type AuthMode = { sso: false } | { sso: true; org: string };

export const api = {
  login: (username: string, password: string) => request<{ ok: true }>('/api/login', send('POST', { username, password })),
  logout: () => request<{ ok: true }>('/api/logout', send('POST')),
  /** Which credentials this deployment accepts — readable before signing in. */
  authMode: () => request<AuthMode>('/api/auth-mode'),
  /** Who is signed in, and what they may do (`view` / `edit` / `manage`). */
  me: () => request<Me>('/api/me'),

  orders: (filter: { status?: OrderStatus; search?: string } = {}) => {
    const q = new URLSearchParams();
    if (filter.status) q.set('status', filter.status);
    if (filter.search) q.set('search', filter.search);
    return request<{ orders: OrderRow[] }>(`/api/orders${q.size > 0 ? `?${q}` : ''}`);
  },
  order: (id: number) => request<OrderDetail>(`/api/orders/${id}`),
  createOrder: (values: NewOrder) => request<OrderDetail>('/api/orders', send('POST', values as unknown as Record<string, unknown>)),
  /** Confirm an accepted MOD-13 offer as an order — 501 when no offer source is configured. */
  importOffer: (offerNumber: string) => request<OrderDetail & { imported: boolean }>('/api/orders/import-offer', send('POST', { offer_number: offerNumber })),
  cancelOrder: (id: number, reason: string) => request<OrderDetail>(`/api/orders/${id}/cancel`, send('POST', { reason })),
  deliver: (id: number, values: { delivered_on?: string; note?: string; lines: { order_line_id: number; quantity: number }[] }) =>
    request<DeliveryNote>(`/api/orders/${id}/delivery-notes`, send('POST', values)),
  setSku: (orderId: number, lineId: number, sku: string) =>
    request<OrderDetail>(`/api/orders/${orderId}/lines/${lineId}/sku`, send('PUT', { sku })),
  /** Reserve (again) an order's articles in MOD-03. */
  reserveStock: (orderId: number) => request<OrderDetail>(`/api/orders/${orderId}/reserve-stock`, send('POST')),
  /** Book (again) the goods issue of a delivery note in MOD-03. */
  bookStock: (noteId: number) => request<DeliveryNote>(`/api/delivery-notes/${noteId}/book-stock`, send('POST')),
  settings: () => request<SettingsResponse>('/api/settings'),
  saveSettings: (values: Settings) => request<SettingsResponse>('/api/settings', send('PUT', values as unknown as Record<string, unknown>)),
};

export interface NewOrder {
  customer: { name: string; contact_person?: string; email?: string; vat_id?: string; address?: string };
  customer_reference?: string;
  order_date?: string;
  note?: string;
  lines: { description: string; quantity: number; unit_price_cents: number; discount_percent: number; vat_rate: number; sku?: string }[];
}

export const orderPdfUrl = (id: number): string => `/api/orders/${id}/pdf`;
export const deliveryNotePdfUrl = (id: number): string => `/api/delivery-notes/${id}/pdf`;

/** "1.234,50 €" — the module's money format, also on the PDFs. */
export { fmtEur } from '../shared/money';

/** "1,5" — German decimals, three at most. */
export function fmtQty(quantity: number): string {
  return String(Math.round(quantity * 1000) / 1000).replace('.', ',');
}

/** "12,50" or "12.50" → 1250 cents; null when it is not an amount. */
export function parseEurToCents(raw: string): number | null {
  const cleaned = raw.trim().replace(/\s|€/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
  if (cleaned === '' || !/^\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  return Math.round(Number(cleaned) * 100);
}
