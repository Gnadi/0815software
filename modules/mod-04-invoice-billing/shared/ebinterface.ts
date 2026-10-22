/**
 * ebInterface 6.1 — the Austrian e-invoice, from the same model as XRechnung
 * and ZUGFeRD (shared/einvoice.ts).
 *
 * ebInterface is what the Republic of Austria accepts through e-rechnung.gv.at
 * besides PEPPOL-UBL, and what many Austrian B2B recipients read. It is not an
 * EN 16931 syntax: it has its own structure (AUSTRIAPRO / WKO), its own tax
 * category usage and its own amount rules, so it gets its own renderer and its
 * own readiness check rather than a third "profile" of the CII one.
 *
 * Sources, both vendored or quoted in the tests:
 *  - the schema `Invoice.xsd` 6.1 (test/schema/ebinterface-6p1/), against
 *    which every case is validated;
 *  - the specification `ebInvoice_6p1.pdf` (14.11.2023): ATU00000000 for a
 *    party without a VAT id, the recommended TaxCategoryCode values
 *    (S standard, AA reduced, E/AE/K/G/Z/O exempt or zero), the totals
 *    (TotalGrossAmount = Σ LineItemAmount + taxes; PayableAmount =
 *    TotalGrossAmount − PrepaidAmount + RoundingAmount), and that a
 *    CreditMemo with a positive PayableAmount is a credit note.
 *
 * The Republic additionally needs the supplier number it assigned
 * (Biller/InvoiceRecipientsBillerID — the customer's `supplier_number`) and an
 * order reference (InvoiceRecipient/OrderReference/OrderID — the invoice's
 * buyer reference). Both are written whenever they are known; whether a given
 * recipient requires them is the recipient's rule, documented in
 * docs/E-RECHNUNG.md rather than guessed here.
 */
import { computeTotals, lineNetCents, vatRatesFor } from './money.js';
import {
  amount,
  blank,
  EXEMPTION_DEFAULT_REASON,
  paymentTermsText,
  quantity,
  Xml,
  type EInvoiceModel,
  type EInvoiceProblem,
  type EInvoiceProfile,
  xmlText,
} from './einvoice.js';

/** Every e-invoice format this module issues: the two EN 16931 profiles and ebInterface. */
export type EInvoiceFormat = EInvoiceProfile | 'ebinterface';

export const EBINTERFACE_NAMESPACE = 'http://www.ebinterface.at/schema/6p1/';
export const GENERATING_SYSTEM = '0815software MOD-04 Invoice & Billing';

/** "Falls keine UID vorhanden ist, ist ATU00000000 einzusetzen" (spec 4.4). */
export const NO_VAT_ID = 'ATU00000000';

const COUNTRY_NAME: Record<string, string> = {
  AT: 'Österreich',
  DE: 'Deutschland',
  CH: 'Schweiz',
  IT: 'Italien',
  SI: 'Slowenien',
  HU: 'Ungarn',
  CZ: 'Tschechien',
  SK: 'Slowakei',
};

/**
 * The ebInterface TaxCategoryCode of a line. Above 0 %: S for the seller
 * country's standard rate, AA for a reduced one — the spec's recommendation
 * (10 %, 13 % → AA). At 0 %: the invoice's exemption category, which already
 * uses the same UN/CEFACT 5305 codes (E, AE, K, G, Z, O).
 */
export function ebCategoryOf(rate: number, sellerCountry: string | null, exemption: EInvoiceModel['exemption']): string {
  if (rate === 0) return exemption?.category ?? 'Z';
  const standard = Math.max(...vatRatesFor(sellerCountry ?? ''));
  return rate === standard ? 'S' : 'AA';
}

/**
 * What ebInterface would refuse, in the same shape as `eInvoiceProblems`.
 *
 * The schema needs less than EN 16931 in some places (no buyer reference, no
 * seller contact, and a seller without a VAT id writes ATU00000000 instead of
 * proving a register number) and more in others: both addresses need a town
 * and a postcode. The tax rules are the same — a 0 % line must say why.
 */
