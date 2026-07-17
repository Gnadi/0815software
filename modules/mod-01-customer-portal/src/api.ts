import type {
  CustomerProfile,
  DocumentMeta,
  OrderDetailResponse,
  OrderSummary,
} from '../shared/types';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
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
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ customer: CustomerProfile }>('/api/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  me: () => request<{ customer: CustomerProfile }>('/api/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true }>('/api/me/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  orders: (params: URLSearchParams) =>
    request<{ orders: OrderSummary[] }>(`/api/orders?${params}`),
  order: (id: number) => request<OrderDetailResponse>(`/api/orders/${id}`),
  documents: () => request<{ documents: DocumentMeta[] }>('/api/documents'),
};

export function documentDownloadUrl(id: number): string {
  return `/api/documents/${id}/download`;
}
