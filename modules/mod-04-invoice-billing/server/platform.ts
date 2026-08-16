import {
  AuditClient,
  CustomersClient,
  EInvoiceClient,
  FilesClient,
  NotificationClient,
  NumberClient,
  PaymentsClient,
} from '@0815software/platform-clients';
import type { EInvoiceInput, IssueResult, Profile, ValidationResult } from '@0815software/platform-clients';
import type { SelfParty } from './seller.js';
import type { StructuredAddress } from './einvoice.js';

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
 *   - PS-08 Payments          — collect payment for an invoice's open balance
 *   - PS-11 Customers         — resolve an imported customer against the
 *                               stack's party master data, so billing an offer
 *                               bills the same party the quote was for
 *   - PS-12 e-Invoicing       — issue the same invoice as an EN 16931
 *                               structured document. Unset, this module is
 *                               exactly what it always was: a PDF. Set, the
 *                               PDF is unchanged and a structured document is
 *                               available alongside it.
 *   - MOD-13 Offers           — fetch an accepted offer as a neutral document
 *                               transfer (shared/transfer.ts). The one call
 *                               here that is not a Platform Service; it is
 *                               isolated behind `fetchOffer` so re-pointing it
 *                               at another source touches only this file.
 */

/**
 * Raised when a configured offer source refuses or fails. Carries the upstream
 * status so the route can pass a useful code to the operator rather than 500.
 */
/** How long the offer source gets to answer before the import gives up. */
const OFFER_FETCH_TIMEOUT_MS = 10_000;

export class OfferFetchError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'OfferFetchError';
    this.status = status;
  }
}

export interface PlatformConfig {
  notificationUrl?: string;
  filesUrl?: string;
  auditUrl?: string;
  paymentsUrl?: string;
  numberUrl?: string;
  customersUrl?: string;
  einvoiceUrl?: string;
  /** Base URL of MOD-13 Offers, for billing an accepted offer. */
  offersUrl?: string;
  serviceToken?: string;
  /** PS-03 channel name to send invoice emails through. */
  invoiceChannel?: string;
  /** PS-10 scope for invoice numbers (default "invoice"). */
  numberScope?: string;
  /** Which EN 16931 profile to issue: "en16931" or "xrechnung". */
  einvoiceProfile?: string;
}

export interface InvoiceIssuedInfo {
  number: string;
  customerEmail: string | null;
  customerName: string;
  totalFormatted: string;
  pdf: Buffer;
  actor: string;
}

export interface PayInvoiceInfo {
  number: string;
  amountMinor: number;
  currency: string;
}

/** Result of a payment attempt, or null when Payments is not configured. */
export type PaymentResult = { status: string; public_id: string } | null;

/** A customer as PS-11 needs to see it. */
export interface PartyInfo {
  name: string;
  email: string | null;
  vatId: string | null;
  addressLines: string[];
  /** The exporting module and its id for this customer, for traceability. */
  source: string;
  externalId: string;
}

/** Recorded when an offer is billed, so the hand-off is on the audit chain. */
export interface OfferBilledInfo {
  offerNumber: string;
  invoiceId: number;
  customerName: string;
  totalFormatted: string;
  actor: string;
}

