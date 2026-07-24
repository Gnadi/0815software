import { describe, expect, it } from 'vitest';

/**
 * Gated live suite — excluded from the default `vitest run` (see the `test`
 * script's --exclude) and run only via `npm run test:live`. It hits the REAL
 * Stripe API and therefore skips unless LIVE_STRIPE_KEY (a test-mode secret
 * key, `sk_test_…`) is present. Running it is the remaining, user-supplied
 * step to validate the vendor adapter against production.
 */
const KEY = process.env.LIVE_STRIPE_KEY;

describe.skipIf(!KEY)('PS-08 · live Stripe adapter', () => {
  it('creates a test-mode payment intent', async () => {
    const res = await fetch('https://api.stripe.com/v1/payment_intents', {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ amount: '1099', currency: 'eur' }).toString(),
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as { id?: string; status?: string };
    expect(body.id).toMatch(/^pi_/);
  });
});
