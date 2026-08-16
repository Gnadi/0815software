import { el, renderXml, type XmlNode } from './xml.js';
import {
  GUIDELINE_ID,
  ZERO_VAT_CATEGORIES,
  type EInvoiceInput,
  type InvoiceLine,
  type Party,
  type Profile,
  type VatBreakdownRow,
} from '../shared/types.js';

/**
 * EN 16931 in UN/CEFACT CII syntax — the document generator.
 *
 * One generator serves all three formats a German or Austrian business is asked
 * for, because they are the same XML with different labels on it:
 *
 *   - **EN 16931 / ZUGFeRD COMFORT** — this document, as-is.
 *   - **XRechnung** — this document with the German CIUS guideline id and its
 *     extra required fields (see `profile`).
 *   - **ZUGFeRD / Factur-X** — this document embedded in a PDF/A-3.
 *
 * Two things are load-bearing and easy to get wrong:
 *
 * **Element order.** CII is defined as `xsd:sequence`, so the order below is
 * not style — a recipient's schema validator rejects a document whose elements
 * are transposed, and it will not tell you which one. The order here follows
 * the CII D16B schema, and the tests assert on whole documents rather than on
 * individual values so a reordering cannot pass unnoticed.
 *
 * **Decimals appear exactly once.** Every amount arrives as an integer in minor
 * units and is turned into a decimal string by `amount()` at the moment it is
 * written. Nothing upstream of that line does floating-point arithmetic on
 * money, so no rounding can enter through this file.
 */

const NS = {
  rsm: 'urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100',
  ram: 'urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100',
  udt: 'urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100',
};

/**
 * An integer minor-unit amount as the two-decimal string EN 16931 wants
 * (BR-DEC-*: monetary amounts carry at most two decimals).
 *
 * Integer arithmetic throughout — `-5` must render as "-0.05", not "-0.5", and
 * dividing by 100 in floating point is exactly how that goes wrong.
 */
export function amount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** A percentage with the trailing zeros EN 16931 tolerates trimmed off. */
export function percent(rate: number): string {
  return Number.isInteger(rate) ? String(rate) : String(Number(rate.toFixed(2)));
}

/** "YYYY-MM-DD" → "YYYYMMDD", the format-102 form CII dates use. */
export function ciiDate(iso: string): string {
  return iso.replaceAll('-', '');
}

function dateNode(name: string, iso: string): XmlNode {
  return el(name, [el('udt:DateTimeString', ciiDate(iso), { format: '102' })]);
}

/**
 * The postal address block.
 *
 * Only the country code is unconditional — EN 16931 makes it mandatory
 * (BR-09 for the seller, BR-11 for the buyer) while leaving city and post code
 * to the CIUS. Empty fields are OMITTED rather than written as empty elements:
 * an empty `<ram:CityName/>` asserts "the city is the empty string", which is a
 * different and worse claim than not knowing it.
 */
function addressNode(party: Party): XmlNode {
  const { address } = party;
  const children: XmlNode[] = [];
  if (address.postcode) children.push(el('ram:PostcodeCode', address.postcode));
  if (address.street) children.push(el('ram:LineOne', address.street));
  if (address.city) children.push(el('ram:CityName', address.city));
  children.push(el('ram:CountryID', address.country_code ?? ''));
  return el('ram:PostalTradeAddress', children);
}

function partyNode(name: string, party: Party): XmlNode {
  const children: XmlNode[] = [el('ram:Name', party.name)];
  if (party.email) {
    // scheme "EM" is the electronic-address scheme for an email (BT-34/BT-49).
    children.push(el('ram:URIUniversalCommunication', [el('ram:URIID', party.email, { schemeID: 'EM' })]));
  }
  children.push(addressNode(party));
  if (party.vat_id) {
    children.push(el('ram:SpecifiedTaxRegistration', [el('ram:ID', party.vat_id, { schemeID: 'VA' })]));
  }
  return el(name, children);
}

function lineNode(line: InvoiceLine): XmlNode {
  return el('ram:IncludedSupplyChainTradeLineItem', [
    el('ram:AssociatedDocumentLineDocument', [el('ram:LineID', line.id)]),
    el('ram:SpecifiedTradeProduct', [el('ram:Name', line.name)]),
    el('ram:SpecifiedLineTradeAgreement', [
      el('ram:NetPriceProductTradePrice', [el('ram:ChargeAmount', amount(line.unit_price_cents))]),
    ]),
    el('ram:SpecifiedLineTradeDelivery', [
      el('ram:BilledQuantity', String(line.quantity), { unitCode: line.unit_code ?? 'C62' }),
    ]),
    el('ram:SpecifiedLineTradeSettlement', [
      el('ram:ApplicableTradeTax', [
        el('ram:TypeCode', 'VAT'),
        el('ram:CategoryCode', line.vat_category),
        el('ram:RateApplicablePercent', percent(line.vat_rate)),
      ]),
      el('ram:SpecifiedTradeSettlementLineMonetarySummation', [
        el('ram:LineTotalAmount', amount(line.net_cents)),
      ]),
    ]),
  ]);
}