export function ebInterfaceProblems(model: EInvoiceModel): EInvoiceProblem[] {
  const problems: EInvoiceProblem[] = [];
  const add = (term: string, field: string, message: string): void => {
    problems.push({ term, field, message });
  };
  const { seller, buyer } = model;

  if (blank(seller.name)) add('BT-27', 'seller.name', 'Seller name is missing');
  if (blank(seller.street)) add('BT-35', 'seller.street', 'Seller street is missing');
  if (blank(seller.city)) add('BT-37', 'seller.city', 'Seller city is missing');
  if (blank(seller.postcode)) add('BT-38', 'seller.postcode', 'Seller postcode is missing');
  if (blank(seller.country)) add('BT-40', 'seller.country', 'Seller country (ISO code, e.g. AT) is missing');
  if (/^ATU0{8}$/.test(seller.vat_id ?? '')) {
    add('BT-31', 'seller.vatId', 'The seller VAT id is still the shipped placeholder ATU00000000 — leave it empty if there is none');
  }
  if (model.type_code === '380' && blank(seller.iban)) {
    add('BT-84', 'seller.iban', 'Seller IBAN is missing — the payment instructions need it');
  }

  if (blank(buyer.name)) add('BT-44', 'customer.name', 'Buyer name is missing');
  if (blank(buyer.city)) add('BT-52', 'customer.city', 'ebInterface requires the buyer town');
  if (blank(buyer.postcode)) add('BT-53', 'customer.postcode', 'ebInterface requires the buyer postcode');
  if (blank(buyer.country)) add('BT-55', 'customer.country_code', 'Buyer country (ISO code) is missing');

  const rates = new Set(model.lines.map((l) => l.vat_rate));
  if (rates.has(0)) {
    const exemption = model.exemption;
    if (!exemption) {
      add('BT-118', 'tax_exemption_category', 'The invoice has 0 % lines — say why (exempt, reverse charge, intra-EU supply, export …)');
    } else {
      const reason = exemption.reason ?? EXEMPTION_DEFAULT_REASON[exemption.category];
      if (exemption.category === 'E' && blank(reason)) {
        add('BT-120', 'tax_exemption_reason', 'An exempt invoice must name the legal ground, e.g. "Kleinunternehmer gem. § 6 Abs. 1 Z 27 UStG"');
      }
      if ((exemption.category === 'AE' || exemption.category === 'K') && blank(buyer.vat_id)) {
        add('BT-48', 'customer.vat_id', `${exemption.category === 'AE' ? 'Reverse charge' : 'An intra-EU supply'} requires the buyer's VAT id`);
      }
      if ((exemption.category === 'AE' || exemption.category === 'K') && blank(seller.vat_id)) {
        add('BT-31', 'seller.vatId', `${exemption.category === 'AE' ? 'Reverse charge' : 'An intra-EU supply'} requires the seller's VAT id`);
      }
    }
  }
  if (model.type_code === '381' && !model.preceding) {
    add('BT-25', 'preceding', 'A cancellation must name the invoice it cancels');
  }
  if (model.lines.length === 0) add('BG-25', 'lines', 'An invoice needs at least one line');
  return problems;
}

function vatId(id: string | null): string {
  return blank(id) ? NO_VAT_ID : id!.replace(/\s/g, '').toUpperCase();
}

