import type { ExpenseCategory, PerDiemLine, PerDiemMode, Vehicle } from './expenses.js';

/** What the API says about expenses — read by the app and by the tests. */

export const CLAIM_STATUSES = ['submitted', 'approved', 'rejected', 'withdrawn', 'paid'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const PAYOUT_MODES = ['payroll', 'invoicing'] as const;
export type PayoutMode = (typeof PAYOUT_MODES)[number];

export type ExpenseItemType = 'trip' | 'mileage' | 'receipt';

export interface ExpenseSettings {
  /**
   * How approved claims are paid: with the salary (an export for payroll,
   * then "paid" by hand) or by bank transfer from the invoicing module, which
   * takes the claim over as a bill and reports back when it is paid.
   */
  payout_mode: PayoutMode;
  /** § 26 Z 4 lit. b EStG: per 24 hours from departure, or per calendar day. */
  per_diem_mode: PerDiemMode;
  /** A privately paid receipt needs its picture from this amount on; null: never required. */
  file_required_from_cents: number | null;
  /** Email the person when their claim is decided or paid (PS-03). */
  notify_employee: boolean;
  /** Who hears of a new claim to decide (PS-03), e.g. the office's inbox. */
  notify_on_submit: string[];
  /** The PS-03 channel. */
  channel: string;
}

/** Where an item stands: free to change, or held by a claim. */
export interface ItemClaim {
  locked: boolean;
  /** The claim holding it (submitted, approved or paid), if any. */
  claim_number: string | null;
}

export interface ExpenseTrip extends ItemClaim {
  id: number;
  employee_id: number;
  employee_name: string;
  client_id: string | null;
  purpose: string;
  destination: string;
  /** null: in Austria; otherwise the country as the foreign-rate list names it. */
  country: string | null;
  start_local: string;
  end_local: string;
  border_out: string | null;
  border_in: string | null;
  meals: number[];
  nights_flat: number;
  /** Derived: the nights the trip spans. */
  nights_max: number;
  project_id: number | null;
  note: string | null;
  periods: PerDiemLine[];
  per_diem_cents: number;
  night_rate_cents: number;
  nights_cents: number;
  total_cents: number;
  /** Why it cannot be priced (no rate in force), or null. */
  rate_problem: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ExpenseMileage extends ItemClaim {
  id: number;
  employee_id: number;
  employee_name: string;
  client_id: string | null;
  trip_id: number | null;
  travel_date: string;
  from_place: string;
  to_place: string;
  purpose: string;
  km_tenths: number;
  vehicle: Vehicle;
  passengers: number;
  rate_cents: number;
  passenger_rate_cents: number;
  amount_cents: number;
  rate_problem: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface VatLine {
  /** Basis points: 2000 = 20 %. */
  rate_bp: number;
  gross_cents: number;
}

export interface RksvSummary {
  cashbox_id: string;
  receipt_id: string;
  issued_at: string;
  signature_failed: boolean;
}

export interface ExpenseReceipt extends ItemClaim {
  id: number;
  employee_id: number;
  employee_name: string;
  client_id: string | null;
  trip_id: number | null;
  receipt_date: string;
  merchant: string;
  category: ExpenseCategory;
  description: string | null;
  gross_cents: number;
  vat_lines: VatLine[];
  /** Derived from the VAT lines; null without them. */
  vat_cents: number | null;
  net_cents: number | null;
  paid_by: 'private' | 'company';
  /** What the person gets back: a company-paid receipt is documented, not refunded. */
  reimbursable_cents: number;
  source: 'manual' | 'rksv';
  rksv: RksvSummary | null;
  file: { content_type: string; size_bytes: number; sha256: string } | null;
  /** The settings require a picture of it before it can be claimed. */
  file_missing: boolean;
  project_id: number | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface ClaimTotals {
  per_diem_cents: number;
  nights_cents: number;
  mileage_cents: number;
  receipts_cents: number;
  total_cents: number;
}

export interface ExpenseClaim {
  id: number;
  number: string;
  employee_id: number;
  employee_name: string;
  title: string;
  status: ClaimStatus;
  submitted_by: string;
  submitted_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  per_diem_mode: PerDiemMode;
  payout_mode: PayoutMode | null;
  handed_over_ref: string | null;
  paid_at: string | null;
  paid_ref: string | null;
  totals: ClaimTotals;
  counts: { trips: number; mileage: number; receipts: number };
  can_decide: boolean;
  can_withdraw: boolean;
  can_mark_paid: boolean;
}

export interface ClaimDetail {
  claim: ExpenseClaim;
  trips: ExpenseTrip[];
  mileage: ExpenseMileage[];
  receipts: ExpenseReceipt[];
  /** Every step, with the total that step was taken on. */
  events: { type: string; actor: string; note: string | null; total_cents: number; at: string }[];
  /** The account it is paid to, masked; null when none is on file. */
  bank_account: { holder: string; iban_masked: string } | null;
}

export interface ExpenseRate {
  id: number;
  kind: string;
  country: string | null;
  valid_from: string;
  amount_cents: number;
  basis: string | null;
  preset: boolean;
  actor: string;
  created_at: string;
}

export interface BankAccount {
  holder: string;
  iban: string;
  bic: string | null;
  actor: string;
  created_at: string;
}
