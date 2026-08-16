/**
 * Domain types shared between the Express API and the React client.
 * The single source of truth for statuses and VAT rates lives here so
 * server and client can never disagree.
 */

/**
 * STORED lifecycle status. Only three values ever hit the database:
 *   draft      no number yet, fully editable, deletable
 *   sent       number assigned, immutable, payments allowed
 *   cancelled  keeps its number forever, nothing else allowed
 * "paid" is NOT stored — it is derived (a sent invoice whose payments
 * cover the gross total), so it can never drift out of sync.
 */
export const STORED_STATUSES = ['draft', 'sent', 'cancelled'] as const;
export type StoredStatus = (typeof STORED_STATUSES)[number];

/** Derived lifecycle status as reported by the API. */
export const STATUSES = ['draft', 'sent', 'paid', 'cancelled'] as const;
export type InvoiceStatus = (typeof STATUSES)[number];

/** Derived payment status — sum of payments vs. gross total. */
export const PAYMENT_STATUSES = ['unpaid', 'partially_paid', 'paid'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface Customer {
  id: number;
  name: string;
  email: string | null;
  vat_id: string | null;
  address: string | null;
  created_at: string;
}

/**
 * VAT category (UNTDID 5305), for structured e-invoicing.
 *
 * `S` standard · `Z` zero rated · `E` exempt · `AE` reverse charge ·
 * `K` intra-community · `G` export · `O` outside the scope of VAT.
 *
 * Only meaningful at a 0 % rate: every category here except `S` carries 0 %,
 * and all but `Z` legally require a stated reason. A rate above 0 is always
 * `S` and derives it, so the field is only ever set on a 0 % line.
 */
export const VAT_CATEGORIES = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O'] as const;
export type VatCategory = (typeof VAT_CATEGORIES)[number];

/** Categories EN 16931 requires an exemption reason for. */
export const REASON_REQUIRED_CATEGORIES: readonly VatCategory[] = ['E', 'AE', 'K', 'G', 'O'];

export interface InvoiceLine {
  id: number;
  invoice_id: number;
  position: number;
  description: string;
  quantity: number;
  unit_price_cents: number;
  vat_rate: number;
  /**
   * Derived for a rate above 0 (always `S`), stored for a 0 % line, and `null`
   * when nobody has said yet — which is an honest answer, not a default.
   */
  vat_category: VatCategory | null;
  /** Why no VAT is charged. Only ever set on a 0 % line. */
  vat_exemption_reason?: string | null;
  /** Derived: round(quantity × unit_price_cents). Never stored. */
  net_cents: number;
}

export interface Payment {
  id: number;
  invoice_id: number;
  date: string;
  amount_cents: number;
  note: string | null;
  created_at: string;
}

/** One row of the invoice list — everything money/status is derived. */
export interface InvoiceRow {
  id: number;
  number: string | null;
  customer_id: number;
  customer_name: string;
  status: InvoiceStatus;
  payment_status: PaymentStatus;
  issue_date: string | null;
  due_date: string | null;
  /** Derived: sent (not fully paid, not cancelled) and due date < today. */
  overdue: boolean;
  net_cents: number;
  vat_cents: number;
  gross_cents: number;
  paid_cents: number;
  created_at: string;
}

export interface VatBreakdownRow {
  rate: number;
  base_cents: number;
  vat_cents: number;
}

export interface InvoiceDetail extends InvoiceRow {
  payment_terms_days: number;
  note: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  lines: InvoiceLine[];
  vat_breakdown: VatBreakdownRow[];
  payments: Payment[];
  /** gross − paid (0 for drafts and cancelled invoices). */
  open_cents: number;
}

/** One row of a customer statement, in chronological order. */
export interface LedgerEntry {
  date: string;
  type: 'invoice' | 'cancellation' | 'payment';
  invoice_id: number;
  number: string;
  /** Signed cents: +gross for invoices, −gross for cancellations, −amount for payments. */
  amount_cents: number;
  /** Running balance after this entry. */
  balance_cents: number;
}

export interface Ledger {
  customer: Customer;
  entries: LedgerEntry[];
  /** Gross total of finalized, non-cancelled invoices. */
  invoiced_cents: number;
  paid_cents: number;
  /** invoiced − paid — always equals the last entry's running balance. */
  balance_cents: number;
}

export interface FieldError {
  field: string;
  message: string;
}
