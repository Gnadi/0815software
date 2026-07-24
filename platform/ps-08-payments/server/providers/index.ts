/** Injectable HTTP client (returns status + JSON body) so tests stay offline. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, json: () => res.json() };
};

export interface ConfirmResult {
  /** Whether the intent settled synchronously (true) or is now processing. */
  settled: boolean;
  /** The provider's own reference for the charge, if any. */
  providerRef?: string;
}

export interface RefundResult {
  settled: boolean;
  providerRef?: string;
}

/** A payment provider confirms intents and issues refunds. */
export interface PaymentProvider {
  name: string;
  confirm(intent: { public_id: string; amount_minor: number; currency: string }): Promise<ConfirmResult>;
  refund(intent: { public_id: string }, amountMinor: number): Promise<RefundResult>;
}
