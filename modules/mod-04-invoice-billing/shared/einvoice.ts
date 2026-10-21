/**
 * E-invoices — EN 16931 in the UN/CEFACT Cross Industry Invoice syntax (CII
 * D16B), the one XML both German formats are written in:
 *
 *   XRechnung 3.0   the German CIUS of EN 16931 (KoSIT). What German public
 *                   bodies require, and since 1.1.2025 a valid e-invoice for
 *                   B2B under § 14 UStG. Delivered as the bare XML file.
 *   ZUGFeRD 2.3     a PDF/A-3 with this XML embedded as `factur-x.xml`
 *   (Factur-X 1.07) (server/pdfa.ts). Profile EN 16931 ("COMFORT"): a person
 *                   reads the PDF, software reads the XML, and the XML is the
 *                   invoice.
 *
 * The XML of both is produced by ONE renderer from ONE model, so the two can
 * differ only where their specifications do: the specification identifier
 * (BT-24) and the extra fields XRechnung makes mandatory (buyer reference,
 * seller contact, electronic addresses). `eInvoiceProblems` checks a model
 * against a profile before anything is rendered, and names every missing
 * field with its business term — a refusal that says "BT-49 Buyer electronic
 * address" is something an operator can fix; a file the recipient's
 * validator rejects a week later is not.
 *
 * Money is integer cents throughout and comes from shared/money.ts — per-line
 * rounding, VAT once per rate — which is precisely the arithmetic the EN 16931
 * business rules recompute (BR-LIN-04, BR-CO-10, BR-CO-17, BR-S-08). The XML
 * therefore states the same figures as the PDF and the API, to the cent.
 *
 * This file imports nothing from the server: pure, deterministic, testable.
 */

import { computeTotals, lineNetCents } from './money.js';
import type { TaxExemptionCategory } from './types.js';

export const EINVOICE_PROFILES = ['xrechnung', 'zugferd'] as const;
export type EInvoiceProfile = (typeof EINVOICE_PROFILES)[number];

/** BT-24 — what each profile declares it is. */
export const SPECIFICATION_ID: Record<EInvoiceProfile, string> = {
  xrechnung: 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0',
  zugferd: 'urn:cen.eu:en16931:2017',
};

/** BT-23 — the PEPPOL billing process, which XRechnung recipients expect. */
export const BUSINESS_PROCESS_ID = 'urn:fdc:peppol.eu:2017:poacc:billing:01:1.0';

/** The ZUGFeRD / Factur-X attachment name and XMP conformance level. */
export const FACTURX_FILENAME = 'factur-x.xml';
export const FACTURX_CONFORMANCE = 'EN 16931';

/** UNTDID 1001: 380 commercial invoice, 381 credit note (our cancellation). */
export type InvoiceTypeCode = '380' | '381';

/** The seller as frozen into an invoice when it was issued. */
export interface SellerParty {
  name: string;
  address_lines: string[];
  street: string | null;
  postcode: string | null;
  city: string | null;
  country: string | null;
  vat_id: string | null;
  /** Steuernummer (BT-32) — an alternative to the VAT id for a German seller. */
  tax_number: string | null;
  /**
   * BT-30 legal registration, e.g. "HRB 12345" (Handelsregister) or "FN 123456a"
   * (Firmenbuch). EN 16931 wants the seller identifiable by a VAT id OR this
   * (BR-CO-26) — so a seller with only a Steuernummer needs it.
   */
  registration?: string | null;
  iban: string;
  bic: string | null;
  /** BG-6 seller contact — mandatory in XRechnung (BR-DE-2/5/6/7). */
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  /** BT-34 — where replies to e-invoices go. Defaults to `email`. */
  einvoice_address: string | null;
}

/** The buyer as frozen into an invoice when it was issued. */
export interface BuyerParty {
  name: string;
  address: string | null;
  street: string | null;
  postcode: string | null;
  city: string | null;
  country: string | null;
  vat_id: string | null;
  email: string | null;
  /** BT-49 — an email address, or a Leitweg-ID for a German public body. */
  einvoice_address: string | null;
}

