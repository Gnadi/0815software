/**
 * PS-08 Payments — wire contract shared between server and clients.
 */

export interface FieldError {
  field: string;
  message: string;
}

export const INTENT_STATUSES = [
  'requires_payment',
  'processing',
  'succeeded',
  'partially_refunded',
  'refunded',
  'failed',
  'canceled',
] as const;
export type IntentStatus = (typeof INTENT_STATUSES)[number];

export interface LedgerEntry {
  id: number;
  intent_id: number;
  direction: 'credit' | 'debit';
  amount_minor: number;
  reason: string;
  created_at: string;
}

export interface IntentEvent {
  id: number;
  type: string;
  amount_minor: number | null;
  created_at: string;
}

export interface PaymentIntent {
  id: number;
  public_id: string;
  reference: string;
  provider: string;
  amount_minor: number;
  currency: string;
  status: IntentStatus;
  amount_refunded_minor: number;
  created_at: string;
}

export interface PaymentIntentDetail extends PaymentIntent {
  events: IntentEvent[];
  ledger: LedgerEntry[];
}
