import { BaseClient } from './http.js';
import type { CreateIntentInput, LedgerEntry, PaymentIntent } from './types.js';

/** Client for PS-08 Payments (default port 4008). */
export class PaymentsClient extends BaseClient {
  /** Create a payment intent; idempotent on `idempotency_key`. */
  createIntent(input: CreateIntentInput): Promise<PaymentIntent> {
    return this.apiPost<PaymentIntent>('/api/intents', input);
  }

  getIntent(id: number): Promise<PaymentIntent> {
    return this.apiGet(`/api/intents/${id}`);
  }

  confirm(id: number): Promise<PaymentIntent> {
    return this.apiPost<PaymentIntent>(`/api/intents/${id}/confirm`, {});
  }

  /** Refund the full amount, or a partial `amountMinor`. */
  refund(id: number, amountMinor?: number): Promise<PaymentIntent> {
    return this.apiPost<PaymentIntent>(`/api/intents/${id}/refund`, amountMinor === undefined ? {} : { amount_minor: amountMinor });
  }

  ledger(): Promise<{ ledger: LedgerEntry[] }> {
    return this.apiGet('/api/ledger');
  }
}
