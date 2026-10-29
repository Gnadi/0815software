/**
 * Domain types shared between the Express API and the React client.
 * The single source of truth for statuses lives here so server and
 * client can never disagree.
 */

/**
 * STORED RFQ status. Only three values ever hit the database:
 *   open     collecting invitations and quotes, lines editable until
 *            the first quote arrives
 *   awarded  exactly one winning supplier chosen; a draft PO was created
 *   closed   closed without an award
 * "quoted" is NOT stored — it is derived (an open RFQ with at least one
 * complete quote), so it can never drift out of sync.
 */
export const RFQ_STORED_STATUSES = ['open', 'awarded', 'closed'] as const;
export type RfqStoredStatus = (typeof RFQ_STORED_STATUSES)[number];

/** Derived RFQ status as reported by the API. */
export const RFQ_STATUSES = ['open', 'quoted', 'awarded', 'closed'] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];

/**
 * STORED purchase-order status. Only four values ever hit the database:
 *   draft      editable; no approvals count
 *   submitted  lines frozen (edits → 409); collecting tier approvals
 *   ordered    sent to the supplier; only fully-approved POs get here
 *   closed     done (goods received / archived)
 * "approved" is NOT stored — it is derived (a submitted PO whose every
 * frozen required tier has an active approval). A rejection returns the
 * PO to stored `draft`; the approval history rows are retained forever.
 */
export const PO_STORED_STATUSES = ['draft', 'submitted', 'ordered', 'closed'] as const;
export type PoStoredStatus = (typeof PO_STORED_STATUSES)[number];

/** Derived PO status as reported by the API. */
export const PO_STATUSES = ['draft', 'submitted', 'approved', 'ordered', 'closed'] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

