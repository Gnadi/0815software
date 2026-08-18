import { AuditClient } from '@0815software/platform-clients';

/**
 * Optional integration with PS-07 Audit Log. When AUDIT_URL is configured,
 * key state changes are recorded on the tamper-evident trail; otherwise the
 * module runs standalone. Every call is best-effort — an audit outage never
 * fails the local operation.
 *
 * One call here is not a Platform Service: MOD-13 Offers, fetched as a neutral
 * document transfer (shared/transfer.ts) so an accepted offer can be planned as
 * a project. It is isolated behind `fetchOffer` so re-pointing it at another
 * source touches only this file, and unlike the audit calls it is NOT
 * best-effort — a configured source that fails must surface, because silently
 * creating an empty project would be worse.
 */

/**
 * Raised when a configured offer source refuses or fails. Carries the upstream
 * status so the route can pass a useful code to the operator rather than 500.
 */
export class OfferFetchError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'OfferFetchError';
    this.status = status;
  }
}

/** How long the offer source gets to answer before the import gives up. */
const OFFER_FETCH_TIMEOUT_MS = 10_000;

export interface PlatformConfig {
  auditUrl?: string;
  /** Base URL of MOD-13 Offers, for planning an accepted offer as a project. */
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

export interface PlatformHooks {
  audit(info: AuditInfo): Promise<void>;
  /**
   * Fetch an accepted offer from MOD-13 as a document transfer. Returns null
   * when OFFERS_URL is unset — the standalone posture, in which this module has
   * no notion of offers.
   */
  fetchOffer(offerNumber: string): Promise<unknown | null>;
}

export const noopPlatform: PlatformHooks = {
  async audit() {
    /* standalone: nothing to do */
  },
  async fetchOffer() {
    /* standalone: this module has no notion of offers */
    return null;
  },
};

export function buildPlatform(cfg: PlatformConfig): PlatformHooks {
  const client = cfg.auditUrl ? new AuditClient({ baseUrl: cfg.auditUrl, serviceToken: cfg.serviceToken }) : null;
  const offersUrl = cfg.offersUrl ? cfg.offersUrl.replace(/\/+$/, '') : null;
  if (!client && !offersUrl) return noopPlatform;
  return {
    async audit(info: AuditInfo): Promise<void> {
      if (!client) return;
      try {
        await client.record(info);
      } catch (err) {
        console.warn('[mod-11] audit failed:', err);
      }
    },

    async fetchOffer(offerNumber: string): Promise<unknown | null> {
      if (!offersUrl) return null;
      // Bounded like every platform-client call: an offers instance that
      // accepts the connection and then stalls must not hold the operator's
      // import request open indefinitely.
      let res: Response;
      try {
        res = await fetch(`${offersUrl}/api/offers/${encodeURIComponent(offerNumber)}/transfer`, {
          headers: cfg.serviceToken ? { 'X-Service-Token': cfg.serviceToken } : {},
          signal: AbortSignal.timeout(OFFER_FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        // A refused connection, a DNS failure or the timeout above all throw
        // from `fetch` itself rather than answering, so without this they left
        // as a bare TypeError/TimeoutError, missed the route's `instanceof`
        // check, and surfaced as an opaque 500 — pointing the operator at this
        // module when the problem is the one it was calling. 502 with the
        // reason is the same answer a non-OK response already produced.
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
