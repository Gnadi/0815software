import { AuditClient } from '@0815software/platform-clients';

/**
 * Optional integrations, each best-effort and each off when its URL is unset:
 *
 * - PS-07 Audit Log (AUDIT_URL): orders, deliveries and cancellations on the
 *   tamper-evident trail. An audit outage never fails the local operation.
 * - MOD-13 Offers (OFFERS_URL): fetch an accepted offer, as the neutral
 *   document transfer, to confirm it as an order. Unset, orders are entered
 *   by hand and the import says so (501).
 * - MOD-03 Inventory (INVENTORY_URL): issue the goods of a delivery note.
 *   Unset, delivery notes book no stock; a failed booking is recorded on the
 *   delivery note and retried, never a reason to refuse the delivery.
 */

export interface PlatformConfig {
  auditUrl?: string;
  offersUrl?: string;
  inventoryUrl?: string;
  serviceToken?: string;
}

export interface GoodsIssueRequest {
  reference: string;
  warehouseCode: string;
  actor: string;
  lines: { sku: string; quantity: number }[];
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
  /** Whether MOD-03 is wired at all — decided by configuration, not by asking it. */
  inventoryConfigured: boolean;
  /** MOD-03's warehouses. Throws `OfferFetchError`-style `PeerError` when it does not answer. */
  inventoryWarehouses(): Promise<{ code: string; name: string }[]>;
  /** Book a goods issue in MOD-03; throws `PeerError` with MOD-03's own reason when refused. */
  issueGoods(request: GoodsIssueRequest): Promise<void>;
}

/** A peer module refused or failed; the message is the peer's own reason. */
export class PeerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'PeerError';
  }
}

const NO_INVENTORY = (): never => {
  throw new PeerError(501, 'No inventory is configured — set INVENTORY_URL to book stock in MOD-03');
};

export const noopPlatform: PlatformHooks = {
  async audit() {
    /* standalone: nothing to do */
  },
  async fetchOffer() {
    return null;
  },
  inventoryConfigured: false,
  async inventoryWarehouses() {
    return NO_INVENTORY();
  },
  async issueGoods() {
    NO_INVENTORY();
  },
};

/** How long the offer source gets to answer before the import gives up. */
const OFFER_FETCH_TIMEOUT_MS = 10_000;

export function buildPlatform(cfg: PlatformConfig): PlatformHooks {
  const client = cfg.auditUrl ? new AuditClient({ baseUrl: cfg.auditUrl, serviceToken: cfg.serviceToken }) : null;
  const offersUrl = cfg.offersUrl?.replace(/\/+$/, '');
  const inventoryUrl = cfg.inventoryUrl?.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', ...(cfg.serviceToken ? { 'X-Service-Token': cfg.serviceToken } : {}) };

  /** Call MOD-03; its refusals come back as PeerError carrying its message and field details. */
  async function inventory(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!inventoryUrl) NO_INVENTORY();
    let res: Response;
    try {
      res = await fetch(`${inventoryUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(OFFER_FETCH_TIMEOUT_MS) });
    } catch (err) {
      throw new PeerError(502, `The inventory is unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const body = (parsed ?? {}) as { error?: unknown; details?: { message?: unknown }[] };
      const details = Array.isArray(body.details) ? body.details.map((d) => String(d.message)).join('; ') : '';
      const message = typeof body.error === 'string' ? body.error : `The inventory answered ${res.status}`;
      throw new PeerError(res.status, details ? `${message}: ${details}` : message);
    }
    return parsed;
  }

  return {
    inventoryConfigured: Boolean(inventoryUrl),
    async inventoryWarehouses() {
      return ((await inventory('/api/goods-issues/warehouses')) as { warehouses: { code: string; name: string }[] }).warehouses;
    },
    async issueGoods(request: GoodsIssueRequest) {
      await inventory('/api/goods-issues', {
        method: 'POST',
        body: JSON.stringify({
          source: 'mod-17-orders-delivery',
          reference: request.reference,
          warehouse_code: request.warehouseCode,
          actor: request.actor,
          lines: request.lines,
        }),
      });
    },

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
