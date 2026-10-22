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
import type { EInvoiceProblem, SellerParty } from '../shared/einvoice';
import type { EInvoiceFormat } from '../shared/ebinterface';
import type { DunningNotice, DunningRow, DunningSettings } from '../shared/types';
import type { CreditNote, EInvoiceFormatChoice, RecurringInterval, RecurringTemplate, TaxExemptionCategory } from '../shared/types';

/** What the recurring-template form sends: the schedule plus a draft's fields. */
export interface RecurringPayload {
  name: string;
  customer_id: number;
  interval: RecurringInterval;
  start_date: string;
  end_date: string | null;
  active: boolean;
  payment_terms_days: number;
  note: string | null;
  buyer_reference: string | null;
  tax_exemption_category: TaxExemptionCategory | '' | null;
  tax_exemption_reason: string | null;
  lines: { description: string; quantity: number; unit_price_cents: number; vat_rate: number }[];
}

interface GeneratedDraft {
  template_id: number;
  period_start: string;
  period_end: string;
  invoice_id: number;
}

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
  /** Bill one delivery note from MOD-17 — idempotent on its number, like an offer. */
  importDeliveryNote: (number: string) =>
    request<InvoiceDetail & { imported: boolean }>(
      '/api/invoices/import-delivery-note',
      post({ delivery_note_number: number }),
    ),
  updateDraft: (id: number, values: Record<string, unknown>) =>
    request<InvoiceDetail>(`/api/invoices/${id}`, { method: 'PUT', body: JSON.stringify(values) }),
  deleteDraft: (id: number) => request<{ ok: true }>(`/api/invoices/${id}`, { method: 'DELETE' }),
  finalize: (id: number) => request<InvoiceDetail>(`/api/invoices/${id}/finalize`, post()),
  /** A partial credit note — issued at once, never changed. */
  issueCreditNote: (
    id: number,
    payload: { reason: string; issue_date?: string; lines: { description: string; quantity: number; unit_price_cents: number; vat_rate: number }[] },
  ) => request<CreditNote>(`/api/invoices/${id}/credit-notes`, { method: 'POST', body: JSON.stringify(payload) }),
  cancel: (id: number, reason: string) =>
    request<InvoiceDetail>(`/api/invoices/${id}/cancel`, post({ reason })),
  recordPayment: (id: number, values: Record<string, unknown>) =>
    request<InvoiceDetail>(`/api/invoices/${id}/payments`, post(values)),

  // ── E-invoices and bookkeeping exports ───────────────────────────────
  /** The seller as e-invoices see it, and what each profile still misses. */
  einvoiceConfig: () =>
    request<{ seller: SellerParty; problems: Record<EInvoiceFormat, EInvoiceProblem[]> }>('/api/einvoice-config'),
  /** Whether an issued invoice can be downloaded as XRechnung / ZUGFeRD, and what is missing. */
  einvoiceStatus: (id: number) => request<EInvoiceStatus>(`/api/invoices/${id}/einvoice`),
  /** The seller as the admin maintains it — each field with its source. */
  sellerSettings: () => request<SellerSettingsResponse>('/api/settings/seller'),
  saveSellerSettings: (values: Record<string, string>) =>
    request<SellerSettingsResponse>('/api/settings/seller', { method: 'PUT', body: JSON.stringify(values) }),
  /** Overdue invoices and where each stands (derived), with the dunning settings. */
  dunning: () => request<{ rows: DunningRow[]; settings: DunningSettings }>('/api/dunning'),
  issueDunningNotice: (invoiceId: number) =>
    request<DunningNotice>(`/api/invoices/${invoiceId}/dunning-notices`, { method: 'POST' }),
  /** Every invoice whose next notice is due — `manage`. */
  dunningRun: () => request<{ issued: DunningNotice[] }>('/api/dunning/run', { method: 'POST' }),
  saveDunningSettings: (settings: DunningSettings) =>
    request<{ settings: DunningSettings; updated_at: string | null; updated_by: string | null }>('/api/dunning-settings', {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),
  /** Recurring templates, each with its due periods (derived). */
  recurring: () => request<{ templates: RecurringTemplate[]; today: string }>('/api/recurring'),
  createRecurring: (payload: RecurringPayload) =>
    request<RecurringTemplate>('/api/recurring', { method: 'POST', body: JSON.stringify(payload) }),
  updateRecurring: (id: number, payload: RecurringPayload) =>
    request<RecurringTemplate>(`/api/recurring/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteRecurring: (id: number) => request<{ ok: true }>(`/api/recurring/${id}`, { method: 'DELETE' }),
  generateRecurring: (id: number) =>
    request<{ created: GeneratedDraft[]; template: RecurringTemplate }>(`/api/recurring/${id}/generate`, { method: 'POST' }),
  /** Drafts for every template's due periods — `manage`. */
  recurringRun: () => request<{ created: GeneratedDraft[] }>('/api/recurring/run', { method: 'POST' }),
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

/** A file that went out: stored at its first download and served unchanged since. */
export interface IssuedDocumentInfo {
  document: string;
  format: EInvoiceFormat;
  number: string;
  filename: string;
  sha256: string;
  renderer: string;
  created_at: string;
  created_by: string;
}

/**
 * For a draft, what each format would refuse if it were sent now; for an
 * issued invoice, what it refuses and which files already went out. `format`
 * is the customer's — set, a draft is refused until it renders in it.
 */
export type EInvoiceStatus =
  | {
      available: false;
      reason: string;
      parties_frozen: false;
      format: EInvoiceFormatChoice | null;
      problems: Record<EInvoiceFormat, EInvoiceProblem[]>;
    }
  | {
      available: true;
      format: EInvoiceFormatChoice | null;
      parties_frozen: boolean;
      cancellation: boolean;
      problems: Record<EInvoiceFormat, EInvoiceProblem[]>;
      issued: IssuedDocumentInfo[];
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
  problems: Record<EInvoiceFormat, EInvoiceProblem[]>;
}

export interface AccountingSettingsResponse {
  settings: AccountingSettings;
  updated_at: string | null;
  updated_by: string | null;
  suggested: Record<'SKR03' | 'SKR04', Record<string, number>>;
  revenue_keys: string[];
  revenue_labels: Record<string, string>;
}

/** The letter of a dunning notice, as it went out. */
export function dunningLetterUrl(noticeId: number): string {
  return `/api/dunning-notices/${noticeId}/pdf`;
}

/** Which document of an invoice: itself, its cancellation, or a partial credit note (by id). */
export type EInvoiceDocument = 'invoice' | 'cancellation' | number;

function documentQuery(document: EInvoiceDocument): string {
  if (typeof document === 'number') return `?credit_note=${document}`;
  return document === 'cancellation' ? '?document=cancellation' : '';
}

/** Download links for the e-invoice files of an issued invoice. */
export function xrechnungUrl(id: number, document: EInvoiceDocument = 'invoice'): string {
  return `/api/invoices/${id}/xrechnung.xml${documentQuery(document)}`;
}

/** ebInterface 6.1 — the Austrian e-invoice (e-rechnung.gv.at). */
export function ebInterfaceUrl(id: number, document: EInvoiceDocument = 'invoice'): string {
  return `/api/invoices/${id}/ebinterface.xml${documentQuery(document)}`;
}

export function zugferdUrl(id: number, document: EInvoiceDocument = 'invoice'): string {
  return `/api/invoices/${id}/zugferd.pdf${documentQuery(document)}`;
}

/** A partial credit note as a plain PDF. */
export function creditNotePdfUrl(invoiceId: number, creditNoteId: number): string {
  return `/api/invoices/${invoiceId}/credit-notes/${creditNoteId}/pdf`;
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