function taxNode(row: VatBreakdownRow): XmlNode {
  const children: XmlNode[] = [
    el('ram:CalculatedAmount', amount(row.vat_cents)),
    el('ram:TypeCode', 'VAT'),
  ];
  // The exemption reason belongs immediately after TypeCode in the sequence,
  // and only categories that charge no VAT carry one.
  if (ZERO_VAT_CATEGORIES.includes(row.category) && row.exemption_reason) {
    children.push(el('ram:ExemptionReason', row.exemption_reason));
  }
  children.push(
    el('ram:BasisAmount', amount(row.base_cents)),
    el('ram:CategoryCode', row.category),
    el('ram:RateApplicablePercent', percent(row.rate)),
  );
  return el('ram:ApplicableTradeTax', children);
}

/**
 * Build the CII document.
 *
 * Assumes the input has already passed `validateInvoice`. It is not this
 * function's job to decide whether a document may be issued — mixing "is this
 * legal" into "write it out" is how a generator ends up silently emitting a
 * document nobody can use.
 */
export function buildCii(input: EInvoiceInput, profile: Profile): string {
  const currency = input.currency ?? 'EUR';
  const documentType = input.document_type ?? '380';

  const documentChildren: XmlNode[] = [
    el('ram:ID', input.number),
    el('ram:TypeCode', documentType),
    dateNode('ram:IssueDateTime', input.issue_date),
  ];
  if (input.note) {
    documentChildren.push(el('ram:IncludedNote', [el('ram:Content', input.note)]));
  }

  const agreementChildren: XmlNode[] = [];
  // BT-10, first in the sequence when present. The XRechnung profile requires
  // it, because a German public authority routes on it (the Leitweg-ID).
  if (input.buyer_reference) agreementChildren.push(el('ram:BuyerReference', input.buyer_reference));
  agreementChildren.push(
    partyNode('ram:SellerTradeParty', input.seller),
    partyNode('ram:BuyerTradeParty', input.buyer),
  );

  const settlementChildren: XmlNode[] = [el('ram:InvoiceCurrencyCode', currency)];
  if (input.payment?.iban) {
    settlementChildren.push(
      el('ram:SpecifiedTradeSettlementPaymentMeans', [
        // 58 = SEPA credit transfer (UNTDID 4461). The one payment means a
        // module that only knows an IBAN can honestly claim.
        el('ram:TypeCode', '58'),
        el('ram:PayeePartyCreditorFinancialAccount', [el('ram:IBANID', input.payment.iban)]),
        ...(input.payment.bic
          ? [
              el('ram:PayeeSpecifiedCreditorFinancialInstitution', [
                el('ram:BICID', input.payment.bic),
              ]),
            ]
          : []),
      ]),
    );
  }
  settlementChildren.push(...input.vat_breakdown.map(taxNode));

  const paymentTerms: XmlNode[] = [];
  if (input.due_date) paymentTerms.push(dateNode('ram:DueDateDateTime', input.due_date));
  if (input.payment?.reference) paymentTerms.push(el('ram:DirectDebitMandateID', input.payment.reference));
  if (paymentTerms.length > 0) {
    settlementChildren.push(el('ram:SpecifiedTradePaymentTerms', paymentTerms));
  }

  const paid = input.paid_cents ?? 0;
  settlementChildren.push(
    el('ram:SpecifiedTradeSettlementHeaderMonetarySummation', [
      el('ram:LineTotalAmount', amount(input.net_cents)),
      el('ram:TaxBasisTotalAmount', amount(input.net_cents)),
      el('ram:TaxTotalAmount', amount(input.vat_total_cents), { currencyID: currency }),
      el('ram:GrandTotalAmount', amount(input.gross_cents)),
      el('ram:TotalPrepaidAmount', amount(paid)),
      el('ram:DuePayableAmount', amount(input.gross_cents - paid)),
    ]),
  );

  return renderXml(
    el(
      'rsm:CrossIndustryInvoice',
      [
        el('rsm:ExchangedDocumentContext', [
          el('ram:GuidelineSpecifiedDocumentContextParameter', [el('ram:ID', GUIDELINE_ID[profile])]),
        ]),
        el('rsm:ExchangedDocument', documentChildren),
        el('rsm:SupplyChainTradeTransaction', [
          ...input.lines.map(lineNode),
          el('ram:ApplicableHeaderTradeAgreement', agreementChildren),
          // Empty by design: EN 16931 makes the delivery group optional, and
          // MOD-04 has no delivery date to put in it. The element itself stays,
          // because the CII sequence requires it between agreement and
          // settlement.
          el('ram:ApplicableHeaderTradeDelivery', []),
          el('ram:ApplicableHeaderTradeSettlement', settlementChildren),
        ]),
      ],
      {
        'xmlns:rsm': NS.rsm,
        'xmlns:ram': NS.ram,
        'xmlns:udt': NS.udt,
      },
    ),
  );
}
