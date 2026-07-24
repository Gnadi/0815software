import { AuditClient, NotificationClient } from '@0815software/platform-clients';

/**
 * Optional integration with the Platform Services (best-effort, opt-in):
 *   - PS-03 Notification Hub — notify people of key events (approvals, sends)
 *   - PS-07 Audit Log        — record state changes on the tamper-evident trail
 * With no URL configured the module runs standalone; a downstream outage never
 * fails the local operation.
 */

export interface PlatformConfig {
  auditUrl?: string;
  notificationUrl?: string;
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

export interface PlatformHooks {
  audit(info: AuditInfo): Promise<void>;
  notify(info: NotifyInfo): Promise<void>;
}

export const noopPlatform: PlatformHooks = {
  async audit() {
    /* standalone */
  },
  async notify() {
    /* standalone */
  },
};

export function buildPlatform(cfg: PlatformConfig): PlatformHooks {
  const audit = cfg.auditUrl ? new AuditClient({ baseUrl: cfg.auditUrl, serviceToken: cfg.serviceToken }) : null;
  const notify = cfg.notificationUrl
    ? new NotificationClient({ baseUrl: cfg.notificationUrl, serviceToken: cfg.serviceToken })
    : null;
  if (!audit && !notify) return noopPlatform;
  const channel = cfg.channel ?? 'transactional-email';
  return {
    async audit(info: AuditInfo): Promise<void> {
      if (!audit) return;
      try {
        await audit.record(info);
      } catch (err) {
        console.warn('[mod-14] audit failed:', err);
      }
    },
    async notify(info: NotifyInfo): Promise<void> {
      if (!notify || !info.to) return;
      try {
        await notify.send({ channel, to: info.to, subject: info.subject, body: info.body });
      } catch (err) {
        console.warn('[mod-14] notify failed:', err);
      }
    },
  };
}
