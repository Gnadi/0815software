import type {
  Cart,
  Category,
  FieldError,
  GuestOrder,
  OrderDetail,
  OrderRow,
  Product,
  ShopProduct,
  ShortageItem,
} from '../shared/types';

export class ApiError extends Error {
  status: number;
  details: FieldError[];
  items: ShortageItem[];

  constructor(status: number, message: string, details: FieldError[] = [], items: ShortageItem[] = []) {
    super(message);
    this.status = status;
    this.details = details;
    this.items = items;
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
    let items: ShortageItem[] = [];
    try {
      const body = (await res.json()) as {
        error?: string;
        details?: FieldError[];
        items?: ShortageItem[];
      };
      if (body.error) message = body.error;
      if (body.details) details = body.details;
      if (body.items) items = body.items;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, details, items);
  }
  return (await res.json()) as T;
}

function post(values?: Record<string, unknown>): RequestInit & { method: string } {
  return { method: 'POST', body: JSON.stringify(values ?? {}) };
}

export interface ShopCategory extends Pick<Category, 'id' | 'name' | 'position'> {
  product_count: number;
}

export interface AdminCategory extends Category {
  product_count: number;
}

export interface AdminProduct extends Product {
  category_name: string;
  order_line_count: number;
}

export interface CheckoutResult {
  ref: string;
  token: string;
  order: GuestOrder;
}

export const shop = {
  categories: () => request<{ categories: ShopCategory[] }>('/api/shop/categories'),
  products: (params: URLSearchParams) =>
    request<{ products: ShopProduct[] }>(`/api/shop/products?${params}`),
  product: (id: number) => request<ShopProduct>(`/api/shop/products/${id}`),

  cart: () => request<Cart>('/api/shop/cart'),
  addToCart: (productId: number, quantity: number) =>
    request<Cart>('/api/shop/cart/items', post({ product_id: productId, quantity })),
  setQuantity: (productId: number, quantity: number) =>
    request<Cart>(`/api/shop/cart/items/${productId}`, {
      method: 'PUT',
      body: JSON.stringify({ quantity }),
    }),
  removeFromCart: (productId: number) =>
    request<Cart>(`/api/shop/cart/items/${productId}`, { method: 'DELETE' }),

  checkout: (values: { name: string; email: string; address: string }) =>
    request<CheckoutResult>('/api/shop/checkout', post(values)),
  orderStatus: (ref: string, token: string) =>
    request<GuestOrder>(`/api/shop/orders/${encodeURIComponent(ref)}?token=${encodeURIComponent(token)}`),
};

export const admin = {
  login: (username: string, password: string) =>
    request<{ ok: true }>('/api/admin/login', post({ username, password })),
  logout: () => request<{ ok: true }>('/api/admin/logout', { method: 'POST' }),
  me: () => request<{ username: string }>('/api/admin/me'),

  categories: () => request<{ categories: AdminCategory[] }>('/api/admin/categories'),
  createCategory: (values: Record<string, unknown>) =>
    request<Category>('/api/admin/categories', post(values)),
  updateCategory: (id: number, values: Record<string, unknown>) =>
    request<Category>(`/api/admin/categories/${id}`, { method: 'PUT', body: JSON.stringify(values) }),
  deleteCategory: (id: number) =>
    request<{ ok: true }>(`/api/admin/categories/${id}`, { method: 'DELETE' }),

  products: (params: URLSearchParams) =>
    request<{ products: AdminProduct[] }>(`/api/admin/products?${params}`),
  createProduct: (values: Record<string, unknown>) =>
    request<Product>('/api/admin/products', post(values)),
  updateProduct: (id: number, values: Record<string, unknown>) =>
    request<Product>(`/api/admin/products/${id}`, { method: 'PUT', body: JSON.stringify(values) }),
  adjustStock: (id: number, delta: number) =>
    request<Product>(`/api/admin/products/${id}/stock`, post({ delta })),
  deleteProduct: (id: number) =>
    request<{ ok: true }>(`/api/admin/products/${id}`, { method: 'DELETE' }),

  orders: (params: URLSearchParams) => request<{ orders: OrderRow[] }>(`/api/admin/orders?${params}`),
  order: (id: number) => request<OrderDetail>(`/api/admin/orders/${id}`),
  setStatus: (id: number, status: string) =>
    request<OrderDetail>(`/api/admin/orders/${id}/status`, post({ status })),
  cancelOrder: (id: number) => request<OrderDetail>(`/api/admin/orders/${id}/cancel`, post()),
  markPaid: (id: number) => request<OrderDetail>(`/api/admin/orders/${id}/mark-paid`, post()),
};

/** URL of the CSV export with the current list filters (opens as a download). */
export function ordersCsvUrl(params: URLSearchParams): string {
  const query = params.toString();
  return `/api/admin/orders/export.csv${query ? `?${query}` : ''}`;
}
