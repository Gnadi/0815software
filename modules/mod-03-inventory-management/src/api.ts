import type {
  FieldError,
  MovementRow,
  Product,
  PurchaseOrder,
  PurchaseOrderDetail,
  StockRow,
  Supplier,
  Warehouse,
} from '../shared/types';

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

function post(values: Record<string, unknown>): RequestInit & { method: string } {
  return { method: 'POST', body: JSON.stringify(values) };
}

export interface PoListRow extends PurchaseOrder {
  line_count: number;
  qty_ordered: number;
  qty_received: number;
}

export const api = {
  login: (username: string, password: string) =>
    request<{ ok: true }>('/api/login', post({ username, password })),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  me: () => request<{ username: string }>('/api/me'),

  warehouses: () => request<{ warehouses: Warehouse[] }>('/api/warehouses'),
  suppliers: () => request<{ suppliers: Supplier[] }>('/api/suppliers'),

  stock: (params: URLSearchParams) => request<{ rows: StockRow[] }>(`/api/stock?${params}`),

  products: () => request<{ products: Product[] }>('/api/products'),
  productDetail: (id: number) =>
    request<{ product: Product; stock: { warehouse_id: number; code: string; name: string; level: number }[] }>(
      `/api/products/${id}`,
    ),
  productMovements: (id: number) =>
    request<{ movements: MovementRow[] }>(`/api/products/${id}/movements`),
  createProduct: (values: Record<string, unknown>) => request<Product>('/api/products', post(values)),
  updateProduct: (id: number, values: Record<string, unknown>) =>
    request<Product>(`/api/products/${id}`, { method: 'PUT', body: JSON.stringify(values) }),
  deleteProduct: (id: number) => request<{ ok: true }>(`/api/products/${id}`, { method: 'DELETE' }),

  createMovement: (values: Record<string, unknown>) =>
    request<MovementRow>('/api/movements', post(values)),
  createTransfer: (values: Record<string, unknown>) =>
    request<{ ok: true; reference: string }>('/api/transfers', post(values)),

  purchaseOrders: () => request<{ purchase_orders: PoListRow[] }>('/api/purchase-orders'),
  purchaseOrderDetail: (id: number) => request<PurchaseOrderDetail>(`/api/purchase-orders/${id}`),
  createPurchaseOrder: (values: Record<string, unknown>) =>
    request<PurchaseOrderDetail>('/api/purchase-orders', post(values)),
  markOrdered: (id: number) =>
    request<PurchaseOrderDetail>(`/api/purchase-orders/${id}/order`, { method: 'POST' }),
  receivePurchaseOrder: (id: number, values: Record<string, unknown>) =>
    request<PurchaseOrderDetail>(`/api/purchase-orders/${id}/receive`, post(values)),
  deletePurchaseOrder: (id: number) =>
    request<{ ok: true }>(`/api/purchase-orders/${id}`, { method: 'DELETE' }),
};

/** URL for the stock CSV download (respects search / low filter). */
export function stockExportUrl(params?: URLSearchParams): string {
  const query = params && params.size > 0 ? `?${params}` : '';
  return `/api/stock/export.csv${query}`;
}