function deDate(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

/** The register number as an ebInterface FurtherIdentification, by its prefix. */
function registration(raw: string | null | undefined): { type: string; id: string } | null {
  if (blank(raw)) return null;
  const value = raw!.trim();
  const fn = /^FN\s*(.+)$/i.exec(value);
  // FN = Firmenbuchnummer (AT); anything else (HRB …) is a register number
  // at a court, which the spec's code list calls FR.
  return fn ? { type: 'FN', id: fn[1]!.trim() } : { type: 'FR', id: value };
}

function address(
  xml: Xml,
  party: { name: string; street: string | null; postcode: string | null; city: string | null; country: string | null },
  extra: { phone?: string | null; email?: string | null } = {},
): void {
  const country = (party.country ?? '').toUpperCase();
  xml.open('Address');
  xml.leaf('Name', party.name.trim());
  xml.opt('Street', party.street);
  xml.leaf('Town', (party.city ?? '').trim());
  xml.leaf('ZIP', (party.postcode ?? '').trim());
  xml.leaf('Country', COUNTRY_NAME[country] ?? country, ` CountryCode="${country}"`);
  xml.opt('Phone', extra.phone);
  xml.opt('Email', extra.email);
  xml.close('Address');
}

/**
 * Render ebInterface 6.1. Call `ebInterfaceProblems` first — this renders
 * whatever it is given, deterministically: the same model, the same bytes.
 */
export function renderEbInterface(model: EInvoiceModel): string {
  const xml = new Xml();
  const { seller, buyer, exemption } = model;
  const totals = computeTotals(model.lines);
  const creditNote = model.type_code === '381';
  const exemptionComment = exemption ? (exemption.reason ?? EXEMPTION_DEFAULT_REASON[exemption.category]) : null;

  xml.open(
    'Invoice',
    ` xmlns="${EBINTERFACE_NAMESPACE}" GeneratingSystem="${xmlText(GENERATING_SYSTEM)}"` +
      ` DocumentType="${creditNote ? 'CreditMemo' : 'Invoice'}" InvoiceCurrency="EUR" Language="de"`,
  );
  xml.leaf('InvoiceNumber', model.number);
  xml.leaf('InvoiceDate', model.issue_date);
  if (creditNote && model.preceding) {
    xml
      .open('CancelledOriginalDocument')
      .leaf('InvoiceNumber', model.preceding.number)
      .leaf('InvoiceDate', model.preceding.issue_date)
      .leaf('DocumentType', 'Invoice')
      .leaf('Comment', `Storniert die Rechnung ${model.preceding.number} vom ${deDate(model.preceding.issue_date)}`)
      .close('CancelledOriginalDocument');
  }
  // Tag der Lieferung / Leistung — § 11 UStG wants it on every invoice.
  xml.open('Delivery').leaf('Date', model.delivery_date).close('Delivery');

  // ── Biller ──
  xml.open('Biller');
  xml.leaf('VATIdentificationNumber', vatId(seller.vat_id));
  const register = registration(seller.registration);
  if (register) xml.leaf('FurtherIdentification', register.id, ` IdentificationType="${register.type}"`);
  if (!blank(seller.tax_number)) xml.leaf('FurtherIdentification', seller.tax_number!.trim(), ' IdentificationType="FASTNR"');
  address(xml, seller, { phone: seller.phone, email: seller.email });
  if (!blank(seller.contact_name)) {
    xml.open('Contact').leaf('Name', seller.contact_name!.trim());
    xml.opt('Phone', seller.phone);
    xml.opt('Email', seller.email);
    xml.close('Contact');
  }
  // The supplier number the recipient assigned us — the Republic's Lieferantennummer.
  xml.opt('InvoiceRecipientsBillerID', buyer.supplier_number ?? null);
  xml.close('Biller');

  // ── Invoice recipient ──
  xml.open('InvoiceRecipient');
  xml.leaf('VATIdentificationNumber', vatId(buyer.vat_id));
  if (!blank(model.buyer_reference)) {
    // The order reference — for the Republic the Auftragsreferenz.
    xml.open('OrderReference').leaf('OrderID', model.buyer_reference!.trim()).close('OrderReference');
  }
  address(xml, buyer, { email: buyer.einvoice_address ?? buyer.email });
  xml.close('InvoiceRecipient');

  // ── Lines ──
  xml.open('Details');
  xml.open('ItemList');
  for (const line of model.lines) {
    const net = lineNetCents(line);
    xml.open('ListLineItem');
    xml.leaf('PositionNumber', String(line.position));
    xml.leaf('Description', line.description);
    xml.leaf('Quantity', quantity(line.quantity), ' Unit="C62"');
    xml.leaf('UnitPrice', amount(line.unit_price_cents));
    // Per line only the base and the category: the tax is computed once per
    // rate below, which is how this module (and § 11 UStG) rounds it.
    xml
      .open('TaxItem')
      .leaf('TaxableAmount', amount(net))
      .leaf('TaxPercent', String(line.vat_rate), ` TaxCategoryCode="${ebCategoryOf(line.vat_rate, seller.country, exemption)}"`)
      .close('TaxItem');
    xml.leaf('LineItemAmount', amount(net));
    xml.close('ListLineItem');
  }
  xml.close('ItemList');
  xml.close('Details');

  // ── Tax summary: one item per (rate, category) ──
  xml.open('Tax');
  for (const r of totals.by_rate) {
    xml.open('TaxItem');
    xml.leaf('TaxableAmount', amount(r.base_cents));
    xml.leaf('TaxPercent', String(r.rate), ` TaxCategoryCode="${ebCategoryOf(r.rate, seller.country, exemption)}"`);
    xml.leaf('TaxAmount', amount(r.vat_cents));
    if (r.rate === 0) xml.opt('Comment', exemptionComment);
    xml.close('TaxItem');
  }
  xml.close('Tax');

  xml.leaf('TotalGrossAmount', amount(totals.gross_cents));
  xml.leaf('PayableAmount', amount(totals.gross_cents));

  // A credit note is settled against open amounts or refunded — there is
  // nothing for the recipient to transfer, so it carries no bank details.
  if (!creditNote && !blank(seller.iban)) {
    xml.open('PaymentMethod');
    xml.open('UniversalBankTransaction');
    xml.open('BeneficiaryAccount');
    xml.opt('BIC', seller.bic);
    xml.leaf('IBAN', seller.iban.replace(/\s/g, '').toUpperCase());
    xml.leaf('BankAccountOwner', seller.name.trim().slice(0, 70));
    xml.close('BeneficiaryAccount');
    if (model.number.length <= 35) xml.leaf('PaymentReference', model.number);
    xml.close('UniversalBankTransaction');
    xml.close('PaymentMethod');
  }
  xml.open('PaymentConditions');
  if (!creditNote && model.due_date) xml.leaf('DueDate', model.due_date);
  xml.leaf('Comment', paymentTermsText(model));
  xml.close('PaymentConditions');
  xml.opt('Comment', model.note);
  xml.close('Invoice');

  return `<?xml version="1.0" encoding="UTF-8"?>\n${xml.toString()}\n`;
}