export interface EInvoiceLine {
  position: number;
  description: string;
  quantity: number;
  unit_price_cents: number;
  vat_rate: number;
}

/** Everything an e-invoice says — built by server/einvoice-data.ts. */
export interface EInvoiceModel {
  type_code: InvoiceTypeCode;
  number: string;
  issue_date: string;
  due_date: string | null;
  delivery_date: string;
  payment_terms_days: number;
  buyer_reference: string | null;
  note: string | null;
  /** BT-25/26: the invoice a credit note (cancellation) refers to. */
  preceding: { number: string; issue_date: string } | null;
  exemption: { category: TaxExemptionCategory; reason: string | null } | null;
  seller: SellerParty;
  buyer: BuyerParty;
  lines: EInvoiceLine[];
}

export interface EInvoiceProblem {
  /** The EN 16931 business term, e.g. "BT-49", or the module field it maps to. */
  term: string;
  field: string;
  message: string;
}

// ── Tax categories ─────────────────────────────────────────────────────

/** Default exemption texts (BT-120), German, as a recipient's bookkeeper reads them. */
export const EXEMPTION_DEFAULT_REASON: Record<TaxExemptionCategory, string | null> = {
  E: null, // the legal ground differs case by case — the operator must state it
  AE: 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)',
  K: 'Steuerfreie innergemeinschaftliche Lieferung',
  G: 'Steuerfreie Ausfuhrlieferung',
  Z: null,
  O: 'Nicht steuerbarer Umsatz',
};

/** BT-121 — the VATEX code, where the category has a single one. */
const EXEMPTION_CODE: Partial<Record<TaxExemptionCategory, string>> = {
  AE: 'VATEX-EU-AE',
  K: 'VATEX-EU-IC',
  G: 'VATEX-EU-G',
  O: 'VATEX-EU-O',
};

/** The VAT category code of a line: S above 0 %, the invoice's exemption at 0 %. */
export function categoryOf(rate: number, exemption: EInvoiceModel['exemption']): string {
  if (rate > 0) return 'S';
  return exemption?.category ?? '?';
}

// ── Validation ─────────────────────────────────────────────────────────

const VAT_ID_RE = /^[A-Z]{2}[A-Z0-9+*]{2,13}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A Leitweg-ID: Grobadressierung, optional Feinadressierung, two check digits. */
export const LEITWEG_RE = /^\d{2,12}(-[A-Za-z0-9]{1,30})?-\d{2}$/;

/** The schemeID of an electronic address (BT-34-1 / BT-49-1). */
function addressScheme(address: string): string {
  return LEITWEG_RE.test(address) ? '0204' : 'EM';
}

function blank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === '';
}

/**
 * Everything that would make the file invalid under `profile`, as fields to
 * fill in. Empty means it renders and validates.
 *
 * The rules mirrored here are the ones this module's data can violate; the
 * rest of EN 16931 holds by construction (totals are derived, the currency is
 * always EUR, every line has a quantity and a price).
 */
