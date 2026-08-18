import { AuditClient } from '@0815software/platform-clients';

/**
 * Optional integration with PS-07 Audit Log, and nothing else.
 *
 * The Workspace also reads PS-07 (for its activity feed) and PS-11 (for its
 * customer filter). This module needs neither: it shows no figures to filter
 * and no feed to read. It only WRITES — a board created, a pane added — so the
 * trail records how someone's screen came to look the way it does.
 *
 * Best-effort like every module in the catalogue: an audit outage never fails
 * the local operation.
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
        console.warn('[mod-16] audit failed:', err);
      }
    },
  };
}
