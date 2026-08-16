import { at, childrenNamed, localName, parseXml, textAt, type ParsedElement } from './xml.js';
import type { InboundInvoice } from '../shared/types.js';

/**
 * Reading a structured invoice somebody sent us.
 *
 * Germany has required every business to be able to RECEIVE an EN 16931 invoice
 * since 2025-01-01 — an obligation that landed two years before the sending one
 * and that no module in this catalogue could satisfy. This is the smaller half
 * of e-invoicing and the half with the earlier deadline.
 *
 * Two decisions worth stating:
 *
 * **Namespace prefixes are ignored, local names are matched.** Senders bind the
 * CII namespaces to whatever prefixes they like — `ram:`, `a:`, none at all —
 * and a reader that keys on the prefix works against exactly the one system it
 * was tested with. The URIs are what identify the vocabulary; nothing else in a
 * real document has these local names in these positions.
 *
 * **Every field is optional on the way in.** A parse failure must not lose the
 * document: it may be the only copy, and a human can read XML. So this reports
 * what it could read, nulls what it could not, and the caller stores the raw
 * bytes either way. That is the opposite of the outbound direction, where
 * anything less than valid is refused outright — a document we ISSUE is our
 * claim about our own business, and a document we RECEIVE is evidence.
 */

/** "12345.67" or "12345,67" → 1234567 minor units. Null when unreadable. */
export function parseAmountCents(text: string | null): number | null {
  if (text === null) return null;
  const cleaned = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const negative = cleaned.startsWith('-');
  const [whole, fraction = ''] = cleaned.replace('-', '').split('.') as [string, string?];
  // String arithmetic, not `Number(x) * 100`: 19.99 × 100 is 1998.9999… in
  // binary floating point, and this is money arriving from a third party.
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return negative ? -cents : cents;
}

/** "20260720" (CII format 102) or "2026-07-20" → "2026-07-20". */
export function parseCiiDate(text: string | null): string | null {
  if (text === null) return null;
  const value = text.trim();
  if (/^\d{8}$/.test(value)) return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return null;
}

/** The first descendant anywhere below `node` with this local name. */
function deep(node: ParsedElement, local: string): ParsedElement | null {
  if (localName(node.name) === local) return node;
  for (const child of node.children) {
    const found = deep(child, local);
    if (found) return found;
  }
  return null;
}

function deepText(node: ParsedElement | null, local: string): string | null {
  if (!node) return null;
  const found = deep(node, local);
  return found ? found.text.trim() || null : null;
}

/**
 * Parse an EN 16931 CII invoice. Never throws for missing content — only for
 * XML that is not XML at all, which `parseXml` reports.
 */
export function parseCii(xml: string): InboundInvoice {
  const root = parseXml(xml);
  const document = at(root, 'ExchangedDocument');
  const transaction = at(root, 'SupplyChainTradeTransaction');
  const agreement = transaction ? at(transaction, 'ApplicableHeaderTradeAgreement') : null;
  const settlement = transaction ? at(transaction, 'ApplicableHeaderTradeSettlement') : null;
  const summation = settlement ? at(settlement, 'SpecifiedTradeSettlementHeaderMonetarySummation') : null;

  const seller = agreement ? at(agreement, 'SellerTradeParty') : null;
  const buyer = agreement ? at(agreement, 'BuyerTradeParty') : null;

  // The VAT id sits in SpecifiedTaxRegistration/ID with schemeID="VA"; a party
  // may carry several registrations, so pick the VAT one rather than the first.
  let sellerVat: string | null = null;
  if (seller) {
    for (const registration of childrenNamed(seller, 'SpecifiedTaxRegistration')) {
      const id = childrenNamed(registration, 'ID')[0];
      if (id && (id.attrs.schemeID ?? '').toUpperCase() === 'VA') {
        sellerVat = id.text.trim() || null;
        break;
      }
      if (id && sellerVat === null) sellerVat = id.text.trim() || null;
    }
  }

  return {
    number: document ? textAt(document, 'ID') : null,
    issue_date: parseCiiDate(document ? deepText(at(document, 'IssueDateTime'), 'DateTimeString') : null),
    currency: settlement ? textAt(settlement, 'InvoiceCurrencyCode') : null,
    seller_name: seller ? textAt(seller, 'Name') : null,
    seller_vat_id: sellerVat,
    buyer_name: buyer ? textAt(buyer, 'Name') : null,
    net_cents: parseAmountCents(summation ? textAt(summation, 'LineTotalAmount') : null),
    vat_total_cents: parseAmountCents(summation ? textAt(summation, 'TaxTotalAmount') : null),
    gross_cents: parseAmountCents(summation ? textAt(summation, 'GrandTotalAmount') : null),
    syntax: 'cii',
    guideline_id: deepText(at(root, 'ExchangedDocumentContext'), 'ID'),
  };
}