export function eInvoiceProblems(model: EInvoiceModel, profile: EInvoiceProfile): EInvoiceProblem[] {
  const problems: EInvoiceProblem[] = [];
  const add = (term: string, field: string, message: string): void => {
    problems.push({ term, field, message });
  };
  const { seller, buyer } = model;
  const xr = profile === 'xrechnung';

  // ── Seller (BG-4) ──
  if (blank(seller.name)) add('BT-27', 'SELLER_NAME', 'Seller name is missing');
  if (blank(seller.city)) add('BT-37', 'SELLER_CITY', 'Seller city is missing (set SELLER_CITY or an address line "PLZ Ort")');
  if (blank(seller.postcode)) add('BT-38', 'SELLER_POSTCODE', 'Seller postcode is missing');
  if (blank(seller.street)) add('BT-35', 'SELLER_STREET', 'Seller street is missing');
  if (blank(seller.country)) add('BT-40', 'SELLER_COUNTRY', 'Seller country (ISO code, e.g. DE or AT) is missing');
  if (!blank(seller.vat_id) && !VAT_ID_RE.test(seller.vat_id!.replace(/\s/g, ''))) {
    add('BT-31', 'SELLER_VAT_ID', `Seller VAT id "${seller.vat_id}" is not a VAT id (country prefix + number)`);
  }
  if (/^ATU0{8}$/.test(seller.vat_id ?? '')) {
    add('BT-31', 'SELLER_VAT_ID', 'SELLER_VAT_ID is still the shipped placeholder ATU00000000');
  }
  if (blank(seller.iban)) add('BT-84', 'SELLER_IBAN', 'Seller IBAN is missing — the payment instructions need it');
  const notSubject = model.exemption?.category === 'O';
  if ((blank(seller.vat_id) || notSubject) && blank(seller.registration)) {
    add(
      'BT-30',
      'SELLER_REGISTRATION',
      notSubject
        ? 'A "not subject to VAT" invoice may not carry the VAT id, so the seller must be identified by its register number (BR-CO-26, BR-O-02)'
        : 'Without a VAT id the seller must be identified by its register number, e.g. HRB 12345 (BR-CO-26)',
    );
  }

  if (xr) {
    if (blank(seller.contact_name)) add('BT-41', 'SELLER_CONTACT_NAME', 'XRechnung requires a seller contact name');
    if (blank(seller.phone)) add('BT-42', 'SELLER_PHONE', 'XRechnung requires a seller contact phone number');
    if (blank(seller.email)) add('BT-43', 'SELLER_EMAIL', 'XRechnung requires a seller contact email');
    if (blank(seller.einvoice_address ?? seller.email)) {
      add('BT-34', 'SELLER_EINVOICE_ADDRESS', 'XRechnung requires the seller electronic address (SELLER_EINVOICE_ADDRESS or SELLER_EMAIL)');
    }
  }
  if (!blank(seller.email) && !EMAIL_RE.test(seller.email!)) add('BT-43', 'SELLER_EMAIL', 'Seller email is not an email address');

  // ── Buyer (BG-7) ──
  if (blank(buyer.name)) add('BT-44', 'customer.name', 'Buyer name is missing');
  if (blank(buyer.country)) add('BT-55', 'customer.country_code', 'Buyer country (ISO code) is missing');
  if (xr) {
    if (blank(buyer.city)) add('BT-52', 'customer.city', 'XRechnung requires the buyer city');
    if (blank(buyer.postcode)) add('BT-53', 'customer.postcode', 'XRechnung requires the buyer postcode');
    if (blank(buyer.einvoice_address ?? buyer.email)) {
      add('BT-49', 'customer.einvoice_address', 'XRechnung requires the buyer electronic address (e-invoice address, Leitweg-ID or email)');
    }
    if (blank(model.buyer_reference)) {
      add('BT-10', 'buyer_reference', 'XRechnung requires a buyer reference — the Leitweg-ID for a public body, else the customer\'s order or contact reference');
    }
  }

  // ── Tax (BG-23) ──
  const rates = new Set(model.lines.map((l) => l.vat_rate));
  const hasZero = rates.has(0);
  const hasStandard = [...rates].some((r) => r > 0);
  if (hasStandard && blank(seller.vat_id) && blank(seller.tax_number)) {
    add('BT-31', 'SELLER_VAT_ID', 'Lines with VAT need the seller VAT id or tax number (BR-S-02)');
  }
  if (hasZero) {
    const exemption = model.exemption;
    if (!exemption) {
      add('BT-118', 'tax_exemption_category', 'The invoice has 0 % lines — say why (exempt, reverse charge, intra-EU supply, export …)');
    } else {
      const reason = exemption.reason ?? EXEMPTION_DEFAULT_REASON[exemption.category];
      if (exemption.category === 'E' && blank(reason)) {
        add('BT-120', 'tax_exemption_reason', 'An exempt invoice must name the legal ground, e.g. "Steuerfrei nach § 4 Nr. 14 UStG" or the § 19 UStG Kleinunternehmer note');
      }
      if (exemption.category === 'AE' || exemption.category === 'K') {
        if (blank(buyer.vat_id)) add('BT-48', 'customer.vat_id', `${exemption.category === 'AE' ? 'Reverse charge' : 'An intra-EU supply'} requires the buyer's VAT id`);
        if (blank(seller.vat_id)) add('BT-31', 'SELLER_VAT_ID', `${exemption.category === 'AE' ? 'Reverse charge' : 'An intra-EU supply'} requires the seller's VAT id`);
      }
      if (exemption.category === 'O' && hasStandard) {
        add('BT-118', 'tax_exemption_category', '"Not subject to VAT" cannot be combined with taxed lines on one invoice (BR-O-11)');
      }
    }
  }

  // ── Document ──
  if (model.type_code === '381' && !model.preceding) {
    add('BT-25', 'preceding', 'A cancellation must name the invoice it cancels');
  }
  if (model.lines.length === 0) add('BG-25', 'lines', 'An invoice needs at least one line');
  return problems;
}

