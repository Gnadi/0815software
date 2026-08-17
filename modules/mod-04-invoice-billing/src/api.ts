import type {
  Customer,
  FieldError,
  InvoiceDetail,
  InvoiceRow,
  Ledger,
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

export interface CustomerRow extends Customer {
  invoice_count: number;
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

  customers: (search?: string) =>
    request<{ customers: CustomerRow[] }>(
      `/api/customers${search ? `?search=${encodeURIComponent(search)}` : ''}`,
    ),
  createCustomer: (values: Record<string, unknown>) =>
    request<Customer>('/api/customers', post(values)),
  updateCustomer: (id: number, values: Record<string, unknown>) =>
    request<Customer>(`/api/customers/${id}`, { method: 'PUT', body: JSON.stringify(values) }),
  deleteCustomer: (id: number) => request<{ ok: true }>(`/api/customers/${id}`, { method: 'DELETE' }),
  customerLedger: (id: number) => request<Ledger>(`/api/customers/${id}/ledger`),

  invoices: (params: URLSearchParams) =>
    request<{ invoices: InvoiceRow[]; today: string }>(`/api/invoices?${params}`),
  invoiceDetail: (id: number) => request<InvoiceDetail>(`/api/invoices/${id}`),
  createDraft: (values: Record<string, unknown>) =>
    request<InvoiceDetail>('/api/invoices', post(values)),
  /**
   * Bill an accepted offer from MOD-13. `imported` is false when this offer had
   * already been billed — the server is idempotent on the offer number, so the
   * UI can say "already billed" instead of creating a second invoice.
   */
  importOffer: (offerNumber: string) =>
    request<InvoiceDetail & { imported: boolean }>(
      '/api/invoices/import-offer',
      post({ offer_number: offerNumber }),
    ),
  updateDraft: (id: number, values: Record<string, unknown>) =>
    request<InvoiceDetail>(`/api/invoices/${id}`, { method: 'PUT', body: JSON.stringify(values) }),
  deleteDraft: (id: number) => request<{ ok: true }>(`/api/invoices/${id}`, { method: 'DELETE' }),
  finalize: (id: number) => request<InvoiceDetail>(`/api/invoices/${id}/finalize`, post()),
  cancel: (id: number, reason: string) =>
    request<InvoiceDetail>(`/api/invoices/${id}/cancel`, post({ reason })),
  recordPayment: (id: number, values: Record<string, unknown>) =>
    request<InvoiceDetail>(`/api/invoices/${id}/payments`, post(values)),
};

/** URL of the PDF for an invoice (opens in a new tab / downloads). */
export function invoicePdfUrl(id: number): string {
  return `/api/invoices/${id}/pdf`;
}
