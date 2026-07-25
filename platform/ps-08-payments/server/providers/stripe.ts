import type { ConfirmResult, FetchLike, PaymentProvider, RefundResult } from './index.js';

/**
 * Real Stripe adapter — a single form-encoded `fetch` per call, no SDK. Used
 * only when STRIPE_SECRET_KEY is configured; otherwise the mock provider runs.
 * Stripe confirms synchronously here and also emits webhooks, which the
 * inbound receiver reconciles.
 */
export function stripeProvider(secretKey: string, fetchImpl: FetchLike): PaymentProvider {
  const auth = `Bearer ${secretKey}`;
  const post = async (path: string, params: Record<string, string>) => {
    const res = await fetchImpl(`https://api.stripe.com${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: auth },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) throw new Error(`Stripe HTTP ${res.status}`);
    return (await res.json()) as { id?: string; status?: string };
  };

  return {
    name: 'stripe',
    async confirm(intent): Promise<ConfirmResult> {
      const pi = await post('/v1/payment_intents', {
        amount: String(intent.amount_minor),
        currency: intent.currency.toLowerCase(),
        confirm: 'true',
        'payment_method_types[]': 'card',
        metadata: `ref=${intent.public_id}`,
      });
      return { settled: pi.status === 'succeeded', providerRef: pi.id };
    },
    async refund(intent, amountMinor): Promise<RefundResult> {
      const r = await post('/v1/refunds', { amount: String(amountMinor), metadata: `ref=${intent.public_id}` });
      return { settled: true, providerRef: r.id };
    },
  };
}