export const APPROVAL_DECISIONS = ['approved', 'rejected'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

// ── Master data ───────────────────────────────────────────────────────

export interface Supplier {
  id: number;
  name: string;
  contact: string | null;
  email: string | null;
  notes: string | null;
  created_at: string;
}

export interface SupplierRow extends Supplier {
  rfq_count: number;
  po_count: number;
}

// ── RFQs ──────────────────────────────────────────────────────────────

export interface RfqLine {
  id: number;
  rfq_id: number;
  position: number;
  description: string;
  quantity: number;
  unit: string;
}

export interface Invitation {
  id: number;
  rfq_id: number;
  supplier_id: number;
  supplier_name: string;
  created_at: string;
  /** Derived: this supplier has submitted a (complete) quote. */
  has_quote: boolean;
}

export interface QuoteLine {
  rfq_line_id: number;
  unit_price_cents: number;
  /** Derived: round(rfq line quantity × unit_price_cents). Never stored. */
  net_cents: number;
}

export interface Quote {
  id: number;
  rfq_id: number;
  supplier_id: number;
  supplier_name: string;
  valid_until: string | null;
  note: string | null;
  created_at: string;
  lines: QuoteLine[];
  /** Derived: sum of line nets. Never stored. */
  total_cents: number;
}

export interface RfqRow {
  id: number;
  title: string;
  status: RfqStatus;
  due_date: string | null;
  note: string | null;
  line_count: number;
  invited_count: number;
  quote_count: number;
  awarded_supplier_id: number | null;
  awarded_supplier_name: string | null;
  awarded_po_id: number | null;
  created_at: string;
}

export interface RfqDetail extends RfqRow {
  awarded_at: string | null;
  closed_at: string | null;
  lines: RfqLine[];
  invitations: Invitation[];
  quotes: Quote[];
}

// ── Purchase orders & approvals ───────────────────────────────────────

export interface PoLine {
  id: number;
  po_id: number;
  position: number;
  description: string;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  /** Derived: round(quantity × unit_price_cents). Never stored. */
  net_cents: number;
  /** The MOD-03 article number, when the line is stock; null for services. */
  sku: string | null;
  /** Derived: the sum of its goods receipt lines. */
  received_quantity: number;
}

/**
 * One append-only approval-history row. Rows are NEVER deleted or
 * updated: a rejection or a return-to-draft supersedes them instead.
 * `voided` is derived — a row is voided when it belongs to an older
 * submission, or to the current one after the PO went back to draft.
 */
export interface Approval {
  id: number;
  po_id: number;
  submission_no: number;
  tier: number;
  tier_label: string;
  decision: ApprovalDecision;
  approver: string;
  note: string | null;
  created_at: string;
  voided: boolean;
}

/** One append-only submission snapshot: the frozen total + tiers. */
export interface Submission {
  submission_no: number;
  total_cents: number;
  required_tiers: number[];
  created_at: string;
  /** The submission the PO currently sits in (false once superseded). */
  active: boolean;
}

export interface PoRow {
  id: number;
  number: string;
  supplier_id: number;
  supplier_name: string;
  rfq_id: number | null;
  status: PoStatus;
  total_cents: number;
  /** Frozen at submit ([] while draft). */
  required_tiers: number[];
  /** Tiers with an active approval in the current submission. */
  approved_tiers: number[];
  created_at: string;
  ordered_at: string | null;
}

export interface PoDetail extends PoRow {
  note: string | null;
  closed_at: string | null;
  submission_no: number;
  /** Lowest required tier without an active approval (null if none pending). */
  next_tier: number | null;
  lines: PoLine[];
  submissions: Submission[];
  approvals: Approval[];
  receipts: GoodsReceipt[];
  /** Derived: what has arrived, valued at the PO's prices. */
  received_cents: number;
  /** Derived: nothing, some or everything has arrived. */
  receipt_status: ReceiptStatus;
}

// ── Receiving and matching (server/receiving.ts) ──────────────────────

export const RECEIPT_STATUSES = ['none', 'partial', 'complete'] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

export interface GoodsReceipt {
  id: number;
  po_id: number;
  /** "PO-2026-0003/WE-2" — the reference MOD-03 and the supplier's paperwork see. */
  number: string;
  kind: 'receipt' | 'correction';
  received_on: string;
  note: string | null;
  actor: string;
  created_at: string;
  stock_status: 'booked' | 'failed' | 'not_booked' | null;
  stock_error: string | null;
  stock_warehouse: string | null;
  lines: { po_line_id: number; position: number; description: string; sku: string | null; quantity: number }[];
}

export interface MatchSettings {
  /** An invoice may exceed the value received by this share of it… */
  tolerance_percent: number;
  /** …but never by more than this many cents. */
  tolerance_cap_cents: number;
  /** The MOD-03 warehouse goods are received into; null: book no stock. */
  receiving_warehouse: string | null;
  /** Also match the invoice line by line, when MOD-04 sends its lines. */
  line_matching: boolean;
}

/** One line of what has been invoiced against the PO so far, as MOD-04 sends it. */
export interface InvoicedLine {
  /** The supplier's article number — compared with the PO line's SKU. */
  item_id: string | null;
  description: string;
  quantity: number | null;
  net_cents: number;
}

export const LINE_RESULTS = ['ok', 'awaiting_receipt', 'over_ordered', 'price_above', 'not_on_po', 'unchecked'] as const;
export type LineResult = (typeof LINE_RESULTS)[number];

/**
 * One invoiced line against the PO line it was matched to:
 *   ok                invoiced ≤ received, at no more than the PO price + tolerance
 *   awaiting_receipt  more invoiced than has arrived, not more than was ordered
 *   over_ordered      more invoiced than was ordered
 *   price_above       the invoiced unit price is above the PO price + tolerance
 *   not_on_po         no PO line has this SKU or description (freight, a surcharge …)
 *   unchecked         matched, but the invoice gives no quantity to compare
 */
export interface LineVerdict {
  item_id: string | null;
  description: string;
  po_position: number | null;
  matched_by: 'sku' | 'description' | null;
  invoiced_quantity: number | null;
  received_quantity: number | null;
  ordered_quantity: number | null;
  invoiced_net_cents: number;
  invoiced_unit_price_cents: number | null;
  ordered_unit_price_cents: number | null;
  result: LineResult;
  /** Whether this line holds the invoice. A small line not on the PO does not. */
  issue: boolean;
  message: string;
}

export const MATCH_RESULTS = ['matched', 'awaiting_receipt', 'over_invoiced', 'not_ordered'] as const;
export type MatchResult = (typeof MATCH_RESULTS)[number];

/** The answer to "may this much be invoiced against this PO?" — every figure derived. */
export interface MatchVerdict {
  po_number: string;
  supplier_name: string;
  po_status: PoStatus;
  ordered_cents: number;
  received_cents: number;
  invoiced_cents: number;
  tolerance_cents: number;
  result: MatchResult;
  /** invoiced − received: what is billed beyond what arrived (negative: less). */
  difference_cents: number;
  message: string;
  /** The line-by-line answer, when lines were sent and line matching is on; [] otherwise. */
  lines: LineVerdict[];
  /** How many of them hold the invoice — the header verdict alone does not say. */
  line_issues: number;
}

// ── Config as served to the client (single source: server config files) ──

export interface TierInfo {
  tier: number;
  label: string;
}

export interface RuleInfo {
  /** Inclusive upper bound in cents; null = no upper bound. */
  max_total_cents: number | null;
  tiers: number[];
}

export interface ProfileColumnInfo {
  header: string;
  field: string;
  money?: string;
  date?: string;
}

export interface ProfileInfo {
  name: string;
  description: string;
  delimiter: string;
  columns: ProfileColumnInfo[];
}

export interface AppConfig {
  tiers: TierInfo[];
  rules: RuleInfo[];
  profiles: ProfileInfo[];
}

export interface FieldError {
  field: string;
  message: string;
}
