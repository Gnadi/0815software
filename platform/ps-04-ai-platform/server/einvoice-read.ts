import type { EInvoiceSyntax, ExtractedFields, ExtractedLine } from '../shared/types.js';
import { emptyFields } from './invoice-text.js';
import { all, path, textAt, type XmlElement } from './xml.js';

/**
 * Reading a structured e-invoice: nothing is guessed, every field is the
 * element EN 16931 assigns it (the BT numbers below), in the three syntaxes
 * suppliers in DACH send — CII (XRechnung CII, ZUGFeRD / Factur-X), UBL 2.1
 * (XRechnung UBL, PEPPOL BIS) and ebInterface (the Austrian federal format).
 *
 * Pinned against the published EN 16931 example pair (the same invoice in
 * UBL and CII, test/fixtures/en16931) and against MOD-04's own output, which
 * its suite validates against the official schemas.
 */

/** "1482.66" → 148266, from the decimal string — never through a float. */
export function decimalCents(raw: string | null): number | null {
  if (raw === null) return null;
  const m = /^\s*(-?)(\d+)(?:\.(\d+))?\s*$/.exec(raw);
  if (!m) return null;
  const frac = (m[3] ?? '').padEnd(3, '0');
  let cents = Number(m[2]) * 100 + Number(frac.slice(0, 2));
  // Prices may carry more decimals than money does: half up, as EN 16931 rounds.
  if (Number(frac[2]) >= 5) cents += 1;
  return m[1] === '-' ? -cents : cents;
}

const num = (raw: string | null): number | null => (raw !== null && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : null);

