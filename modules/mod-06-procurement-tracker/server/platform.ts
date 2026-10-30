import { AuditClient, CustomersClient, NotificationClient } from '@0815software/platform-clients';

/**
 * Optional integration with the Platform Services (best-effort, opt-in):
 *   - PS-03 Notification Hub — notify people of key events (approvals, sends)
 *   - PS-07 Audit Log        — record state changes on the tamper-evident trail
 *   - PS-11 Customers        — register a supplier with the stack's party master
 *                              data, as a `supplier` party. Suppliers and
 *                              customers never match each other there, so a
 *                              company you both buy from and sell to stays two
 *                              relationships with two sets of terms.
 *   - MOD-03 Inventory (INVENTORY_URL) — book goods received on an article
 *                              line into stock. A refused or failed booking is
 *                              recorded on the receipt and retried, never a
 *                              reason to refuse the receipt.
 * With no URL configured the module runs standalone; a downstream outage never
 * fails the local operation.
 */

export interface PlatformConfig {
  auditUrl?: string;
  notificationUrl?: string;
  customersUrl?: string;
  inventoryUrl?: string;
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

/** A supplier as PS-11 needs to see it, plus this module's own row id. */
export interface PartyInfo {
  name: string;
  contactPerson: string | null;
  email: string | null;
  localId: number;
}

export interface PlatformHooks {
  audit(info: AuditInfo): Promise<void>;
  notify(info: NotifyInfo): Promise<void>;
  /**
   * Resolve a supplier against PS-11's party master data as a `supplier` party,
   * returning the master id. Null when PS-11 is not configured or unreachable —
   * the local suppliers table is the record either way.
   */
  resolveParty(info: PartyInfo): Promise<number | null>;
  /** Whether MOD-03 is wired at all — decided by configuration, not by asking it. */
  inventoryConfigured: boolean;
  /** MOD-03's warehouses, for the settings screen. Throws `PeerError` when it does not answer. */
  inventoryWarehouses(): Promise<{ code: string; name: string }[]>;
  /** Book a goods receipt in MOD-03; throws `PeerError` with MOD-03's own reason when refused. */
  receiveGoods(request: GoodsReceiptRequest): Promise<void>;
}

export interface GoodsReceiptRequest {
  /** The receipt number, e.g. PO-2026-0003/WE-1 — idempotent in MOD-03. */
  reference: string;
  warehouseCode: string;
  actor: string;
  lines: { sku: string; quantity: number }[];
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
  throw new PeerError(501, 'No inventory is configured — set INVENTORY_URL to book received goods in MOD-03');
};

/** How long MOD-03 gets to answer. */
const PEER_TIMEOUT_MS = 10_000;

export const noopPlatform: PlatformHooks = {
  async audit() {
    /* standalone */
  },
  async notify() {
    /* standalone */
  },
  async resolveParty() {
    /* standalone — the local suppliers table is the only record */
    return null;
  },
  inventoryConfigured: false,
  async inventoryWarehouses() {
    return NO_INVENTORY();
  },
  async receiveGoods() {
    NO_INVENTORY();
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
  const inventoryUrl = cfg.inventoryUrl?.replace(/\/+$/, '');
  if (!audit && !notify && !customers && !inventoryUrl) return noopPlatform;
  const headers = { 'Content-Type': 'application/json', ...(cfg.serviceToken ? { 'X-Service-Token': cfg.serviceToken } : {}) };

  /** Call MOD-03; its refusals come back as PeerError carrying its message and field details. */
  async function inventory(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!inventoryUrl) NO_INVENTORY();
    let res: Response;
    try {
      res = await fetch(`${inventoryUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(PEER_TIMEOUT_MS) });
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

  const channel = cfg.channel ?? 'transactional-email';
  return {
    async audit(info: AuditInfo): Promise<void> {
      if (!audit) return;
      try {
        await audit.record(info);
      } catch (err) {
        console.warn('[mod-06] audit failed:', err);
      }
    },
    async notify(info: NotifyInfo): Promise<void> {
      if (!notify || !info.to) return;
      try {
        await notify.send({ channel, to: info.to, subject: info.subject, body: info.body });
      } catch (err) {
        console.warn('[mod-06] notify failed:', err);
      }
    },
    async resolveParty(info: PartyInfo): Promise<number | null> {
      if (!customers) return null;
      try {
        const { party } = await customers.resolve({
          kind: 'supplier',
          name: info.name,
          contact_person: info.contactPerson,
          email: info.email,
          source: 'mod-06-procurement-tracker',
          external_id: String(info.localId),
        });
        return party.id;
      } catch (err) {
        console.warn('[mod-06] supplier resolve failed:', err);
        return null;
      }
    },
    inventoryConfigured: Boolean(inventoryUrl),
    async inventoryWarehouses() {
      return ((await inventory('/api/goods-issues/warehouses')) as { warehouses: { code: string; name: string }[] }).warehouses;
    },
    async receiveGoods(request: GoodsReceiptRequest) {
      await inventory('/api/goods-receipts', {
        method: 'POST',
        body: JSON.stringify({
          source: 'mod-06-procurement-tracker',
          reference: request.reference,
          warehouse_code: request.warehouseCode,
          actor: request.actor,
          lines: request.lines,
        }),
      });
    },
  };
}
