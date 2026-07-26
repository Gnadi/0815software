import { AuditClient, CustomersClient } from '@0815software/platform-clients';

/**
 * Optional integration with the Platform Services:
 *   - PS-07 Audit Log  — record key state changes on the tamper-evident trail
 *   - PS-11 Customers  — register a company with the stack's party master data,
 *                        so the module that later quotes or invoices it resolves
 *                        the SAME party instead of creating a second record
 * Both opt-in and best-effort: with the URLs unset the module runs standalone,
 * and a downstream outage never fails the local operation.
 */

export interface PlatformConfig {
  auditUrl?: string;
  customersUrl?: string;
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

/** A company as PS-11 needs to see it, plus this module's own row id. */
export interface PartyInfo {
  name: string;
  email: string | null;
  localId: number;
}

export interface PlatformHooks {
  audit(info: AuditInfo): Promise<void>;
  /**
   * Resolve a company against PS-11's party master data, returning the master
   * party id. Null when PS-11 is not configured or unreachable — the local
   * companies table is the record either way, so nothing depends on this.
   */
  resolveParty(info: PartyInfo): Promise<number | null>;
}

export const noopPlatform: PlatformHooks = {
  async audit() {
    /* standalone: nothing to do */
  },
  async resolveParty() {
    /* standalone — the local companies table is the only record */
    return null;
  },
};

export function buildPlatform(cfg: PlatformConfig): PlatformHooks {
  const client = cfg.auditUrl ? new AuditClient({ baseUrl: cfg.auditUrl, serviceToken: cfg.serviceToken }) : null;
  const customers = cfg.customersUrl
    ? new CustomersClient({ baseUrl: cfg.customersUrl, serviceToken: cfg.serviceToken })
    : null;
  if (!client && !customers) return noopPlatform;
  return {
    async audit(info: AuditInfo): Promise<void> {
      if (!client) return;
      try {
        await client.record(info);
      } catch (err) {
        console.warn('[mod-10] audit failed:', err);
      }
    },
    async resolveParty(info: PartyInfo): Promise<number | null> {
      if (!customers) return null;
      try {
        const { party } = await customers.resolve({
          name: info.name,
          email: info.email,
          source: 'mod-10-crm-lite',
          external_id: String(info.localId),
        });
        return party.id;
      } catch (err) {
        console.warn('[mod-10] customer resolve failed:', err);
        return null;
      }
    },
  };
}