/** CII dates are `format="102"`: YYYYMMDD. */
function ciiDate(el: XmlElement | undefined): string | null {
  const raw = textAt(el, 'DateTimeString');
  const m = raw ? /^(\d{4})(\d{2})(\d{2})$/.exec(raw) : null;
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

const isoDay = (raw: string | null): string | null => (raw && /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null);
const compact = (s: string | null) => (s ? s.replace(/\s+/g, '').toUpperCase() : null);

/** Which e-invoice a parsed document is, if it is one. */
export function syntaxOf(root: XmlElement): EInvoiceSyntax | null {
  if (root.name === 'CrossIndustryInvoice') return 'cii';
  if ((root.name === 'Invoice' || root.name === 'CreditNote') && root.ns?.startsWith('urn:oasis:names:specification:ubl:schema:xsd:')) return 'ubl';
  if (root.name === 'Invoice' && root.ns?.startsWith('http://www.ebinterface.at/schema/')) return 'ebinterface';
  return null;
}

export interface EInvoiceRead {
  fields: ExtractedFields;
  lines: ExtractedLine[];
}

/** Credit notes by UNTDID 1001: 381 credit note, 396 factored credit note, 261/262 self-billed. */
const CREDIT_CODES = new Set(['381', '396', '261', '262', '532']);

function readCii(root: XmlElement): EInvoiceRead {
  const f = emptyFields();
  const doc = path(root, 'ExchangedDocument');
  const tx = path(root, 'SupplyChainTradeTransaction');
  const agreement = path(tx, 'ApplicableHeaderTradeAgreement');
  const settlement = path(tx, 'ApplicableHeaderTradeSettlement');
  const seller = path(agreement, 'SellerTradeParty');
  const sums = path(settlement, 'SpecifiedTradeSettlementHeaderMonetarySummation');
  const means = all(settlement, 'SpecifiedTradeSettlementPaymentMeans').find((m) => path(m, 'PayeePartyCreditorFinancialAccount'));

  f.document_type = CREDIT_CODES.has(textAt(doc, 'TypeCode') ?? '') ? 'credit_note' : 'invoice';
  f.invoice_number = textAt(doc, 'ID'); // BT-1
  f.issue_date = ciiDate(path(doc, 'IssueDateTime')); // BT-2
  f.supplier_name = textAt(seller, 'Name'); // BT-27
  f.supplier_vat_id = compact(all(seller, 'SpecifiedTaxRegistration').map((r) => path(r, 'ID')).find((id) => id?.attrs.schemeID === 'VA')?.text.trim() ?? null); // BT-31
  f.po_number = textAt(agreement, 'BuyerOrderReferencedDocument', 'IssuerAssignedID'); // BT-13
  f.currency = textAt(settlement, 'InvoiceCurrencyCode'); // BT-5
  f.payment_reference = textAt(settlement, 'PaymentReference'); // BT-83
  f.iban = compact(textAt(means, 'PayeePartyCreditorFinancialAccount', 'IBANID')); // BT-84
  f.bic = textAt(means, 'PayeeSpecifiedCreditorFinancialInstitution', 'BICID'); // BT-86
  f.due_date = ciiDate(path(settlement, 'SpecifiedTradePaymentTerms', 'DueDateDateTime')); // BT-9
  f.net_cents = decimalCents(textAt(sums, 'TaxBasisTotalAmount')); // BT-109
  // BT-110 is the tax total in the invoice currency; BT-111 (another
  // currency, for accounting) shares the element name.
  const taxTotals = all(sums, 'TaxTotalAmount');
  const tax = taxTotals.find((t) => !t.attrs.currencyID || t.attrs.currencyID === f.currency) ?? taxTotals[0];
  f.tax_cents = decimalCents(tax?.text.trim() ?? null);
  f.gross_cents = decimalCents(textAt(sums, 'GrandTotalAmount')); // BT-112
  f.payable_cents = decimalCents(textAt(sums, 'DuePayableAmount')); // BT-115

  const lines = all(tx, 'IncludedSupplyChainTradeLineItem').map(
    (li): ExtractedLine => ({
      description: textAt(li, 'SpecifiedTradeProduct', 'Name') ?? '',
      quantity: num(textAt(li, 'SpecifiedLineTradeDelivery', 'BilledQuantity')),
      unit_code: path(li, 'SpecifiedLineTradeDelivery', 'BilledQuantity')?.attrs.unitCode ?? null,
      unit_price_cents: decimalCents(textAt(li, 'SpecifiedLineTradeAgreement', 'NetPriceProductTradePrice', 'ChargeAmount')),
      net_cents: decimalCents(textAt(li, 'SpecifiedLineTradeSettlement', 'SpecifiedTradeSettlementLineMonetarySummation', 'LineTotalAmount')),
      vat_rate: num(textAt(li, 'SpecifiedLineTradeSettlement', 'ApplicableTradeTax', 'RateApplicablePercent')),
    }),
  );
  return { fields: f, lines };
}

function readUbl(root: XmlElement): EInvoiceRead {
  const f = emptyFields();
  const credit = root.name === 'CreditNote';
  const party = path(root, 'AccountingSupplierParty', 'Party');
  const totals = path(root, 'LegalMonetaryTotal');
  const means = all(root, 'PaymentMeans').find((m) => path(m, 'PayeeFinancialAccount'));

  f.document_type = credit || CREDIT_CODES.has(textAt(root, 'InvoiceTypeCode') ?? '') ? 'credit_note' : 'invoice';
  f.invoice_number = textAt(root, 'ID');
  f.issue_date = isoDay(textAt(root, 'IssueDate'));
  f.due_date = isoDay(textAt(root, 'DueDate') ?? textAt(means, 'PaymentDueDate'));
  f.supplier_name = textAt(party, 'PartyName', 'Name') ?? textAt(party, 'PartyLegalEntity', 'RegistrationName');
  f.supplier_vat_id = compact(all(party, 'PartyTaxScheme').find((t) => textAt(t, 'TaxScheme', 'ID') === 'VAT')?.children.find((c) => c.name === 'CompanyID')?.text.trim() ?? null);
  f.po_number = textAt(root, 'OrderReference', 'ID');
  f.currency = textAt(root, 'DocumentCurrencyCode');
  f.payment_reference = textAt(means, 'PaymentID');
  f.iban = compact(textAt(means, 'PayeeFinancialAccount', 'ID'));
  f.bic = textAt(means, 'PayeeFinancialAccount', 'FinancialInstitutionBranch', 'ID');
  f.net_cents = decimalCents(textAt(totals, 'TaxExclusiveAmount'));
  f.gross_cents = decimalCents(textAt(totals, 'TaxInclusiveAmount'));
  f.payable_cents = decimalCents(textAt(totals, 'PayableAmount'));
  const taxTotals = all(root, 'TaxTotal').map((t) => path(t, 'TaxAmount')).filter((t): t is XmlElement => t !== undefined);
  const tax = taxTotals.find((t) => t.attrs.currencyID === f.currency) ?? taxTotals[0];
  f.tax_cents = decimalCents(tax?.text.trim() ?? null);

  const lines = all(root, credit ? 'CreditNoteLine' : 'InvoiceLine').map((li): ExtractedLine => {
    const qty = path(li, credit ? 'CreditedQuantity' : 'InvoicedQuantity');
    return {
      description: textAt(li, 'Item', 'Name') ?? '',
      quantity: num(qty?.text.trim() ?? null),
      unit_code: qty?.attrs.unitCode ?? null,
      unit_price_cents: decimalCents(textAt(li, 'Price', 'PriceAmount')),
      net_cents: decimalCents(textAt(li, 'LineExtensionAmount')),
      vat_rate: num(textAt(li, 'Item', 'ClassifiedTaxCategory', 'Percent')),
    };
  });
  return { fields: f, lines };
}

function readEbInterface(root: XmlElement): EInvoiceRead {
  const f = emptyFields();
  const biller = path(root, 'Biller');
  const transfer = path(root, 'PaymentMethod', 'UniversalBankTransaction');
  const account = path(transfer, 'BeneficiaryAccount');

  f.document_type = root.attrs.DocumentType === 'CreditMemo' ? 'credit_note' : 'invoice';
  f.invoice_number = textAt(root, 'InvoiceNumber');
  f.issue_date = isoDay(textAt(root, 'InvoiceDate'));
  f.supplier_name = textAt(biller, 'Address', 'Name');
  f.supplier_vat_id = compact(textAt(biller, 'VATIdentificationNumber'));
  f.po_number = textAt(root, 'InvoiceRecipient', 'OrderReference', 'OrderID');
  f.currency = root.attrs.InvoiceCurrency ?? null;
  f.payment_reference = textAt(transfer, 'PaymentReference');
  f.iban = compact(textAt(account, 'IBAN'));
  f.bic = textAt(account, 'BIC');
  f.due_date = isoDay(textAt(root, 'PaymentConditions', 'DueDate'));
  f.gross_cents = decimalCents(textAt(root, 'TotalGrossAmount'));
  f.payable_cents = decimalCents(textAt(root, 'PayableAmount'));
  // 6.x: Tax/TaxItem; 4.x–5.x: Tax/VAT/VATItem. Net and tax are their sums.
  const items = [...all(path(root, 'Tax'), 'TaxItem'), ...all(path(root, 'Tax', 'VAT'), 'VATItem')];
  if (items.length > 0) {
    const sum = (name: string) => items.reduce<number | null>((acc, it) => {
      const v = decimalCents(textAt(it, name));
      return acc === null || v === null ? null : acc + v;
    }, 0);
    f.net_cents = sum('TaxableAmount');
    f.tax_cents = items.some((it) => path(it, 'TaxAmount')) ? sum('TaxAmount') : sum('Amount');
  }

  const lines = all(path(root, 'Details', 'ItemList'), 'ListLineItem').map(
    (li): ExtractedLine => ({
      description: textAt(li, 'Description') ?? '',
      quantity: num(textAt(li, 'Quantity')),
      unit_code: path(li, 'Quantity')?.attrs.Unit ?? null,
      unit_price_cents: decimalCents(textAt(li, 'UnitPrice')),
      net_cents: decimalCents(textAt(li, 'LineItemAmount')),
      vat_rate: num(textAt(li, 'TaxItem', 'TaxPercent') ?? textAt(li, 'VATRate')),
    }),
  );
  return { fields: f, lines };
}

export function readEInvoice(root: XmlElement, syntax: EInvoiceSyntax): EInvoiceRead {
  if (syntax === 'cii') return readCii(root);
  if (syntax === 'ubl') return readUbl(root);
  return readEbInterface(root);
}
