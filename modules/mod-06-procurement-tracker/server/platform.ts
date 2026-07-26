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
 * With no URL configured the module runs standalone; a downstream outage never
 * fails the local operation.
 */

export interface PlatformConfig {
  auditUrl?: string;
  notificationUrl?: string;
  customersUrl?: string;
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
}

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
};

export function buildPlatform(cfg: PlatformConfig): PlatformHooks {
  const audit = cfg.auditUrl ? new AuditClient({ baseUrl: cfg.auditUrl, serviceToken: cfg.serviceToken }) : null;
  const notify = cfg.notificationUrl
    ? new NotificationClient({ baseUrl: cfg.notificationUrl, serviceToken: cfg.serviceToken })
    : null;
  const customers = cfg.customersUrl
    ? new CustomersClient({ baseUrl: cfg.customersUrl, serviceToken: cfg.serviceToken })
    : null;
  if (!audit && !notify && !customers) return noopPlatform;
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
  };
}