export interface PlatformHooks {
  invoiceIssued(info: InvoiceIssuedInfo): Promise<void>;
  payInvoice(info: PayInvoiceInfo): Promise<PaymentResult>;
  /** The next invoice number from PS-10, or null to use the local counter. */
  nextInvoiceNumber(): Promise<string | null>;
  /**
   * Resolve a customer against PS-11's party master data. Returns null when
   * PS-11 is not configured or unreachable; the caller then falls back to its
   * own local matching, so an import works with no platform at all.
   */
  resolveParty(info: PartyInfo): Promise<number | null>;
  /**
   * Register THIS module's own customer id against a PS-11 party, so the master
   * record knows both modules refer to it. Best-effort and idempotent on the
   * PS-11 side; a failure leaves the local row untouched.
   */
  linkParty(partyId: number, localCustomerId: number): Promise<void>;
  /**
   * Fetch an accepted offer from MOD-13 as a document transfer. Returns null
   * when OFFERS_URL is unset — the standalone posture, in which this module has
   * no notion of offers. NOT best-effort: a configured source that fails must
   * surface, because silently inventing an empty invoice would be worse.
   */
  fetchOffer(offerNumber: string): Promise<unknown | null>;
  /** Record the quote-to-invoice hand-off on PS-07, when configured. */
  offerBilled(info: OfferBilledInfo): Promise<void>;
  /**
   * The stack owner's own party from PS-11 — the seller letterhead. Null when
   * PS-11 is unset, has no `self` party yet, or is unreachable; the module then
   * keeps its SELLER_* environment values. See server/seller.ts.
   */
  fetchSelf(): Promise<SelfParty | null>;
  /**
   * A party's structured postal address from PS-11 — what EN 16931 needs and
   * this module's free-text `address` column cannot supply. Null when PS-11 is
   * unset, unreachable, or has no such party; the e-invoice route then names
   * the missing field instead of inventing a country.
   */
  fetchPartyAddress(partyId: number): Promise<StructuredAddress | null>;
  /**
   * Issue the invoice as an EN 16931 structured document. Null when PS-12 is
   * not configured — the standalone posture, in which this module has no
   * notion of e-invoicing at all.
   *
   * NOT best-effort, deliberately. Every other hook here degrades silently
   * because losing it costs a side effect; losing this one costs the document
   * the operator asked for, and a legally mandated one at that. A failure
   * surfaces so they can act on it rather than believing an e-invoice went out.
   */
  issueEInvoice(invoice: EInvoiceInput): Promise<IssueResult | null>;
  /** Check an invoice against the profile without issuing it. */
  checkEInvoice(invoice: EInvoiceInput): Promise<ValidationResult | null>;
  /** The profile this deployment issues, for the operator to see. */
  einvoiceProfile(): Profile | null;
}

/** The no-op hooks used when nothing is configured. */
export const noopPlatform: PlatformHooks = {
  async invoiceIssued() {
    /* standalone: nothing to do */
  },
  async payInvoice() {
    return null;
  },
  async nextInvoiceNumber() {
    return null;
  },
  async resolveParty() {
    return null;
  },
  async linkParty() {
    /* standalone */
  },
  async fetchOffer() {
    return null;
  },
  async offerBilled() {
    /* standalone: nothing to do */
  },
  async fetchSelf() {
    return null;
  },
  async fetchPartyAddress() {
    return null;
  },
  async issueEInvoice() {
    return null;
  },
  async checkEInvoice() {
    return null;
  },
  einvoiceProfile() {
    return null;
  },
};

