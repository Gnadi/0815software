import { AuditClient, CustomersClient, type Party } from '@0815software/platform-clients';
import type { ActivityEvent } from '../shared/types.js';

/**
 * Platform Services integration — opt-in, best-effort, standalone by default.
 *
 * The Workspace consumes two services and owns neither:
 *
 * - **PS-07 Audit Log** is where the activity feed comes from. Every module in
 *   the catalogue already records its state changes there, which is why the
 *   feed needs no module-side work at all: it is a read of something the stack
 *   was already writing.
 * - **PS-11 Customers** is where the context bar's customer picker comes from.
 *   It is the only identity every module can be narrowed by, so "the same
 *   customer" means one party id everywhere rather than a name that has to
 *   match in fourteen databases.
 *
 * Unset, both degrade to nothing — an empty feed and a picker that says the
 * service is not configured — and the board still works. That is the same
 * contract every other module's `platform.ts` keeps.
 */

export interface PlatformConfig {
  auditUrl?: string;
  notificationUrl?: string;
  customersUrl?: string;
  serviceToken?: string;
}

export interface AuditInfo {
  actor: string;
  action: string;
  resource: string;
  metadata?: Record<string, unknown>;
}

export interface PlatformHooks {
  /** Record something the shell itself did. Never throws. */
  audit(info: AuditInfo): Promise<void>;
  /** The stack's recent activity, newest first. Empty when unconfigured. */
  activity(limit: number): Promise<ActivityEvent[]>;
  /** Parties matching a search, for the context picker. Empty when unconfigured. */
  parties(search: string, limit: number): Promise<Party[]>;
  /** Is PS-11 wired? The picker says so rather than looking broken. */
  hasCustomers(): boolean;
}

export const noopPlatform: PlatformHooks = {
  async audit() {
    /* standalone */
  },
  async activity() {
    /* standalone — the feed reads a service this stack does not run */
    return [];
  },
  async parties() {
    return [];
  },
  hasCustomers() {
    return false;
  },
};

/**
 * Which module an audit event came from.
 *
 * PS-07 events carry a `resource` like `mod-04-invoice-billing:invoice/12`, and
 * the prefix is the only place the producing module is named. A resource that
 * does not follow the convention yields null and the feed shows the event
 * without a module chip — dropping it would hide real activity because of a
 * formatting detail.
 */
export function moduleOfResource(resource: string): string | null {
  const match = /^(mod-\d{2}-[a-z0-9-]+)[:/]/.exec(resource);
  return match ? match[1]! : null;
}

export function buildPlatform(cfg: PlatformConfig): PlatformHooks {
  const audit = cfg.auditUrl ? new AuditClient({ baseUrl: cfg.auditUrl, serviceToken: cfg.serviceToken }) : null;
  const customers = cfg.customersUrl
    ? new CustomersClient({ baseUrl: cfg.customersUrl, serviceToken: cfg.serviceToken })
    : null;
  if (!audit && !customers) return noopPlatform;

  return {
    async audit(info: AuditInfo): Promise<void> {
      if (!audit) return;
      try {
        await audit.record(info);
      } catch (err) {
        // Best-effort by design: the board already did whatever this records.
        console.warn('[mod-15] audit failed:', err);
      }
    },

    async activity(limit: number): Promise<ActivityEvent[]> {
      if (!audit) return [];
      try {
        const { events } = await audit.list({ limit });
        return events
          .map((event) => ({
            id: event.id,
            at: event.recorded_at,
            actor: event.actor,
            action: event.action,
            resource: event.resource,
            module: moduleOfResource(event.resource),
          }))
          .sort((a, b) => b.at.localeCompare(a.at));
      } catch (err) {
        console.warn('[mod-15] activity lookup failed:', err);
        return [];
      }
    },

    async parties(search: string, limit: number): Promise<Party[]> {
      if (!customers) return [];
      try {
        const { parties } = await customers.list({ q: search || undefined, limit });
        // A merged-away party would put a dead id in the context bar and filter
        // every widget to nothing. PS-11 keeps them readable for referential
        // integrity; a picker is not the place to offer them.
        return parties.filter((party) => party.merged_into === null && party.archived_at === null);
      } catch (err) {
        console.warn('[mod-15] party lookup failed:', err);
        return [];
      }
    },

    hasCustomers(): boolean {
      return customers !== null;
    },
  };
}
