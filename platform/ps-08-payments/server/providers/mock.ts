import type { ConfirmResult, PaymentProvider, RefundResult } from './index.js';

/**
 * The default provider: fully deterministic and offline. Confirming an intent
 * puts it in `processing` (it settles to `succeeded` on the next
 * `POST /api/tick`, mirroring a real PSP's asynchronous settlement); refunds
 * settle immediately. Zero external calls, reproducible in CI.
 */
export const mockProvider: PaymentProvider = {
  name: 'mock',
  async confirm(): Promise<ConfirmResult> {
    return { settled: false, providerRef: undefined };
  },
  async refund(): Promise<RefundResult> {
    return { settled: true };
  },
};
