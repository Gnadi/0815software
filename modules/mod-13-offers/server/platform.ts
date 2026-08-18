import { AuditClient, CustomersClient, NotificationClient } from '@0815software/platform-clients';
import type { SelfParty } from './seller.js';

/**
 * Optional integration with the Platform Services (best-effort, opt-in):
 *   - PS-03 Notification Hub — notify people of key events (approvals, sends)
 *   - PS-07 Audit Log        — record state changes on the tamper-evident trail
 *   - PS-11 Customers        — resolve a customer against the stack's party
 *                              master data, so every module bills the same
 *                              party instead of keeping a private copy
 *   - MOD-10 CRM Lite        — fetch a deal still in play as a neutral document
 *                              transfer (shared/transfer.ts). The one call here
 *                              that is not a Platform Service; it is isolated
 *                              behind `fetchDeal` so re-pointing it at another
 *                              source touches only this file.
 * With no URL configured the module runs standalone; a downstream outage never
 * fails the local operation.
 */

/**
 * Raised when a configured deal source refuses or fails. Carries the upstream
 * status so the route can pass a useful code to the operator rather than 500.
 */
export class DealFetchError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'DealFetchError';
    this.status = status;
  }
}

/** How long the deal source gets to answer before the import gives up. */
const DEAL_FETCH_TIMEOUT_MS = 10_000;

export interface PlatformConfig {
  auditUrl?: string;
  notificationUrl?: string;
  customersUrl?: string;
  /** Base URL of MOD-10 CRM Lite, for quoting a deal still in play. */
  crmUrl?: string;
  serviceToken?: string;
  channel?: string;
}

export interface AuditInfo {
  actor: string;
  action: string;
  resource: string;
  before?: unknown;
  after?: unknown;
  metadata?: Record<string, unknown>;
}

export interface NotifyInfo {
  to: string;
  subject: string;
  body: string;
}

/** A customer as PS-11 needs to see it, plus this module's own row id. */
export interface PartyInfo {
  name: string;
  contactPerson: string | null;
  email: string | null;
  vatId: string | null;
  addressLines: string[];
  localId: number;
}

export interface PlatformHooks {
  audit(info: AuditInfo): Promise<void>;
  notify(info: NotifyInfo): Promise<void>;
  /**
   * The stack owner's own party from PS-11 — the seller letterhead. Null when
   * PS-11 is unset, has no `self` party yet, or is unreachable; the module then
   * keeps its SELLER_* environment values. See server/seller.ts.
   */
  fetchSelf(): Promise<SelfParty | null>;
  /**
   * Resolve a customer against PS-11's party master data, returning the master
   * party id. Returns null when PS-11 is not configured or is unreachable —
   * this module keeps its own customer row either way, so the local operation
   * never depends on the outcome.
   */
  resolveParty(info: PartyInfo): Promise<number | null>;
  /**
   * Fetch a deal still in play from MOD-10 as a document transfer. Returns null
   * when CRM_URL is unset — the standalone posture, in which this module has no
   * notion of a pipeline. NOT best-effort: a configured source that fails must
   * surface, because silently quoting an empty draft would be worse.
   */
  fetchDeal(dealId: string): Promise<unknown | null>;
}

export const noopPlatform: PlatformHooks = {
  async audit() {
    /* standalone */
  },
  async notify() {
    /* standalone */
  },
  async resolveParty() {
    /* standalone — the local customers table is the only record */
    return null;
  },
  async fetchDeal() {
    /* standalone — this module has no notion of a pipeline */
    return null;
  },
  async fetchSelf() {
    return null;
  },
};

export function buildPlatform(cfg: PlatformConfig): PlatformHooks {
  const audit = cfg.auditUrl ? new AuditClient({ baseUrl: cfg.auditUrl, serviceToken: cfg.serviceToken }) : null;
  const notify = cfg.notificationUrl
    ? new NotificationClient({ baseUrl: cfg.notificationUrl, serviceToken: cfg.serviceToken })
    : null;
  const customers = cfg.customersUrl
    ? new CustomersClient({ baseUrl: cfg.customersUrl, serviceToken: cfg.serviceToken })
    : null;
  const crmUrl = cfg.crmUrl ? cfg.crmUrl.replace(/\/+$/, '') : null;
  if (!audit && !notify && !customers && !crmUrl) return noopPlatform;
  const channel = cfg.channel ?? 'transactional-email';
  return {
    async fetchDeal(dealId: string): Promise<unknown | null> {
      if (!crmUrl) return null;
      // Bounded like every platform-client call: a CRM instance that accepts
      // the connection and then stalls must not hold the operator's import
      // request open indefinitely.
      let res: Response;
      try {
        res = await fetch(`${crmUrl}/api/deals/${encodeURIComponent(dealId)}/transfer`, {
          headers: cfg.serviceToken ? { 'X-Service-Token': cfg.serviceToken } : {},
          signal: AbortSignal.timeout(DEAL_FETCH_TIMEOUT_MS),
        });
      } catch (err) {
        // A refused connection, a DNS failure or the timeout above all throw
        // from `fetch` itself rather than answering, so without this they left
        // as a bare TypeError/TimeoutError, missed the route's `instanceof`
        // check, and surfaced as an opaque 500 — pointing the operator at this
        // module when the problem is the one it was calling. 502 with the
        // reason is the same answer a non-OK response already produced.
        throw new DealFetchError(502, `The deal source is unreachable: ${err instanceof Error ? err.message : String(err)}`);
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
            : `deal ${dealId} could not be fetched (${res.status})`;
        throw new DealFetchError(res.status, message);
      }
      return parsed;
    },

    async audit(info: AuditInfo): Promise<void> {
      if (!audit) return;
      try {
        await audit.record(info);
      } catch (err) {
        console.warn('[mod-13] audit failed:', err);
      }
    },
    async notify(info: NotifyInfo): Promise<void> {
      if (!notify || !info.to) return;
      try {
        await notify.send({ channel, to: info.to, subject: info.subject, body: info.body });
      } catch (err) {
        console.warn('[mod-13] notify failed:', err);
      }
    },
    async fetchSelf(): Promise<SelfParty | null> {
      if (!customers) return null;
      try {
        const { party } = await customers.self();
        return party;
      } catch (err) {
        console.warn('[mod-13] seller lookup failed:', err);
        return null;
      }
    },

    async resolveParty(info: PartyInfo): Promise<number | null> {
      if (!customers) return null;
      try {
        const { party } = await customers.resolve({
          name: info.name,
          contact_person: info.contactPerson,
          email: info.email,
          vat_id: info.vatId,
          address_lines: info.addressLines,
          source: 'mod-13-offers',
          external_id: String(info.localId),
        });
        return party.id;
      } catch (err) {
        console.warn('[mod-13] customer resolve failed:', err);
        return null;
      }
    },
  };
}
