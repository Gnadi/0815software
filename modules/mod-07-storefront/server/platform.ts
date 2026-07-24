import { PaymentsClient } from '@0815software/platform-clients';

/**
 * Optional integration with PS-08 Payments. When `PAYMENTS_URL` is configured,
 * checkout collects payment for the order total; otherwise the module keeps its
 * standalone behaviour (orders are placed unpaid, marked paid by an admin), so
 * mod-07 still runs perfectly on its own. The hook is best-effort — a payments
 * outage must never fail a placed order.
 */

export interface PlatformConfig {
  paymentsUrl?: string;
  serviceToken?: string;
}

export interface PayOrderInfo {
  ref: string;
  amountMinor: number;
  currency: string;
}

/** Result of a payment attempt, or null when Payments is not configured. */
export type PaymentResult = { status: string; public_id: string } | null;

export interface PlatformHooks {
  payOrder(info: PayOrderInfo): Promise<PaymentResult>;
}

export const noopPlatform: PlatformHooks = {
  async payOrder() {
    return null;
  },
};

export function buildPlatform(cfg: PlatformConfig): PlatformHooks {
  const payments = cfg.paymentsUrl ? new PaymentsClient({ baseUrl: cfg.paymentsUrl, serviceToken: cfg.serviceToken }) : null;
  if (!payments) return noopPlatform;

  return {
    async payOrder(info: PayOrderInfo): Promise<PaymentResult> {
      // Idempotent on the order ref, so a retried checkout never double-charges.
      const intent = await payments.createIntent({
        reference: `order:${info.ref}`,
        amount_minor: info.amountMinor,
        currency: info.currency,
        confirm: true,
        idempotency_key: `order:${info.ref}`,
      });
      return { status: intent.status, public_id: intent.public_id };
    },
  };
}