// ── Rendering ──────────────────────────────────────────────────────────

/** Escape text content and attribute values for XML 1.0. Drops what XML 1.0 forbids. */
export function xmlText(raw: string): string {
  return raw
    .replace(/[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 1234 cents → "12.34" — EN 16931 amounts have two decimals, dot-separated. */
export function amount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Quantities keep up to four decimals, no trailing zeros. */
export function quantity(value: number): string {
  return String(Math.round(value * 10_000) / 10_000);
}

/** Percentages as EN 16931 writes them: "19", "7", "0". */
function percent(rate: number): string {
  return String(rate);
}

/** "2026-01-15" → "20260115" (UNTDID 2379 format 102). */
function d102(iso: string): string {
  return iso.replace(/-/g, '');
}

function deDate(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

/** The payment terms text (BT-20), in German — the recipient's language. */
export function paymentTermsText(model: EInvoiceModel): string {
  if (model.type_code === '381') return 'Gutschrift — wird mit offenen Beträgen verrechnet oder erstattet.';
  if (model.due_date === null || model.payment_terms_days === 0) return 'Zahlbar sofort ohne Abzug.';
  return `Zahlbar innerhalb von ${model.payment_terms_days} Tagen ohne Abzug bis ${deDate(model.due_date)}.`;
}

class Xml {
  private out: string[] = [];
  private depth = 0;

  open(tag: string, attrs = ''): this {
    this.out.push(`${'  '.repeat(this.depth)}<${tag}${attrs}>`);
    this.depth++;
    return this;
  }

  close(tag: string): this {
    this.depth--;
    this.out.push(`${'  '.repeat(this.depth)}</${tag}>`);
    return this;
  }

  leaf(tag: string, value: string, attrs = ''): this {
    this.out.push(`${'  '.repeat(this.depth)}<${tag}${attrs}>${xmlText(value)}</${tag}>`);
    return this;
  }

  /** A leaf only when there is something to say — CII forbids empty elements. */
  opt(tag: string, value: string | null | undefined, attrs = ''): this {
    if (value !== null && value !== undefined && value.trim() !== '') this.leaf(tag, value.trim(), attrs);
    return this;
  }

  date(tag: string, iso: string, ns: 'udt' | 'qdt' = 'udt'): this {
    return this.open(tag).leaf(`${ns}:DateTimeString`, d102(iso), ' format="102"').close(tag);
  }

  toString(): string {
    return this.out.join('\n');
  }
}

function postalAddress(xml: Xml, party: { street: string | null; postcode: string | null; city: string | null; country: string | null }): void {
  // D16B order: PostcodeCode, LineOne, LineTwo, LineThree, CityName, CountryID.
  xml.open('ram:PostalTradeAddress');
  xml.opt('ram:PostcodeCode', party.postcode);
  xml.opt('ram:LineOne', party.street);
  xml.opt('ram:CityName', party.city);
  xml.opt('ram:CountryID', party.country);
  xml.close('ram:PostalTradeAddress');
}

function electronicAddress(xml: Xml, address: string | null): void {
  if (blank(address)) return;
  const value = address!.trim();
  xml
    .open('ram:URIUniversalCommunication')
    .leaf('ram:URIID', value, ` schemeID="${addressScheme(value)}"`)
    .close('ram:URIUniversalCommunication');
}

function taxRegistration(xml: Xml, scheme: 'VA' | 'FC', id: string | null): void {
  if (blank(id)) return;
  xml
    .open('ram:SpecifiedTaxRegistration')
    .leaf('ram:ID', scheme === 'VA' ? id!.replace(/\s/g, '').toUpperCase() : id!.trim(), ` schemeID="${scheme}"`)
    .close('ram:SpecifiedTaxRegistration');
}

/**
 * Render the CII XML. Call `eInvoiceProblems` first — this renders whatever it
 * is given, deterministically: the same model always yields the same bytes.
 */
export function renderCii(model: EInvoiceModel, profile: EInvoiceProfile): string {
  const xml = new Xml();
  const { seller, buyer, exemption } = model;
  const totals = computeTotals(model.lines);
  // "Not subject to VAT" forbids the seller's VAT id and any rate (BR-O-02, BR-O-05).
  const notSubject = exemption?.category === 'O' && totals.by_rate.every((r) => r.rate === 0);

  xml.open(
    'rsm:CrossIndustryInvoice',
    ' xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"' +
      ' xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100"' +
      ' xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"' +
      ' xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"',
  );

  // ── BG-2 process control ──
  xml.open('rsm:ExchangedDocumentContext');
  if (profile === 'xrechnung') {
    xml
      .open('ram:BusinessProcessSpecifiedDocumentContextParameter')
      .leaf('ram:ID', BUSINESS_PROCESS_ID)
      .close('ram:BusinessProcessSpecifiedDocumentContextParameter');
  }
  xml
    .open('ram:GuidelineSpecifiedDocumentContextParameter')
    .leaf('ram:ID', SPECIFICATION_ID[profile])
    .close('ram:GuidelineSpecifiedDocumentContextParameter');
  xml.close('rsm:ExchangedDocumentContext');

  // ── Document header ──
  xml.open('rsm:ExchangedDocument');
  xml.leaf('ram:ID', model.number);
  xml.leaf('ram:TypeCode', model.type_code);
  xml.date('ram:IssueDateTime', model.issue_date);
  if (!blank(model.note)) {
    xml.open('ram:IncludedNote').leaf('ram:Content', model.note!.trim()).close('ram:IncludedNote');
  }
  xml.close('rsm:ExchangedDocument');

  xml.open('rsm:SupplyChainTradeTransaction');

  // ── BG-25 lines ──
  for (const line of model.lines) {
    const category = categoryOf(line.vat_rate, exemption);
    xml.open('ram:IncludedSupplyChainTradeLineItem');
    xml
      .open('ram:AssociatedDocumentLineDocument')
      .leaf('ram:LineID', String(line.position))
      .close('ram:AssociatedDocumentLineDocument');
    xml.open('ram:SpecifiedTradeProduct').leaf('ram:Name', line.description).close('ram:SpecifiedTradeProduct');
    xml
      .open('ram:SpecifiedLineTradeAgreement')
      .open('ram:NetPriceProductTradePrice')
      .leaf('ram:ChargeAmount', amount(line.unit_price_cents))
      .close('ram:NetPriceProductTradePrice')
      .close('ram:SpecifiedLineTradeAgreement');
    xml
      .open('ram:SpecifiedLineTradeDelivery')
      // C62 "one" (unit): this module does not record units of measure.
      .leaf('ram:BilledQuantity', quantity(line.quantity), ' unitCode="C62"')
      .close('ram:SpecifiedLineTradeDelivery');
    xml.open('ram:SpecifiedLineTradeSettlement');
    xml.open('ram:ApplicableTradeTax').leaf('ram:TypeCode', 'VAT').leaf('ram:CategoryCode', category);
    if (category !== 'O') xml.leaf('ram:RateApplicablePercent', percent(line.vat_rate));
    xml.close('ram:ApplicableTradeTax');
    xml
      .open('ram:SpecifiedTradeSettlementLineMonetarySummation')
      .leaf('ram:LineTotalAmount', amount(lineNetCents(line)))
      .close('ram:SpecifiedTradeSettlementLineMonetarySummation');
    xml.close('ram:SpecifiedLineTradeSettlement');
    xml.close('ram:IncludedSupplyChainTradeLineItem');
  }

  // ── BG-4 / BG-7 parties ──
  xml.open('ram:ApplicableHeaderTradeAgreement');
  xml.opt('ram:BuyerReference', model.buyer_reference);

  xml.open('ram:SellerTradeParty');
  xml.leaf('ram:Name', seller.name);
  if (!blank(seller.registration)) {
    xml
      .open('ram:SpecifiedLegalOrganization')
      .leaf('ram:ID', seller.registration!.trim())
      .close('ram:SpecifiedLegalOrganization');
  }
  if (!blank(seller.contact_name) || !blank(seller.phone) || !blank(seller.email)) {
    xml.open('ram:DefinedTradeContact');
    xml.opt('ram:PersonName', seller.contact_name);
    if (!blank(seller.phone)) {
      xml
        .open('ram:TelephoneUniversalCommunication')
        .leaf('ram:CompleteNumber', seller.phone!.trim())
        .close('ram:TelephoneUniversalCommunication');
    }
    if (!blank(seller.email)) {
      xml
        .open('ram:EmailURIUniversalCommunication')
        .leaf('ram:URIID', seller.email!.trim())
        .close('ram:EmailURIUniversalCommunication');
    }
    xml.close('ram:DefinedTradeContact');
  }
  postalAddress(xml, seller);
  electronicAddress(xml, seller.einvoice_address ?? seller.email);
  if (!notSubject) taxRegistration(xml, 'VA', seller.vat_id);
  taxRegistration(xml, 'FC', seller.tax_number);
  xml.close('ram:SellerTradeParty');

  xml.open('ram:BuyerTradeParty');
  xml.leaf('ram:Name', buyer.name);
  postalAddress(xml, buyer);
  electronicAddress(xml, buyer.einvoice_address ?? buyer.email);
  if (!notSubject) taxRegistration(xml, 'VA', buyer.vat_id);
  xml.close('ram:BuyerTradeParty');
  xml.close('ram:ApplicableHeaderTradeAgreement');

  // ── BG-13 delivery ──
  xml.open('ram:ApplicableHeaderTradeDelivery');
  if (exemption?.category === 'K') {
    // BR-IC-12: an intra-EU supply names the country it was delivered to —
    // the buyer's address, since this module records no separate delivery
    // address (and XRechnung wants the whole address once there is one).
    xml.open('ram:ShipToTradeParty');
    xml.leaf('ram:Name', buyer.name);
    postalAddress(xml, buyer);
    xml.close('ram:ShipToTradeParty');
  }
  xml.open('ram:ActualDeliverySupplyChainEvent').date('ram:OccurrenceDateTime', model.delivery_date).close('ram:ActualDeliverySupplyChainEvent');
  xml.close('ram:ApplicableHeaderTradeDelivery');

  // ── Settlement: payment, VAT breakdown, terms, totals ──
  xml.open('ram:ApplicableHeaderTradeSettlement');
  if (model.type_code === '380') xml.leaf('ram:PaymentReference', model.number);
  xml.leaf('ram:InvoiceCurrencyCode', 'EUR');
  if (model.type_code === '381') {
    // A cancellation pays nothing out by itself: it is settled against what
    // is open, or refunded by arrangement — UNTDID 4461 code 97. XRechnung
    // still requires the payment instructions group (BR-DE-1).
    xml
      .open('ram:SpecifiedTradeSettlementPaymentMeans')
      .leaf('ram:TypeCode', '97')
      .close('ram:SpecifiedTradeSettlementPaymentMeans');
  } else {
    xml.open('ram:SpecifiedTradeSettlementPaymentMeans');
    xml.leaf('ram:TypeCode', '58'); // SEPA credit transfer
    xml
      .open('ram:PayeePartyCreditorFinancialAccount')
      .leaf('ram:IBANID', seller.iban.replace(/\s/g, '').toUpperCase())
      .close('ram:PayeePartyCreditorFinancialAccount');
    if (!blank(seller.bic)) {
      xml
        .open('ram:PayeeSpecifiedCreditorFinancialInstitution')
        .leaf('ram:BICID', seller.bic!.trim())
        .close('ram:PayeeSpecifiedCreditorFinancialInstitution');
    }
    xml.close('ram:SpecifiedTradeSettlementPaymentMeans');
  }

  for (const row of totals.by_rate) {
    const category = categoryOf(row.rate, exemption);
    // D16B order: CalculatedAmount, TypeCode, ExemptionReason, BasisAmount,
    // CategoryCode, ExemptionReasonCode, RateApplicablePercent.
    xml.open('ram:ApplicableTradeTax');
    xml.leaf('ram:CalculatedAmount', amount(row.vat_cents));
    xml.leaf('ram:TypeCode', 'VAT');
    if (category !== 'S' && category !== 'Z' && exemption) {
      xml.opt('ram:ExemptionReason', exemption.reason ?? EXEMPTION_DEFAULT_REASON[exemption.category]);
    }
    xml.leaf('ram:BasisAmount', amount(row.base_cents));
    xml.leaf('ram:CategoryCode', category);
    if (category !== 'S' && category !== 'Z' && exemption) xml.opt('ram:ExemptionReasonCode', EXEMPTION_CODE[exemption.category]);
    // On the breakdown even "O" states its 0 — XRechnung requires BT-119 there
    // (BR-DE-14); EN 16931 forbids a rate only on the line (BR-O-05).
    xml.leaf('ram:RateApplicablePercent', percent(row.rate));
    xml.close('ram:ApplicableTradeTax');
  }

  xml.open('ram:SpecifiedTradePaymentTerms');
  xml.leaf('ram:Description', paymentTermsText(model));
  if (model.type_code === '380' && model.due_date) xml.date('ram:DueDateDateTime', model.due_date);
  xml.close('ram:SpecifiedTradePaymentTerms');

  xml.open('ram:SpecifiedTradeSettlementHeaderMonetarySummation');
  xml.leaf('ram:LineTotalAmount', amount(totals.net_cents));
  xml.leaf('ram:TaxBasisTotalAmount', amount(totals.net_cents));
  xml.leaf('ram:TaxTotalAmount', amount(totals.vat_cents), ' currencyID="EUR"');
  xml.leaf('ram:GrandTotalAmount', amount(totals.gross_cents));
  // The document as issued: payments recorded later are not part of it.
  xml.leaf('ram:DuePayableAmount', amount(totals.gross_cents));
  xml.close('ram:SpecifiedTradeSettlementHeaderMonetarySummation');

  if (model.preceding) {
    xml.open('ram:InvoiceReferencedDocument');
    xml.leaf('ram:IssuerAssignedID', model.preceding.number);
    xml.date('ram:FormattedIssueDateTime', model.preceding.issue_date, 'qdt');
    xml.close('ram:InvoiceReferencedDocument');
  }
  xml.close('ram:ApplicableHeaderTradeSettlement');

  xml.close('rsm:SupplyChainTradeTransaction');
  xml.close('rsm:CrossIndustryInvoice');

  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml.toString()}\n`;
}

/** The cancellation document's number: the invoice's, marked as its Storno. */
export function cancellationNumber(invoiceNumber: string): string {
  return `${invoiceNumber}-ST`;
}
