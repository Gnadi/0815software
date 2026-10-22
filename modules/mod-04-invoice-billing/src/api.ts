import type { AccessLevel } from './access';
import type {
  BillRow,
  Creditor,
  CreditorRow,
  Customer,
  FieldError,
  InvoiceDetail,
  InvoiceRow,
  Ledger,
  PaymentConfig,
  PaymentRunDetail,
  PaymentRunRow,
  ReceivableOutcome,
  ReceivableSuggestions,
} from '../shared/types';
import type { EInvoiceProblem, EInvoiceProfile, SellerParty } from '../shared/einvoice';

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
  /**
   * What arrived on the bank account, matched against what is open.
   *
   * Throws `ApiError` with status 501 when no bank connection is configured —
   * which is not a failure but the standalone posture: incoming payments are
   * recorded on the invoice itself, as they always were.
   */
  receivableSuggestions: (range: { from?: string; to?: string } = {}) => {
    const query = new URLSearchParams();
    if (range.from) query.set('from', range.from);
    if (range.to) query.set('to', range.to);
    const suffix = query.toString();
    return request<ReceivableSuggestions>(`/api/receivables/suggestions${suffix === '' ? '' : `?${suffix}`}`);
  },
  /** Record what a human confirmed. Each application is independent. */
  applyReceivables: (
    applications: { booking_key: string; invoice_id: number; amount_cents: number; date: string; note?: string }[],
  ) => request<{ outcomes: ReceivableOutcome[] }>('/api/receivables/apply', post({ applications })),
  login: (username: string, password: string) =>
    request<{ ok: true }>('/api/login', post({ username, password })),
  logout: () => request<{ ok: true }>('/api/logout', { method: 'POST' }),
  /** Which credentials this deployment accepts — readable before signing in. */
  authMode: () => request<AuthMode>('/api/auth-mode'),
  me: () => request<{ username: string; access: AccessLevel }>('/api/me'),

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

  // ── E-invoices and bookkeeping exports ───────────────────────────────
  /** The seller as e-invoices see it, and what each profile still misses. */
  einvoiceConfig: () =>
    request<{ seller: SellerParty; problems: Record<EInvoiceProfile, EInvoiceProblem[]> }>('/api/einvoice-config'),
  /** Whether an issued invoice can be downloaded as XRechnung / ZUGFeRD, and what is missing. */
  einvoiceStatus: (id: number) => request<EInvoiceStatus>(`/api/invoices/${id}/einvoice`),
  /** The seller as the admin maintains it — each field with its source. */
  sellerSettings: () => request<SellerSettingsResponse>('/api/settings/seller'),
  saveSellerSettings: (values: Record<string, string>) =>
    request<SellerSettingsResponse>('/api/settings/seller', { method: 'PUT', body: JSON.stringify(values) }),
  accountingSettings: () => request<AccountingSettingsResponse>('/api/accounting-settings'),
  saveAccountingSettings: (settings: AccountingSettings) =>
    request<{ settings: AccountingSettings; updated_at: string | null; updated_by: string | null }>('/api/accounting-settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  /**
   * Fetch an export as a file. Not a plain link: a refused export answers 422
   * with the list of missing settings, which the screen has to show.
   */
  exportFile: async (path: string): Promise<{ blob: Blob; filename: string; bookings: number }> => {
    const res = await fetch(path, { credentials: 'same-origin' });
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
    const disposition = res.headers.get('Content-Disposition') ?? '';
    return {
      blob: await res.blob(),
      filename: /filename="([^"]+)"/.exec(disposition)?.[1] ?? 'export.csv',
      bookings: Number(res.headers.get('X-Booking-Count') ?? 0),
    };
  },

  // ── Payables: bills, and the bank file that pays them ────────────────
  /** The debtor account, and whether it is usable — read before offering a run. */
  paymentConfig: () => request<PaymentConfig>('/api/payment-config'),

  creditors: (search?: string) =>
    request<{ creditors: CreditorRow[] }>(
      `/api/creditors${search ? `?search=${encodeURIComponent(search)}` : ''}`,
    ),
  createCreditor: (values: Record<string, unknown>) => request<Creditor>('/api/creditors', post(values)),
  updateCreditor: (id: number, values: Record<string, unknown>) =>
    request<Creditor>(`/api/creditors/${id}`, { method: 'PUT', body: JSON.stringify(values) }),
  deleteCreditor: (id: number) => request<{ ok: true }>(`/api/creditors/${id}`, { method: 'DELETE' }),

  bills: (params: URLSearchParams) =>
    request<{ bills: BillRow[]; totals: PayablesTotals; today: string }>(`/api/bills?${params}`),
  createBill: (values: Record<string, unknown>) => request<BillRow>('/api/bills', post(values)),
  updateBill: (id: number, values: Record<string, unknown>) =>
    request<BillRow>(`/api/bills/${id}`, { method: 'PUT', body: JSON.stringify(values) }),
  deleteBill: (id: number) => request<{ ok: true }>(`/api/bills/${id}`, { method: 'DELETE' }),
  cancelBill: (id: number) => request<BillRow>(`/api/bills/${id}/cancel`, post()),
  markBillPaid: (id: number) => request<BillRow>(`/api/bills/${id}/mark-paid`, post()),

  paymentRuns: () =>
    request<{ runs: PaymentRunRow[]; config: PaymentConfig }>('/api/payment-runs'),
  paymentRun: (id: number) => request<PaymentRunDetail>(`/api/payment-runs/${id}`),
  /** Produce the file. The bills in it become `scheduled` — see shared/sepa.ts. */
  createPaymentRun: (billIds: number[], executionDate: string | null) =>
    request<PaymentRunDetail>('/api/payment-runs', post({ bill_ids: billIds, execution_date: executionDate })),
  submitRun: (id: number) => request<PaymentRunDetail>(`/api/payment-runs/${id}/submit`, post()),
  refreshRun: (id: number) => request<PaymentRunDetail>(`/api/payment-runs/${id}/refresh`, post()),
  markRunExecuted: (id: number) => request<PaymentRunDetail>(`/api/payment-runs/${id}/mark-executed`, post()),
  discardRun: (id: number) => request<PaymentRunDetail>(`/api/payment-runs/${id}/discard`, post()),
};

