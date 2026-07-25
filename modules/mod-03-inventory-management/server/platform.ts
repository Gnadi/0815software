import { AuditClient } from '@0815software/platform-clients';

/**
 * Optional integration with PS-07 Audit Log. When AUDIT_URL is configured,
 * key state changes are recorded on the tamper-evident trail; otherwise the
 * module runs standalone. Every call is best-effort — an audit outage never
 * fails the local operation.
 */

export interface PlatformConfig {
  auditUrl?: string;
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
}

export const noopPlatform: PlatformHooks = {
  async audit() {
    /* standalone: nothing to do */
  },
};

export function buildPlatform(cfg: PlatformConfig): PlatformHooks {
  const client = cfg.auditUrl ? new AuditClient({ baseUrl: cfg.auditUrl, serviceToken: cfg.serviceToken }) : null;
  if (!client) return noopPlatform;
  return {
    async audit(info: AuditInfo): Promise<void> {
      try {
        await client.record(info);
      } catch (err) {
        console.warn('[mod-03] audit failed:', err);
      }
    },
  };
}
