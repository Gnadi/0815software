/**
 * PS-12 e-Invoicing — wire contract shared between server and clients.
 *
 * The service owns ONE thing: turning an invoice a module already has into a
 * structured electronic invoice the law recognises, and saying plainly when it
 * cannot. Every amount on this contract is an INTEGER in minor units (cents),
 * matching MOD-04's money model — decimals appear exactly once, at the moment
 * the XML is written, so no rounding can enter through the wire format.
 */

export interface FieldError {
  field: string;
  message: string;
}

/**
 * Output syntaxes.
 *
 * `cii` is UN/CEFACT Cross Industry Invoice, the syntax both German national
 * formats are built on: XRechnung is a CII (or UBL) document with a German
 * CIUS applied, and ZUGFeRD/Factur-X is that same CII XML carried inside a
 * PDF. One generator therefore serves all three; the profile only changes the
 * guideline identifier and which extra rules apply.
 */
export const SYNTAXES = ['cii'] as const;
export type Syntax = (typeof SYNTAXES)[number];

/**
 * Guideline profiles, in the order of how much they demand.
 *
 * - `en16931` — the European semantic standard itself (the COMFORT profile in
 *   ZUGFeRD terms). What a cross-border recipient in any member state accepts.
 * - `xrechnung` — the German CIUS. Adds the routing id (Leitweg-ID) that public
 *   authorities address invoices by, and tightens several optional fields into
 *   required ones. This is what German B2G demands and what B2B recipients
 *   most often ask for.
 */
export const PROFILES = ['en16931', 'xrechnung'] as const;
export type Profile = (typeof PROFILES)[number];

/** The guideline identifier written into BT-24, per profile. */
export const GUIDELINE_ID: Record<Profile, string> = {
  en16931: 'urn:cen.eu:en16931:2017',
  xrechnung: 'urn:cen.eu:en16931:2017#compliant#urn:xoev-de:kosit:standard:xrechnung_3.0',
};

/**
 * Document type (BT-3), UNTDID 1001. Only the two a business actually issues:
 * 380 commercial invoice, 381 credit note. MOD-04 never issues a credit note
 * today (a correction is a cancellation plus a new invoice), but the code is
 * carried on the contract because that is a module policy, not a format limit.
 */
