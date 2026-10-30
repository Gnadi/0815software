import { AiClient, AuditClient, FilesClient, IntegrationClient, NotificationClient, type MailFetchResult, type MailboxProbeResult } from '@0815software/platform-clients';

/**
 * Optional integration with the Platform Services. Every hook is best-effort
 * and degrades to a no-op when the corresponding service URL is not set, so
 * mod-12 keeps working standalone.
 *
 * Wired here:
 *   - PS-03 Notification Hub — acknowledge a new ticket; and, when switched
 *     on in the settings, mail public replies and the rating invitation
 *   - PS-07 Audit Log        — record ticket lifecycle events
 *   - PS-04 AI Platform      — draft a suggested agent reply from the thread
 *   - PS-06 File Storage     — a copy of every attachment (the module keeps
 *     and serves its own either way)
 *   - PS-05 Integration Hub  — read a mailbox (server/mailbox.ts)
 */

export interface PlatformConfig {
  notificationUrl?: string;
  auditUrl?: string;
  aiUrl?: string;
  filesUrl?: string;
  integrationUrl?: string;
  serviceToken?: string;
  ackChannel?: string;
}

export interface TicketCreatedInfo {
  ref: string;
  subject: string;
  requesterName: string;
  requesterEmail: string;
  /** The requester's status page, when the public address is known. */
  statusUrl?: string;
}

export interface SuggestReplyInfo {
  ref: string;
  subject: string;
  thread: string;
}

export interface RequesterMail {
  to: string;
  subject: string;
  body: string;
  /** PS-03 deduplicates on it: a retried request mails once. */
  idempotencyKey: string;
}

export interface AttachmentCopy {
  ref: string;
  id: number;
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/** The PS-05 calls the mailbox poller makes — present only with INTEGRATION_URL. */
export interface MailboxApi {
  connections(): Promise<{ id: number; name: string; account: string | null; status: string }[]>;
  probe(connectionId: number): Promise<MailboxProbeResult>;
  fetch(connectionId: number, limit: number): Promise<MailFetchResult>;
  ack(connectionId: number, uidvalidity: number, uids: number[]): Promise<number>;
}

export interface PlatformHooks {
  ticketCreated(info: TicketCreatedInfo): Promise<void>;
  suggestReply(info: SuggestReplyInfo): Promise<string | null>;
  /** True when PS-03 is wired — the settings screen says so. */
  notificationConfigured?: boolean;
  mailRequester?(mail: RequesterMail): Promise<void>;
  attachmentStored?(copy: AttachmentCopy): Promise<void>;
  mailbox?: MailboxApi;
}

export const noopPlatform: PlatformHooks = {
  async ticketCreated() {
    /* standalone */
  },
  async suggestReply() {
    return null;
  },
};

const BUCKET = 'mod-12-attachments';

export function buildPlatform(cfg: PlatformConfig): PlatformHooks {
  const notify = cfg.notificationUrl
    ? new NotificationClient({ baseUrl: cfg.notificationUrl, serviceToken: cfg.serviceToken })
    : null;
  const audit = cfg.auditUrl ? new AuditClient({ baseUrl: cfg.auditUrl, serviceToken: cfg.serviceToken }) : null;
  const ai = cfg.aiUrl ? new AiClient({ baseUrl: cfg.aiUrl, serviceToken: cfg.serviceToken }) : null;
  const files = cfg.filesUrl ? new FilesClient({ baseUrl: cfg.filesUrl, serviceToken: cfg.serviceToken }) : null;
  // The mailbox is read as a machine: PS-05 opens its mail routes to the
  // service token, and to nothing less.
  const integration = cfg.integrationUrl && cfg.serviceToken ? new IntegrationClient({ baseUrl: cfg.integrationUrl, serviceToken: cfg.serviceToken }) : null;
  if (!notify && !audit && !ai && !files && !integration) return noopPlatform;

  const channel = cfg.ackChannel ?? 'transactional-email';
  let bucketReady = false;

  return {
    notificationConfigured: notify !== null,

    async ticketCreated(info: TicketCreatedInfo): Promise<void> {
      const tasks: Promise<unknown>[] = [];
      if (notify && info.requesterEmail) {
        tasks.push(
          notify.send({
            channel,
            to: info.requesterEmail,
            subject: `We received your request [${info.ref}]`,
            body: `Hi ${info.requesterName},\n\nyour request "${info.subject}" is logged as ${info.ref}. We'll be in touch.${info.statusUrl ? `\n\nFollow it here: ${info.statusUrl}` : ''}`,
            idempotency_key: `mod-12:ack:${info.ref}`,
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

    ...(notify
      ? {
          async mailRequester(mail: RequesterMail): Promise<void> {
            await notify.send({ channel, to: mail.to, subject: mail.subject, body: mail.body, idempotency_key: mail.idempotencyKey });
          },
        }
      : {}),

    ...(files
      ? {
          async attachmentStored(copy: AttachmentCopy): Promise<void> {
            if (!bucketReady) {
              // An existing bucket answers 409 — that is the point reached.
              await files.createBucket(BUCKET).catch(() => undefined);
              bucketReady = true;
            }
            await files.put(BUCKET, `${copy.ref}/${copy.id}-${copy.filename}`, copy.bytes, { content_type: copy.contentType, metadata: { ticket: copy.ref } });
          },
        }
      : {}),

    ...(integration
      ? {
          mailbox: {
            async connections() {
              const { connections } = await integration.listMailboxes();
              return connections.map((c) => ({ id: c.id, name: c.name, account: c.external_account, status: c.status }));
            },
            probe: (id: number) => integration.probeMailbox(id),
            fetch: (id: number, limit: number) => integration.fetchMail(id, { limit }),
            async ack(id: number, uidvalidity: number, uids: number[]) {
              return (await integration.ackMail(id, uidvalidity, uids)).acknowledged;
            },
          },
        }
      : {}),
  };
}
