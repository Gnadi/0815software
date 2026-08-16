import { BaseClient } from './http.js';

/**
 * PS-12 e-Invoicing — EN 16931 structured invoices.
 *
 * Every amount is an INTEGER in minor units (cents), matching the money model
 * the modules already use. Decimals appear exactly once, inside the service,
 * when the XML is written — so no rounding can enter through this contract.
 */

export type Syntax = 'cii';

/**
 * `en16931` is the European semantic standard; `xrechnung` is the German CIUS
 * on top of it, which additionally requires the buyer reference a recipient
 * routes on, payment instructions, and full postal addresses.
 */
export type Profile = 'en16931' | 'xrechnung';

/** 380 commercial invoice, 381 credit note (UNTDID 1001). */
export type DocumentType = '380' | '381';

/**
 * VAT category (UNTDID 5305). The distinction matters more than the rate:
 * `E`, `AE`, `K`, `G` and `O` all carry 0 % and all legally require a stated
 * exemption reason, which the service enforces.
 */
export type VatCategory = 'S' | 'Z' | 'E' | 'AE' | 'K' | 'G' | 'O';

export interface EInvoiceAddress {
  street?: string | null;
  city?: string | null;
  postcode?: string | null;
  /** ISO 3166-1 alpha-2. Mandatory — an invoice without it is refused. */
  country_code?: string | null;
}

export interface EInvoiceParty {
  name: string;
  vat_id?: string | null;
  address: EInvoiceAddress;
  email?: string | null;
}

export interface InvoiceLine {
  id: string;
  name: string;
  quantity: number;
  /** UN/ECE Rec 20; "C62" (one/piece) when omitted. */
  unit_code?: string;
  unit_price_cents: number;
  vat_category: VatCategory;
  vat_rate: number;
  /** The caller's own line net. The service CHECKS it rather than recomputing. */
  net_cents: number;
}

export interface VatBreakdownRow {
  category: VatCategory;
  rate: number;
  base_cents: number;
  vat_cents: number;
  /** Required for E / AE / K / G / O; forbidden for S and Z. */
  exemption_reason?: string | null;
}

export interface PaymentDetails {
  iban?: string | null;
  bic?: string | null;
  reference?: string | null;
}

export interface EInvoiceInput {
  number: string;
  issue_date: string;
  due_date?: string | null;
  document_type?: DocumentType;
  currency?: string;
  note?: string | null;
  /** The Leitweg-ID a German recipient routes on. Required by `xrechnung`. */
  buyer_reference?: string | null;
  seller: EInvoiceParty;
  buyer: EInvoiceParty;
  lines: InvoiceLine[];
  vat_breakdown: VatBreakdownRow[];
  net_cents: number;
  vat_total_cents: number;
  gross_cents: number;
  paid_cents?: number;
  payment?: PaymentDetails | null;
}

/** A broken rule, carrying its EN 16931 identifier. */
export interface RuleViolation {
  rule: string;
  term?: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  profile: Profile;
  violations: RuleViolation[];
}

export interface IssuedDocument {
  id: number;
  source: string;
  number: string;
  profile: Profile;
  syntax: Syntax;
  sha256: string;
  size_bytes: number;
  issued_at: string;
}

export interface IssueResult {
  document: IssuedDocument;
  xml: string;
  /** True when a previous call had already issued this document. */
  replayed: boolean;
}

export interface InboundInvoice {
  number: string | null;
  issue_date: string | null;
  currency: string | null;
  seller_name: string | null;
  seller_vat_id: string | null;
  buyer_name: string | null;
  net_cents: number | null;
  vat_total_cents: number | null;
  gross_cents: number | null;
  syntax: Syntax;
  guideline_id: string | null;
}

export class EInvoiceClient extends BaseClient {
  /**
   * Check an invoice WITHOUT issuing it.
   *
   * Worth calling while the invoice is still a draft: it tells the operator
   * what is missing before the number is assigned and the document becomes
   * immutable, which is the only moment the fix is still cheap.
   */
  async validate(invoice: EInvoiceInput, profile: Profile = 'en16931'): Promise<ValidationResult> {
    return this.apiPost<ValidationResult>('/api/validate', { invoice, profile });
  }

  /**
   * Issue a structured invoice.
   *
   * Idempotent per `(source, invoice number)` — a retry after a timeout returns
   * the document already issued, byte for byte, rather than a second document
   * under a number that is legally unique. Throws with the failing rule
   * identifiers when the invoice does not satisfy the profile.
   */
  async issue(
    source: string,
    invoice: EInvoiceInput,
    profile: Profile = 'en16931',
  ): Promise<IssueResult> {
    return this.apiPost<IssueResult>('/api/documents', { source, invoice, profile });
  }

  async getDocument(source: string, number: string): Promise<{ document: IssuedDocument; xml: string }> {
    return this.apiGet<{ document: IssuedDocument; xml: string }>(
      `/api/documents/${encodeURIComponent(source)}/${encodeURIComponent(number)}`,
    );
  }

  async listDocuments(params: { source?: string; limit?: number } = {}): Promise<{ documents: IssuedDocument[] }> {
    const query = new URLSearchParams();
    if (params.source) query.set('source', params.source);
    if (params.limit !== undefined) query.set('limit', String(params.limit));
    const suffix = query.toString();
    return this.apiGet<{ documents: IssuedDocument[] }>(`/api/documents${suffix ? `?${suffix}` : ''}`);
  }

  /**
   * Record a structured invoice a third party sent us — the obligation German
   * businesses have had since 2025-01-01. Deduplicated by content, so the same
   * document arriving twice is one document.
   */
  async receive(xml: string): Promise<{ id: number; invoice: InboundInvoice; duplicate: boolean }> {
    return this.apiPost<{ id: number; invoice: InboundInvoice; duplicate: boolean }>('/api/inbound', { xml });
  }

  async listInbound(limit?: number): Promise<{ invoices: (InboundInvoice & { id: number; received_at: string })[] }> {
    return this.apiGet<{ invoices: (InboundInvoice & { id: number; received_at: string })[] }>(
      `/api/inbound${limit === undefined ? '' : `?limit=${limit}`}`,
    );
  }
}
