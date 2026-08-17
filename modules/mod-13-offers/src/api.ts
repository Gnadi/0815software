import type {
  Customer,
  DashboardStats,
  FieldError,
  OfferDetail,
  OfferRow,
  PublicOffer,
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
      const b = (await res.json()) as { error?: string; details?: FieldError[] };
      if (b.error) message = b.error;
      if (b.details) details = b.details;
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, message, details);
  }
  return (await res.json()) as T;
}

function post(values?: Record<string, unknown>): RequestInit & { method: string } {
  return { method: 'POST', body: JSON.stringify(values ?? {}) };
}

export interface CustomerRow extends Customer {
  offer_count: number;
}

/**
 * What the server says about signing in: with single sign-on the credentials
 * belong to PS-01 Identity, without it to this module's own admin account.
 */
export type AuthMode = { sso: false } | { sso: true; org: string };

export const api = {
  login: (username: string, password: string) =>
    request<{ ok: true }>('/api/login', post({ username, password })),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  /** Which credentials this deployment accepts — readable before signing in. */
  authMode: () => request<AuthMode>('/api/auth-mode'),
  me: () => request<{ username: string }>('/api/me'),

  stats: (period?: number) =>
    request<DashboardStats>(`/api/stats${period ? `?period=${period}` : ''}`),

  customers: (search?: string, includeArchived = false) => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (includeArchived) params.set('archived', '1');
    const q = params.toString();
    return request<{ customers: CustomerRow[] }>(`/api/customers${q ? `?${q}` : ''}`);
  },
  createCustomer: (values: Record<string, unknown>) =>
    request<Customer>('/api/customers', post(values)),
  updateCustomer: (id: number, values: Record<string, unknown>) =>
    request<Customer>(`/api/customers/${id}`, { method: 'PUT', body: JSON.stringify(values) }),
  deleteCustomer: (id: number) => request<{ ok: true }>(`/api/customers/${id}`, { method: 'DELETE' }),
  archiveCustomer: (id: number) => request<Customer>(`/api/customers/${id}/archive`, post()),
  unarchiveCustomer: (id: number) => request<Customer>(`/api/customers/${id}/unarchive`, post()),

  offers: (params: URLSearchParams) =>
    request<{ offers: OfferRow[]; today: string }>(`/api/offers?${params}`),
  offerDetail: (id: number) => request<OfferDetail>(`/api/offers/${id}`),
  createDraft: (values: Record<string, unknown>) =>
    request<OfferDetail>('/api/offers', post(values)),
  updateDraft: (id: number, values: Record<string, unknown>) =>
    request<OfferDetail>(`/api/offers/${id}`, { method: 'PUT', body: JSON.stringify(values) }),
  deleteDraft: (id: number) => request<{ ok: true }>(`/api/offers/${id}`, { method: 'DELETE' }),
  send: (id: number) => request<OfferDetail>(`/api/offers/${id}/send`, post()),
  withdraw: (id: number, reason: string) =>
    request<OfferDetail>(`/api/offers/${id}/withdraw`, post({ reason })),
  accept: (id: number, note?: string) =>
    request<OfferDetail>(`/api/offers/${id}/accept`, post({ note })),
  reject: (id: number, note?: string) =>
    request<OfferDetail>(`/api/offers/${id}/reject`, post({ note })),
  revise: (id: number) => request<OfferDetail>(`/api/offers/${id}/revise`, post()),

  // Public acceptance link (no session).
  publicOffer: (ref: string, token: string) =>
    request<PublicOffer>(`/api/public/offers/${encodeURIComponent(ref)}?token=${encodeURIComponent(token)}`),
  publicAccept: (ref: string, token: string, note: string) =>
    request<PublicOffer>(
      `/api/public/offers/${encodeURIComponent(ref)}/accept?token=${encodeURIComponent(token)}`,
      post({ note }),
    ),
  publicReject: (ref: string, token: string, note: string) =>
    request<PublicOffer>(
      `/api/public/offers/${encodeURIComponent(ref)}/reject?token=${encodeURIComponent(token)}`,
      post({ note }),
    ),
};

/** URL of the PDF for an offer (opens in a new tab / downloads). */
export function offerPdfUrl(id: number): string {
  return `/api/offers/${id}/pdf`;
}

/** URL of the CSV export for the current filter. */
export function offersCsvUrl(params: URLSearchParams): string {
  const q = params.toString();
  return `/api/offers/export.csv${q ? `?${q}` : ''}`;
}