export const DOCUMENT_TYPES = ['380', '381'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * VAT category (BT-151 / BT-118), UNTDID 5305 — the subset EN 16931 allows.
 *
 * `S` standard rate · `Z` zero rated · `E` exempt · `AE` reverse charge ·
 * `K` intra-community supply · `G` export outside the EU · `O` outside the
 * scope of VAT.
 *
 * The distinction matters more than the rate does: `E`, `AE`, `K`, `G` and `O`
 * all carry 0 %, and EN 16931 requires an exemption REASON for each of them
 * (BR-E-10, BR-AE-10, BR-IC-10, BR-G-10, BR-O-10). A 0 % line with no stated
 * category is therefore ambiguous, and this service refuses to guess: see
 * `vatCategoryFor` in cii.ts.
 */
export const VAT_CATEGORIES = ['S', 'Z', 'E', 'AE', 'K', 'G', 'O'] as const;
export type VatCategory = (typeof VAT_CATEGORIES)[number];

/** Categories whose whole point is that no VAT is charged. */
export const ZERO_VAT_CATEGORIES: readonly VatCategory[] = ['Z', 'E', 'AE', 'K', 'G', 'O'];

/** Categories EN 16931 requires an exemption reason for. */
export const REASON_REQUIRED_CATEGORIES: readonly VatCategory[] = ['E', 'AE', 'K', 'G', 'O'];

/** A postal address in the structured form EN 16931 requires. */
export interface Address {
  /** BT-35 / BT-50 — street and number. */
  street?: string | null;
  /** BT-37 / BT-52 — city. */
  city?: string | null;
  /** BT-38 / BT-53 — post code. */
  postcode?: string | null;
  /** BT-40 / BT-55 — ISO 3166-1 alpha-2. Mandatory; the invoice fails without it. */
  country_code?: string | null;
}

export interface Party {
  /** BT-27 seller / BT-44 buyer name. Mandatory. */
  name: string;
  /** BT-31 seller / BT-48 buyer VAT identifier. */
  vat_id?: string | null;
  address: Address;
  /** BT-34 / BT-49 — electronic address (email), with its scheme id. */
  email?: string | null;
}

export interface InvoiceLine {
  /** BT-126 — line identifier. Unique within the invoice. */
  id: string;
  /** BT-153 — item name. Mandatory. */
  name: string;
  /** BT-129 — invoiced quantity. */
  quantity: number;
  /** BT-130 — unit of measure, UN/ECE Rec 20. "C62" is "one/piece". */
  unit_code?: string;
  /** BT-146 — item net price, in minor units. */
  unit_price_cents: number;
  /** BT-151 — VAT category for this line. */
  vat_category: VatCategory;
  /** BT-152 — VAT rate as a percentage. */
  vat_rate: number;
  /**
   * BT-131 — line net amount, in minor units.
   *
   * Supplied by the CALLER rather than computed here, deliberately. The caller
   * already computed it to show the customer and to print the PDF, and an
   * e-invoice that disagrees with the paper one by a cent is a dispute. PS-12
   * checks the arithmetic (BR-CO-* / BR-24) and refuses the document if it does
   * not add up — it does not quietly substitute its own answer.
   */
  net_cents: number;
}

/** One row of the VAT breakdown (BG-23) — one per category/rate pair. */
export interface VatBreakdownRow {
  category: VatCategory;
  /** BT-119 — the rate, as a percentage. */
  rate: number;
  /** BT-116 — taxable base for this category/rate, in minor units. */
  base_cents: number;
  /** BT-117 — VAT amount for this category/rate, in minor units. */
  vat_cents: number;
  /** BT-120 — why no VAT is charged. Required for E / AE / K / G / O. */
  exemption_reason?: string | null;
}

export interface PaymentDetails {
  /** BT-84 — the account the money goes to. */
  iban?: string | null;
  /** BT-86 — the servicing bank. */
  bic?: string | null;
  /** BT-83 — remittance information, i.e. what the payer should reference. */
  reference?: string | null;
}

/** Everything needed to issue one structured invoice. */
export interface EInvoiceInput {
  /** BT-1 — the invoice number. Mandatory, and the idempotency key with `source`. */
  number: string;
  /** BT-2 — issue date, "YYYY-MM-DD". */
  issue_date: string;
  /** BT-9 — payment due date, "YYYY-MM-DD". */
  due_date?: string | null;
  /** BT-3 — 380 invoice, 381 credit note. Defaults to 380. */
  document_type?: DocumentType;
  /** BT-5 — ISO 4217. Defaults to EUR. */
  currency?: string;
  /** BT-22 — a free-text note on the document. */
  note?: string | null;
  /** BT-10 — the buyer's own reference; required by the XRechnung profile. */
  buyer_reference?: string | null;
  seller: Party;
  buyer: Party;
  lines: InvoiceLine[];
  vat_breakdown: VatBreakdownRow[];
  /** BT-109 — total without VAT, minor units. */
  net_cents: number;
  /** BT-110 — total VAT, minor units. */
  vat_total_cents: number;
  /** BT-112 — total with VAT, minor units. */
  gross_cents: number;
  /** BT-113 — already paid, minor units. Defaults to 0. */
  paid_cents?: number;
  payment?: PaymentDetails | null;
}

/** A rule that an invoice broke. `rule` is the EN 16931 identifier. */
export interface RuleViolation {
  /** e.g. "BR-09", "BR-CO-15", "BR-DEC-14". */
  rule: string;
  /** The business term at fault, when there is one — e.g. "BT-40". */
  term?: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  profile: Profile;
  violations: RuleViolation[];
}

/** A document PS-12 issued and kept. */
export interface IssuedDocument {
  id: number;
  /** The consumer that asked for it, e.g. "mod-04-invoice-billing". */
  source: string;
  /** BT-1, as issued. Unique per source. */
  number: string;
  profile: Profile;
  syntax: Syntax;
  /** SHA-256 of the XML bytes — what makes "the same document" checkable. */
  sha256: string;
  size_bytes: number;
  issued_at: string;
}

/** A structured invoice somebody sent US, after parsing. */
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
  /** Which syntax it was recognised as. */
  syntax: Syntax;
  /** The guideline identifier the sender claimed (BT-24). */
  guideline_id: string | null;
}
