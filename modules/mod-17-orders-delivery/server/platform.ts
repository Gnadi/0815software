import { AuditClient } from '@0815software/platform-clients';

/**
 * Optional integrations, each best-effort and each off when its URL is unset:
 *
 * - PS-07 Audit Log (AUDIT_URL): orders, deliveries and cancellations on the
 *   tamper-evident trail. An audit outage never fails the local operation.
 * - MOD-13 Offers (OFFERS_URL): fetch an accepted offer, as the neutral
 *   document transfer, to confirm it as an order. Unset, orders are entered
 *   by hand and the import says so (501).
 */

export interface PlatformConfig {
  auditUrl?: string;
  offersUrl?: string;
  serviceToken?: string;
}

export interface AuditInfo {
  actor: string;
  action: string;
  resource: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

/** A configured offer source refused or failed; carries the status to pass on. */
export class OfferFetchError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'OfferFetchError';
  }
}

export interface PlatformHooks {
  audit(info: AuditInfo): Promise<void>;
  /** The offer as a document transfer, or null when no offer source is configured. */
  fetchOffer(offerNumber: string): Promise<unknown | null>;
}

export const noopPlatform: PlatformHooks = {
  async audit() {
    /* standalone: nothing to do */
  },
  async fetchOffer() {
    return null;
  },
};

/** How long the offer source gets to answer before the import gives up. */
const OFFER_FETCH_TIMEOUT_MS = 10_000;

export function buildPlatform(cfg: PlatformConfig): PlatformHooks {
  const client = cfg.auditUrl ? new AuditClient({ baseUrl: cfg.auditUrl, serviceToken: cfg.serviceToken }) : null;
  const offersUrl = cfg.offersUrl?.replace(/\/+$/, '');
  return {
    async audit(info: AuditInfo): Promise<void> {
      if (!client) return;
      try {
        await client.record(info);
      } catch (err) {
        console.warn('[mod-17] audit failed:', err);
      }
    },

    async fetchOffer(offerNumber: string): Promise<unknown | null> {
      if (!offersUrl) return null;
      let res: Response;
      try {
        res = await fetch(`${offersUrl}/api/offers/${encodeURIComponent(offerNumber)}/transfer`, {
          headers: cfg.serviceToken ? { 'X-Service-Token': cfg.serviceToken } : {},
          signal: AbortSignal.timeout(OFFER_FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        // A refused connection or the timeout throws rather than answering;
        // name the module being called, not a bare 500 from this one.
        throw new OfferFetchError(502, `The offer source is unreachable: ${err instanceof Error ? err.message : String(err)}`);
      }
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = text;
      }
      if (!res.ok) {
        const message =
          parsed && typeof parsed === 'object' && 'error' in parsed
            ? String((parsed as { error: unknown }).error)
            : `offer ${offerNumber} could not be fetched (${res.status})`;
        throw new OfferFetchError(res.status, message);
      }
      return parsed;
    },
  };
}