export type EInvoiceStatus =
  | { available: false; reason: string; parties_frozen: false }
  | {
      available: true;
      parties_frozen: boolean;
      cancellation: boolean;
      problems: Record<EInvoiceProfile, EInvoiceProblem[]>;
    };

export interface RevenueAccount {
  account: number | null;
  bu_key?: string | null;
  tax_code?: string | null;
}

export interface AccountingSettings {
  datev: {
    consultant_number: number | null;
    client_number: number | null;
    chart: 'SKR03' | 'SKR04';
    account_length: number;
    fiscal_year_start: string;
    lock: boolean;
    debtor_start: number;
    bank_account: number | null;
    revenue: Record<string, RevenueAccount>;
  };
  bmd: {
    debtor_start: number;
    symbol: string;
    date_format: 'dd.mm.yyyy' | 'yyyymmdd';
    revenue: Record<string, RevenueAccount>;
  };
}

export interface SellerFieldState {
  key: string;
  env: string;
  value: string | null;
  setting: string | null;
  source: 'settings' | 'platform' | 'env' | 'unset';
  locked: boolean;
}

export interface SellerSettingsResponse {
  fields: SellerFieldState[];
  platform_managed: boolean;
  updated_at: string | null;
  updated_by: string | null;
  seller: SellerParty;
  problems: Record<EInvoiceProfile, EInvoiceProblem[]>;
}

export interface AccountingSettingsResponse {
  settings: AccountingSettings;
  updated_at: string | null;
  updated_by: string | null;
  suggested: Record<'SKR03' | 'SKR04', Record<string, number>>;
  revenue_keys: string[];
  revenue_labels: Record<string, string>;
}

/** Download links for the e-invoice files of an issued invoice. */
export function xrechnungUrl(id: number, cancellation = false): string {
  return `/api/invoices/${id}/xrechnung.xml${cancellation ? '?document=cancellation' : ''}`;
}

export function zugferdUrl(id: number, cancellation = false): string {
  return `/api/invoices/${id}/zugferd.pdf${cancellation ? '?document=cancellation' : ''}`;
}

/** The payables figures the bills screen shows above its list. */
export interface PayablesTotals {
  open_count: number;
  open_cents: number;
  overdue_count: number;
  overdue_cents: number;
  scheduled_count: number;
  scheduled_cents: number;
}

/** URL of the PDF for an invoice (opens in a new tab / downloads). */
export function invoicePdfUrl(id: number): string {
  return `/api/invoices/${id}/pdf`;
}

/**
 * URL of a payment run's pain.001 file — a plain link, so the browser does the
 * download and the file never passes through JavaScript. The same URL always
 * yields the same bytes: the run is frozen (server/bills.ts).
 */
export function paymentRunXmlUrl(id: number): string {
  return `/api/payment-runs/${id}/sepa.xml`;
}
