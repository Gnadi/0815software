import { AiClient, AuditClient, NotificationClient } from '@0815software/platform-clients';

/**
 * Optional integration with the Platform Services. Every hook is best-effort
 * and degrades to a no-op when the corresponding service URL is not set, so
 * mod-12 keeps working standalone.
 *
 * Wired here:
 *   - PS-03 Notification Hub — acknowledge a new ticket to the requester
 *   - PS-07 Audit Log        — record ticket lifecycle events
 *   - PS-04 AI Platform      — draft a suggested agent reply from the thread
 */

export interface PlatformConfig {
  notificationUrl?: string;
  auditUrl?: string;
  aiUrl?: string;
  serviceToken?: string;
  ackChannel?: string;
}

export interface TicketCreatedInfo {
  ref: string;
  subject: string;
  requesterName: string;
  requesterEmail: string;
}

export interface SuggestReplyInfo {
  ref: string;
  subject: string;
  thread: string;
}

export interface PlatformHooks {
  ticketCreated(info: TicketCreatedInfo): Promise<void>;
  suggestReply(info: SuggestReplyInfo): Promise<string | null>;
}

export const noopPlatform: PlatformHooks = {
  async ticketCreated() {
    /* standalone */
  },
  async suggestReply() {
    return null;
  },
};

export function buildPlatform(cfg: PlatformConfig): PlatformHooks {
  const notify = cfg.notificationUrl
    ? new NotificationClient({ baseUrl: cfg.notificationUrl, serviceToken: cfg.serviceToken })
    : null;
  const audit = cfg.auditUrl ? new AuditClient({ baseUrl: cfg.auditUrl, serviceToken: cfg.serviceToken }) : null;
  const ai = cfg.aiUrl ? new AiClient({ baseUrl: cfg.aiUrl, serviceToken: cfg.serviceToken }) : null;
  if (!notify && !audit && !ai) return noopPlatform;

  const channel = cfg.ackChannel ?? 'transactional-email';

  return {
    async ticketCreated(info: TicketCreatedInfo): Promise<void> {
      const tasks: Promise<unknown>[] = [];
      if (notify && info.requesterEmail) {
        tasks.push(
          notify.send({
            channel,
            to: info.requesterEmail,
            subject: `We received your request [${info.ref}]`,
            body: `Hi ${info.requesterName},\n\nyour request "${info.subject}" is logged as ${info.ref}. We'll be in touch.`,
          }),
        );
      }
      if (audit) {
        tasks.push(
          audit.record({ actor: info.requesterEmail || 'requester', action: 'ticket.created', resource: `ticket:${info.ref}` }),
        );
      }
      const results = await Promise.allSettled(tasks);
      for (const r of results) if (r.status === 'rejected') console.warn('[mod-12] platform hook failed:', r.reason);
    },

    async suggestReply(info: SuggestReplyInfo): Promise<string | null> {
      if (!ai) return null;
      const result = await ai.chat({
        messages: [
          { role: 'system', content: 'You are a helpful support agent. Draft a concise, friendly reply to the customer thread.' },
          { role: 'user', content: `Subject: ${info.subject}\n\nThread:\n${info.thread}` },
        ],
      });
      return result.text ?? null;
    },
  };
}
