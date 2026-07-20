/**
 * Domain types shared between the Express API and the React client.
 * The single source of truth for statuses and VAT rates lives here so
 * server and client can never disagree.
 */

/**
 * STORED lifecycle status. Six values ever hit the database:
 *   draft       no number yet, fully editable, deletable
 *   sent        number assigned, immutable, awaiting a decision
 *   accepted    the customer accepted (append-only event flipped it)
 *   rejected    the customer rejected
 *   withdrawn   the seller pulled it back before a decision (keeps number)
 *   superseded  replaced by a revision (keeps number, points forward)
 * "expired" is NOT stored — it is derived (a sent offer whose validity
 * date has passed relative to the clock), so it can never drift.
 */
export const STORED_STATUSES = [
  'draft',
  'sent',
  'accepted',
  'rejected',
  'withdrawn',
  'superseded',
] as const;
export type StoredStatus = (typeof STORED_STATUSES)[number];

/** Derived lifecycle status as reported by the API (adds "expired"). */
export const STATUSES = [
  'draft',
  'sent',
  'accepted',
  'rejected',
  'withdrawn',
  'superseded',
  'expired',
] as const;
export type OfferStatus = (typeof STATUSES)[number];

export interface Customer {
  id: number;
  name: string;
  contact_person: string | null;
  email: string | null;
  vat_id: string | null;
  address: string | null;
  archived_at: string | null;
  created_at: string;
}

export interface OfferLine {
  id: number;
  offer_id: number;
  position: number;
  description: string;
  quantity: number;
  unit_price_cents: number;
  vat_rate: number;
  /** Per-line discount percent (0..100). */
  discount_percent: number;
  /** Derived: round(quantity × unit_price_cents × (1 − discount%/100)). Never stored. */
  net_cents: number;
}

export interface OfferEvent {
  id: number;
  offer_id: number;
  event: 'created' | 'sent' | 'accepted' | 'rejected' | 'withdrawn' | 'superseded' | 'revised';
  actor: string;
  note: string | null;
  created_at: string;
}

export interface VatBreakdownRow {
  rate: number;
  base_cents: number;
  vat_cents: number;
}

/** One row of the offer list — everything money/status is derived. */
export interface OfferRow {
  id: number;
  number: string | null;
  customer_id: number;
  customer_name: string;
  title: string;
  status: OfferStatus;
  valid_until: string | null;
  /** Derived: sent and past its validity date (relative to the clock). */
  expired: boolean;
  sent_at: string | null;
  net_cents: number;
  vat_cents: number;
  gross_cents: number;
  /** The offer this one supersedes (revision chain, older). */
  supersedes_id: number | null;
  /** The offer that supersedes this one, if any (revision chain, newer). */
  superseded_by_id: number | null;
  created_at: string;
}

export interface OfferDetail extends OfferRow {
  intro: string | null;
  terms: string | null;
  discount_cents: number;
  lines: OfferLine[];
  vat_breakdown: VatBreakdownRow[];
  events: OfferEvent[];
  /** Number of the superseded (older) offer, for display. */
  supersedes_number: string | null;
  /** Number of the superseding (newer) offer, for display. */
  superseded_by_number: string | null;
  /** Public acceptance token (admin view only — the link you email). */
  public_token: string | null;
  /** Relative path of the public acceptance page, once sent. */
  public_path: string | null;
}

/** Read-only public view of an offer, served on the acceptance link. */
export interface PublicOffer {
  number: string;
  title: string;
  status: OfferStatus;
  expired: boolean;
  valid_until: string;
  intro: string | null;
  terms: string | null;
  seller_name: string;
  customer_name: string;
  net_cents: number;
  vat_cents: number;
  gross_cents: number;
  discount_cents: number;
  lines: OfferLine[];
  vat_breakdown: VatBreakdownRow[];
  /** True while the customer can still accept or reject (sent, not expired). */
  decidable: boolean;
}

/** Derived dashboard figures for a period (a calendar year). */
export interface DashboardStats {
  period: number;
  /** Sent offers still awaiting a decision (not expired). */
  open_count: number;
  open_value_cents: number;
  /** Sent offers past their validity date with no decision. */
  expired_count: number;
  expired_value_cents: number;
  accepted_count: number;
  accepted_value_cents: number;
  rejected_count: number;
  rejected_value_cents: number;
  /** accepted / (accepted + rejected), as a 0..100 integer percentage. */
  win_rate_pct: number;
}

export interface FieldError {
  field: string;
  message: string;
}