export function buildPlatform(cfg: PlatformConfig): PlatformHooks {
  const notify = cfg.notificationUrl
    ? new NotificationClient({ baseUrl: cfg.notificationUrl, serviceToken: cfg.serviceToken })
    : null;
  const files = cfg.filesUrl ? new FilesClient({ baseUrl: cfg.filesUrl, serviceToken: cfg.serviceToken }) : null;
  const audit = cfg.auditUrl ? new AuditClient({ baseUrl: cfg.auditUrl, serviceToken: cfg.serviceToken }) : null;
  const payments = cfg.paymentsUrl ? new PaymentsClient({ baseUrl: cfg.paymentsUrl, serviceToken: cfg.serviceToken }) : null;
  const numbers = cfg.numberUrl ? new NumberClient({ baseUrl: cfg.numberUrl, serviceToken: cfg.serviceToken }) : null;
  const customers = cfg.customersUrl
    ? new CustomersClient({ baseUrl: cfg.customersUrl, serviceToken: cfg.serviceToken })
    : null;
  const einvoice = cfg.einvoiceUrl
    ? new EInvoiceClient({ baseUrl: cfg.einvoiceUrl, serviceToken: cfg.serviceToken })
    : null;
  const offersUrl = cfg.offersUrl ? cfg.offersUrl.replace(/\/+$/, '') : null;
  if (!notify && !files && !audit && !payments && !numbers && !customers && !einvoice && !offersUrl) {
    return noopPlatform;
  }

  const channel = cfg.invoiceChannel ?? 'transactional-email';
  const numberScope = cfg.numberScope ?? 'invoice';
  const profile: Profile = cfg.einvoiceProfile === 'xrechnung' ? 'xrechnung' : 'en16931';

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

    async nextInvoiceNumber(): Promise<string | null> {
      if (!numbers) return null;
      // Not best-effort: numbering is authoritative, so a failure propagates
      // rather than silently falling back to the local counter.
      const n = await numbers.next(numberScope);
      return n.formatted;
    },

    async payInvoice(info: PayInvoiceInfo): Promise<PaymentResult> {
      if (!payments) return null;
      // Idempotent on the invoice number, so retries never double-charge.
      const intent = await payments.createIntent({
        reference: `invoice:${info.number}`,
        amount_minor: info.amountMinor,
        currency: info.currency,
        confirm: true,
        idempotency_key: `invoice:${info.number}`,
      });
      return { status: intent.status, public_id: intent.public_id };
    },

    async resolveParty(info: PartyInfo): Promise<number | null> {
      if (!customers) return null;
      try {
        const { party } = await customers.resolve({
          name: info.name,
          email: info.email,
          vat_id: info.vatId,
          address_lines: info.addressLines,
          source: info.source,
          external_id: info.externalId,
        });
        return party.id;
      } catch (err) {
        console.warn('[mod-04] customer resolve failed:', err);
        return null;
      }
    },

    async linkParty(partyId: number, localCustomerId: number): Promise<void> {
      if (!customers) return;
      try {
        await customers.link(partyId, 'mod-04-invoice-billing', String(localCustomerId));
      } catch (err) {
        console.warn('[mod-04] customer link failed:', err);
      }
    },

    async fetchOffer(offerNumber: string): Promise<unknown | null> {
      if (!offersUrl) return null;
      // Bounded like every platform-client call: an offers instance that
      // accepts the connection and then stalls must not hold the operator's
      // import request open indefinitely.
      const res = await fetch(`${offersUrl}/api/offers/${encodeURIComponent(offerNumber)}/transfer`, {
        headers: cfg.serviceToken ? { 'X-Service-Token': cfg.serviceToken } : {},
        signal: AbortSignal.timeout(OFFER_FETCH_TIMEOUT_MS),
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : undefined;
      } catch {
        parsed = text;
      }
      if (!res.ok) {
        const message =
          parsed && typeof parsed === 'object' && 'error' in parsed
            ? String((parsed as { error: unknown }).error)
            : `offer ${offerNumber} could not be fetched (${res.status})`;
        throw new OfferFetchError(res.status, message);
      }
      return parsed;
    },

    async fetchSelf(): Promise<SelfParty | null> {
      if (!customers) return null;
      try {
        const { party } = await customers.self();
        return party;
      } catch (err) {
        console.warn('[mod-04] seller lookup failed:', err);
        return null;
      }
    },

    async fetchPartyAddress(partyId: number): Promise<StructuredAddress | null> {
      if (!customers) return null;
      try {
        const { party } = await customers.get(partyId);
        return {
          street: party.street,
          postcode: party.postcode,
          city: party.city,
          country_code: party.country_code,
        };
      } catch (err) {
        console.warn('[mod-04] party address lookup failed:', err);
        return null;
      }
    },

    async issueEInvoice(invoice: EInvoiceInput): Promise<IssueResult | null> {
      if (!einvoice) return null;
      return einvoice.issue('mod-04-invoice-billing', invoice, profile);
    },

    async checkEInvoice(invoice: EInvoiceInput): Promise<ValidationResult | null> {
      if (!einvoice) return null;
      return einvoice.validate(invoice, profile);
    },

    einvoiceProfile(): Profile | null {
      return einvoice ? profile : null;
    },

    async offerBilled(info: OfferBilledInfo): Promise<void> {
      if (!audit) return;
      try {
        await audit.record({
          actor: info.actor,
          action: 'invoice.imported_from_offer',
          resource: `invoice:draft:${info.invoiceId}`,
          metadata: {
            offer_number: info.offerNumber,
            customer: info.customerName,
            total: info.totalFormatted,
          },
        });
      } catch (err) {
        console.warn('[mod-04] audit failed:', err);
      }
    },
  };
}
