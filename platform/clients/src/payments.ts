import { BaseClient, type RequestOptions } from './http.js';
import type { CreateIntentInput, LedgerEntry, PaymentIntent } from './types.js';

/** Client for PS-08 Payments (default port 4008). */
export class PaymentsClient extends BaseClient {
  /**
   * Create a payment intent. Pass an `idempotencyKey` in `opts` to make the
   * call safely retryable — the server dedupes so a network hiccup never
   * double-charges.
   */
  createIntent(input: CreateIntentInput, opts?: RequestOptions): Promise<PaymentIntent> {
    return this.apiPost<PaymentIntent>('/api/intents', input, opts);
  }

  getIntent(id: number): Promise<PaymentIntent> {
    return this.apiGet(`/api/intents/${id}`);
  }

  confirm(id: number, opts?: RequestOptions): Promise<PaymentIntent> {
    return this.apiPost<PaymentIntent>(`/api/intents/${id}/confirm`, {}, opts);
  }

  /** Refund the full amount, or a partial `amountMinor`. Pass an `idempotencyKey` to dedupe. */
  refund(id: number, amountMinor?: number, opts?: RequestOptions): Promise<PaymentIntent> {
    return this.apiPost<PaymentIntent>(`/api/intents/${id}/refund`, amountMinor === undefined ? {} : { amount_minor: amountMinor }, opts);
  }

  ledger(): Promise<{ ledger: LedgerEntry[] }> {
    return this.apiGet('/api/ledger');
  }
}
