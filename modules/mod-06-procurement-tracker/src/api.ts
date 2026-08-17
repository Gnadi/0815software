import type {
  AppConfig,
  FieldError,
  PoDetail,
  PoRow,
  RfqDetail,
  RfqRow,
  Supplier,
  SupplierRow,
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

function post(values?: Record<string, unknown>): RequestInit & { method: string } {
  return { method: 'POST', body: JSON.stringify(values ?? {}) };
}

function put(values: Record<string, unknown>): RequestInit & { method: string } {
  return { method: 'PUT', body: JSON.stringify(values) };
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
  config: () => request<AppConfig>('/api/config'),

  suppliers: (search?: string) =>
    request<{ suppliers: SupplierRow[] }>(
      `/api/suppliers${search ? `?search=${encodeURIComponent(search)}` : ''}`,
    ),
  createSupplier: (values: Record<string, unknown>) =>
    request<Supplier>('/api/suppliers', post(values)),
  updateSupplier: (id: number, values: Record<string, unknown>) =>
    request<Supplier>(`/api/suppliers/${id}`, put(values)),
  deleteSupplier: (id: number) => request<{ ok: true }>(`/api/suppliers/${id}`, { method: 'DELETE' }),

  rfqs: (params: URLSearchParams) => request<{ rfqs: RfqRow[] }>(`/api/rfqs?${params}`),
  rfqDetail: (id: number) => request<RfqDetail>(`/api/rfqs/${id}`),
  createRfq: (values: Record<string, unknown>) => request<RfqDetail>('/api/rfqs', post(values)),
  updateRfq: (id: number, values: Record<string, unknown>) => request<RfqDetail>(`/api/rfqs/${id}`, put(values)),
  deleteRfq: (id: number) => request<{ ok: true }>(`/api/rfqs/${id}`, { method: 'DELETE' }),
  invite: (rfqId: number, supplierId: number) =>
    request<RfqDetail>(`/api/rfqs/${rfqId}/invitations`, post({ supplier_id: supplierId })),
  upsertQuote: (rfqId: number, supplierId: number, values: Record<string, unknown>) =>
    request<RfqDetail>(`/api/rfqs/${rfqId}/quotes/${supplierId}`, put(values)),
  award: (rfqId: number, supplierId: number) =>
    request<{ rfq: RfqDetail; po: PoDetail }>(`/api/rfqs/${rfqId}/award`, post({ supplier_id: supplierId })),
  closeRfq: (rfqId: number) => request<RfqDetail>(`/api/rfqs/${rfqId}/close`, post()),

  pos: (params: URLSearchParams) => request<{ pos: PoRow[] }>(`/api/pos?${params}`),
  poDetail: (id: number) => request<PoDetail>(`/api/pos/${id}`),
  createPo: (values: Record<string, unknown>) => request<PoDetail>('/api/pos', post(values)),
  updatePo: (id: number, values: Record<string, unknown>) => request<PoDetail>(`/api/pos/${id}`, put(values)),
  deletePo: (id: number) => request<{ ok: true }>(`/api/pos/${id}`, { method: 'DELETE' }),
  submitPo: (id: number) => request<PoDetail>(`/api/pos/${id}/submit`, post()),
  returnToDraft: (id: number) => request<PoDetail>(`/api/pos/${id}/return-to-draft`, post()),
  approvePo: (id: number, values: Record<string, unknown>) =>
    request<PoDetail>(`/api/pos/${id}/approvals`, post(values)),
  rejectPo: (id: number, values: Record<string, unknown>) =>
    request<PoDetail>(`/api/pos/${id}/reject`, post(values)),
  markOrdered: (id: number) => request<PoDetail>(`/api/pos/${id}/mark-ordered`, post()),
  closePo: (id: number) => request<PoDetail>(`/api/pos/${id}/close`, post()),
};

/** URL of a CSV export through a profile (triggers a download). */
export function exportCsvUrl(profile: string): string {
  return `/api/export/pos.csv?profile=${encodeURIComponent(profile)}`;
}
