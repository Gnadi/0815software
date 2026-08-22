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

export interface InvoiceLine {
  id: number;
  invoice_id: number;
  position: number;
  description: string;
  quantity: number;
  unit_price_cents: number;
  vat_rate: number;
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

// ── Payables: the bills we owe and the bank file that pays them ────────

/**
 * DERIVED bill status. Like an invoice's "paid", none of this is a column:
 * the database stores only the facts (`paid_at`, `cancelled_at`, and whether
 * an active payment-run item exists), and the label is computed at read time
 * so it cannot drift away from them.
 *
 *   open       payable — editable, cancellable, may go into a payment run
 *   scheduled  in an active payment run: the file has been produced, the
 *              bank has not been confirmed to have executed it yet
 *   paid       settled (the run was marked executed, or someone paid it by
 *              other means and recorded that)
 *   cancelled  we are not paying it — kept, never deleted
 */
export const BILL_STATUSES = ['open', 'scheduled', 'paid', 'cancelled'] as const;
export type BillStatus = (typeof BILL_STATUSES)[number];

/**
 * DERIVED payment-run status, from the timestamps on the row.
 *
 *   created    the file exists and is downloadable; nothing has been sent
 *   submitted  handed to the bank over EBICS (PS-12). Its bills stay
 *              `scheduled`: the bank accepting a FILE is not the bank having
 *              PAID it, and pretending otherwise would mark bills settled that
 *              may still bounce.
 *   executed   the money moved — the bank confirmed it, or an operator did
 *   rejected   the bank refused the file. Its bills are released back to
 *              `open`, because a refused file is one nobody acted on.
 *   discarded  we threw it away without sending it. Also releases the bills.
 *
 * `rejected` and `discarded` end in the same place and are still kept apart:
 * one is the bank's decision and one is ours, and an operator chasing a
 * missing payment needs to know which.
 */
export const RUN_STATUSES = ['created', 'submitted', 'executed', 'rejected', 'discarded'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Someone we pay. The IBAN is stored normalized (no spaces, upper case). */
export interface Creditor {
  id: number;
  name: string;
  iban: string;
  bic: string | null;
  note: string | null;
  created_at: string;
}

export interface CreditorRow extends Creditor {
  bill_count: number;
  /** Gross still owed to this creditor: bills that are neither paid nor cancelled. */
  open_cents: number;
  /**
   * The Austrian tax office this creditor's IBAN belongs to, when it is one.
   *
   * A hint, not a rule: the list it comes from is marked non-normative and
   * changes. It exists so a screen can say "this is Finanzamt Linz — send it
   * as a Finanzamtszahlung?" rather than leaving an operator to know.
   */
  finanzamt: { office: number; name: string } | null;
}

/** One incoming bill — what we owe, to whom, by when. */
export interface Bill {
  id: number;
  creditor_id: number;
  /** The supplier's own invoice number. Unique per creditor: no double entry. */
  reference: string;
  /** Payment purpose override; the reference is used when this is null. */
  remittance: string | null;
  /** Gross amount to transfer, in integer cents. Bills carry no VAT split. */
  amount_cents: number;
  issue_date: string | null;
  due_date: string;
  note: string | null;
  paid_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}

/** One row of the bills list — status, creditor and overdue are all derived. */
export interface BillRow extends Bill {
  creditor_name: string;
  creditor_iban: string;
  creditor_bic: string | null;
  status: BillStatus;
  /** Derived: open (not scheduled, paid or cancelled) and due date < today. */
  overdue: boolean;
  /** The active payment run this bill sits in, when it is scheduled. */
  payment_run_id: number | null;
  /** What the payment file will say — the remittance, or the reference. */
  payment_reference: string;
}

/**
 * One transfer inside a payment run — a FROZEN snapshot of the bill and its
 * creditor as they were when the file was produced. Renaming a supplier or
 * correcting their IBAN afterwards must not change a file the bank already
 * has, so nothing here is read back through a join.
 */
export interface PaymentRunItem {
  bill_id: number;
  position: number;
  end_to_end_id: string;
  amount_cents: number;
  creditor_name: string;
  creditor_iban: string;
  creditor_bic: string | null;
  remittance: string;
  /** The bill's reference, for the screen — never part of the file itself. */
  reference: string;
}

export interface PaymentRunRow {
  id: number;
  /** The pain.001 `MsgId`: the bank's duplicate check, and this run's name. */
  message_id: string;
  execution_date: string;
  status: RunStatus;
  debtor_name: string;
  debtor_iban: string;
  debtor_bic: string | null;
  item_count: number;
  total_cents: number;
  created_by: string | null;
  created_at: string;
  executed_at: string | null;
  discarded_at: string | null;
  submitted_at: string | null;
  rejected_at: string | null;
  /** PS-12's id for the bank order, when this run was sent over EBICS. */
  banking_order_id: string | null;
  /**
   * PS-12's own word for that order: `accepted`, `rejected`, or `failed`.
   *
   * `failed` is the one to read carefully — it means the conversation with the
   * bank broke and whether the file arrived is UNKNOWN. The run shows as
   * `submitted` and its bills stay scheduled, which is the safe direction: the
   * money may have moved. It needs a human and a phone call, not a retry.
   */
  bank_status: string | null;
  bank_message: string | null;
  /**
   * `TAXS` for a Finanzamtszahlung, null for an ordinary SEPA credit transfer
   * — which is every run made before this existed, and most runs after it.
   */
  category_purpose: 'TAXS' | null;
  /**
   * Whether the remittance lines were checked against a published format.
   *
   * Null on an ordinary run: there is no Austrian format to check. True on
   * every TAXS or CPPP run made since the PSA formats were shipped, which is
   * all of them going forward.
   *
   * **False means the run predates those formats** — it was created by a build
   * that had no pattern for these and let the reference through unverified.
   * Recorded at creation rather than derived, which is the only reason those
   * runs can still be told apart from checked ones.
   */
  remittance_format_checked: boolean | null;
}

export interface PaymentRunDetail extends PaymentRunRow {
  items: PaymentRunItem[];
  /** Set on the API response, not stored: whether PS-12 Banking is wired. */
  banking_configured?: boolean;
}

/** What the payment screens need to know before offering to build a file. */
export interface PaymentConfig {
  /** The debtor: this installation's own account, from SELLER_* / PS-11. */
  debtor_name: string;
  debtor_iban: string;
  debtor_bic: string | null;
  /** False when the configured IBAN is missing or invalid — see `problem`. */
  ready: boolean;
  problem: string | null;
  pain_version: string;
  batch_booking: boolean;
  /**
   * True when PS-12 Banking is wired (`BANKING_URL` set), so a run can be sent
   * rather than downloaded. False is the standalone posture and not an error —
   * the download is the primary path and the only one most installations need.
   */
  banking_configured: boolean;
}
