import { AuditClient, FilesClient, NotificationClient } from '@0815software/platform-clients';

/**
 * Optional integration with the Platform Services. Every hook is best-effort
 * and never throws: when a service URL is not configured the corresponding
 * client is simply absent and the module keeps its standalone behaviour, so
 * mod-04 still runs perfectly on its own.
 *
 * Wired here:
 *   - PS-03 Notification Hub — email the customer that an invoice was issued
 *   - PS-06 File Storage      — archive the rendered invoice PDF
 *   - PS-07 Audit Log         — record the issue event on the tamper-evident trail
 */

export interface PlatformConfig {
  notificationUrl?: string;
  filesUrl?: string;
  auditUrl?: string;
  serviceToken?: string;
  /** PS-03 channel name to send invoice emails through. */
  invoiceChannel?: string;
}

export interface InvoiceIssuedInfo {
  number: string;
  customerEmail: string | null;
  customerName: string;
  totalFormatted: string;
  pdf: Buffer;
  actor: string;
}

export interface PlatformHooks {
  invoiceIssued(info: InvoiceIssuedInfo): Promise<void>;
}

/** The no-op hooks used when nothing is configured. */
export const noopPlatform: PlatformHooks = {
  async invoiceIssued() {
    /* standalone: nothing to do */
  },
};

export function buildPlatform(cfg: PlatformConfig): PlatformHooks {
  const notify = cfg.notificationUrl
    ? new NotificationClient({ baseUrl: cfg.notificationUrl, serviceToken: cfg.serviceToken })
    : null;
  const files = cfg.filesUrl ? new FilesClient({ baseUrl: cfg.filesUrl, serviceToken: cfg.serviceToken }) : null;
  const audit = cfg.auditUrl ? new AuditClient({ baseUrl: cfg.auditUrl, serviceToken: cfg.serviceToken }) : null;
  if (!notify && !files && !audit) return noopPlatform;

  const channel = cfg.invoiceChannel ?? 'transactional-email';

  return {
    async invoiceIssued(info: InvoiceIssuedInfo): Promise<void> {
      const tasks: Promise<unknown>[] = [];

      if (notify && info.customerEmail) {
        tasks.push(
          notify.send({
            channel,
            to: info.customerEmail,
            subject: `Invoice ${info.number}`,
            body: `Dear ${info.customerName},\n\nyour invoice ${info.number} for ${info.totalFormatted} is attached.`,
          }),
        );
      }
      if (files) {
        tasks.push(files.put('invoices', `${info.number}.pdf`, info.pdf, { content_type: 'application/pdf' }));
      }
      if (audit) {
        tasks.push(
          audit.record({
            actor: info.actor,
            action: 'invoice.issued',
            resource: `invoice:${info.number}`,
            after: { total: info.totalFormatted },
          }),
        );
      }

      // Best-effort: a downstream outage must never fail the local operation.
      const results = await Promise.allSettled(tasks);
      for (const r of results) {
        if (r.status === 'rejected') console.warn('[mod-04] platform hook failed:', r.reason);
      }
    },
  };
}
