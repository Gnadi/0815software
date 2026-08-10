import { BaseClient } from './http.js';
import type { CreateIntentInput, LedgerEntry, PaymentIntent } from './types.js';

/** Client for PS-08 Payments (default port 4008). */
export class PaymentsClient extends BaseClient {
  /** Create a payment intent; idempotent on `idempotency_key`. */
  createIntent(input: CreateIntentInput): Promise<PaymentIntent> {
    return this.apiPost<PaymentIntent>('/api/intents', input);
  }

  getIntent(id: number): Promise<PaymentIntent> {
    return this.apiGet(`/api/intents/${encodeURIComponent(String(id))}`);
  }

  confirm(id: number): Promise<PaymentIntent> {
    return this.apiPost<PaymentIntent>(`/api/intents/${encodeURIComponent(String(id))}/confirm`, {});
  }

  /**
   * Refund the full amount, or a partial `amountMinor`. Pass an
   * `idempotencyKey` when the caller may retry: a request that timed out
   * leaves you unable to tell whether the money moved, and replaying the same
   * key is then a no-op instead of a second refund.
   */
  refund(id: number, amountMinor?: number, idempotencyKey?: string): Promise<PaymentIntent> {
    const body: Record<string, unknown> = {};
    if (amountMinor !== undefined) body.amount_minor = amountMinor;
    if (idempotencyKey !== undefined) body.idempotency_key = idempotencyKey;
    return this.apiPost<PaymentIntent>(`/api/intents/${encodeURIComponent(String(id))}/refund`, body);
  }

  ledger(): Promise<{ ledger: LedgerEntry[] }> {
    return this.apiGet('/api/ledger');
  }
}
