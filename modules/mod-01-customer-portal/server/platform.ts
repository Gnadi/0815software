import { AuditClient } from '@0815software/platform-clients';

/**
 * Optional integration with PS-07 Audit Log. When AUDIT_URL is configured,
 * security-relevant customer actions are recorded on the tamper-evident trail;
 * otherwise the module runs standalone. Best-effort — an audit outage never
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
  metadata?: Record<string, unknown>;
}

export interface PlatformHooks {
  audit(info: AuditInfo): Promise<void>;
}

export const noopPlatform: PlatformHooks = {
  async audit() {
    /* standalone */
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
        console.warn('[mod-01] audit failed:', err);
      }
    },
  };
}
