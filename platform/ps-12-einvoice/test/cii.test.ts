import { describe, expect, it } from 'vitest';
import { amount, buildCii, ciiDate, percent } from '../server/cii.js';
import { parseXml, escapeXml, renderXml, el } from '../server/xml.js';
import { parseCii } from '../server/inbound.js';
import { validateInvoice } from '../server/validate.js';
import type { EInvoiceInput } from '../shared/types.js';

/**
 * The CII document generator.
 *
 * Two properties carry this file, and both are the kind that fail silently at
 * the recipient rather than loudly here:
 *
 * 1. **Element order.** CII is an `xsd:sequence`, so a transposed pair is a
 *    schema violation the recipient rejects — with an error the sender never
 *    sees. The tests therefore assert on whole documents, not on individual
 *    values, because only a whole-document assertion notices a reordering.
 * 2. **Money is exact.** Amounts are integers in minor units everywhere and
 *    become decimals exactly once. Any float arithmetic on the way would show
 *    up as a cent, and a cent of disagreement between the XML and the PDF the
 *    customer holds is a dispute.
 */

/** A minimal but valid invoice: one line, 20 % VAT, everything adding up. */
function invoice(overrides: Partial<EInvoiceInput> = {}): EInvoiceInput {
  return {
    number: 'INV-2026-0001',
    issue_date: '2026-07-20',
    due_date: '2026-08-03',
    currency: 'EUR',
    seller: {
      name: '0815software GmbH',
      vat_id: 'ATU12345678',
      email: 'rechnung@0815software.example',
      address: { street: 'Teststraße 1', postcode: '4020', city: 'Linz', country_code: 'AT' },
    },
    buyer: {
      name: 'Nordwind AG',
      vat_id: 'DE811234567',
      address: { street: 'Hafenstraße 4', postcode: '20359', city: 'Hamburg', country_code: 'DE' },
    },
    lines: [
      {
        id: '1',
        name: 'Consulting',
        quantity: 2,
        unit_price_cents: 12_34,
        vat_category: 'S',
        vat_rate: 20,
        net_cents: 24_68,
      },
    ],
    vat_breakdown: [{ category: 'S', rate: 20, base_cents: 24_68, vat_cents: 494 }],
    net_cents: 24_68,
    vat_total_cents: 494,
    gross_cents: 29_62,
    payment: { iban: 'AT611904300234573201', bic: 'BKAUATWW' },
    ...overrides,
  };
}

describe('amount rendering', () => {
  it.each([
    [0, '0.00'],
    [1, '0.01'],
    [99, '0.99'],
    [100, '1.00'],
    [2468, '24.68'],
    [123456789, '1234567.89'],
    [-5, '-0.05'],
    [-2468, '-24.68'],
  ])('renders %i minor units as %o', (cents, expected) => {
    expect(amount(cents)).toBe(expected);
  });

  // The reason `amount` does integer arithmetic rather than `cents / 100`:
  // 1999 / 100 is 19.990000000000002 in binary floating point, and every
  // amount on an invoice is a number somebody will reconcile to the cent.
  it('never leaks a floating-point artefact', () => {
    for (let cents = 0; cents < 5000; cents += 1) {
      expect(amount(cents)).toMatch(/^\d+\.\d{2}$/);
    }
    expect(amount(1999)).toBe('19.99');
    expect(amount(70)).toBe('0.70');
  });
});

describe('rate and date rendering', () => {
  it.each([
    [20, '20'],
    [0, '0'],
    [7.5, '7.5'],
    [19.6, '19.6'],
  ])('renders the rate %d as %o', (rate, expected) => {
    expect(percent(rate)).toBe(expected);
  });

  it('renders an ISO date in CII format 102', () => {
    expect(ciiDate('2026-07-20')).toBe('20260720');
  });
});

describe('the generated document', () => {
  it('is byte-for-byte what a recipient expects', () => {
    // A whole-document assertion on purpose. Element ORDER is the property
    // under test and no per-value assertion can see it.
    expect(buildCii(invoice(), 'en16931')).toMatchInlineSnapshot(`
      "<?xml version="1.0" encoding="UTF-8"?>
      <rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100" xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100" xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100">
        <rsm:ExchangedDocumentContext>
          <ram:GuidelineSpecifiedDocumentContextParameter>
            <ram:ID>urn:cen.eu:en16931:2017</ram:ID>
          </ram:GuidelineSpecifiedDocumentContextParameter>
        </rsm:ExchangedDocumentContext>
        <rsm:ExchangedDocument>
          <ram:ID>INV-2026-0001</ram:ID>
          <ram:TypeCode>380</ram:TypeCode>
          <ram:IssueDateTime>
            <udt:DateTimeString format="102">20260720</udt:DateTimeString>
          </ram:IssueDateTime>
        </rsm:ExchangedDocument>
        <rsm:SupplyChainTradeTransaction>
          <ram:IncludedSupplyChainTradeLineItem>
            <ram:AssociatedDocumentLineDocument>
              <ram:LineID>1</ram:LineID>
            </ram:AssociatedDocumentLineDocument>
            <ram:SpecifiedTradeProduct>
              <ram:Name>Consulting</ram:Name>
            </ram:SpecifiedTradeProduct>
            <ram:SpecifiedLineTradeAgreement>
              <ram:NetPriceProductTradePrice>
                <ram:ChargeAmount>12.34</ram:ChargeAmount>
              </ram:NetPriceProductTradePrice>
            </ram:SpecifiedLineTradeAgreement>
            <ram:SpecifiedLineTradeDelivery>
              <ram:BilledQuantity unitCode="C62">2</ram:BilledQuantity>
            </ram:SpecifiedLineTradeDelivery>
            <ram:SpecifiedLineTradeSettlement>
              <ram:ApplicableTradeTax>
                <ram:TypeCode>VAT</ram:TypeCode>
                <ram:CategoryCode>S</ram:CategoryCode>
                <ram:RateApplicablePercent>20</ram:RateApplicablePercent>
              </ram:ApplicableTradeTax>
              <ram:SpecifiedTradeSettlementLineMonetarySummation>
                <ram:LineTotalAmount>24.68</ram:LineTotalAmount>
              </ram:SpecifiedTradeSettlementLineMonetarySummation>
            </ram:SpecifiedLineTradeSettlement>
          </ram:IncludedSupplyChainTradeLineItem>
          <ram:ApplicableHeaderTradeAgreement>
            <ram:SellerTradeParty>
              <ram:Name>0815software GmbH</ram:Name>
              <ram:URIUniversalCommunication>
                <ram:URIID schemeID="EM">rechnung@0815software.example</ram:URIID>
              </ram:URIUniversalCommunication>
              <ram:PostalTradeAddress>
                <ram:PostcodeCode>4020</ram:PostcodeCode>
                <ram:LineOne>Teststraße 1</ram:LineOne>
                <ram:CityName>Linz</ram:CityName>
                <ram:CountryID>AT</ram:CountryID>
              </ram:PostalTradeAddress>
              <ram:SpecifiedTaxRegistration>
                <ram:ID schemeID="VA">ATU12345678</ram:ID>
              </ram:SpecifiedTaxRegistration>
            </ram:SellerTradeParty>
            <ram:BuyerTradeParty>
              <ram:Name>Nordwind AG</ram:Name>
              <ram:PostalTradeAddress>
                <ram:PostcodeCode>20359</ram:PostcodeCode>
                <ram:LineOne>Hafenstraße 4</ram:LineOne>
                <ram:CityName>Hamburg</ram:CityName>
                <ram:CountryID>DE</ram:CountryID>
              </ram:PostalTradeAddress>
              <ram:SpecifiedTaxRegistration>
                <ram:ID schemeID="VA">DE811234567</ram:ID>
              </ram:SpecifiedTaxRegistration>
            </ram:BuyerTradeParty>
          </ram:ApplicableHeaderTradeAgreement>
          <ram:ApplicableHeaderTradeDelivery/>
          <ram:ApplicableHeaderTradeSettlement>
            <ram:InvoiceCurrencyCode>EUR</ram:InvoiceCurrencyCode>
            <ram:SpecifiedTradeSettlementPaymentMeans>
              <ram:TypeCode>58</ram:TypeCode>
              <ram:PayeePartyCreditorFinancialAccount>
                <ram:IBANID>AT611904300234573201</ram:IBANID>
              </ram:PayeePartyCreditorFinancialAccount>
              <ram:PayeeSpecifiedCreditorFinancialInstitution>
                <ram:BICID>BKAUATWW</ram:BICID>
              </ram:PayeeSpecifiedCreditorFinancialInstitution>
            </ram:SpecifiedTradeSettlementPaymentMeans>
            <ram:ApplicableTradeTax>
              <ram:CalculatedAmount>4.94</ram:CalculatedAmount>
              <ram:TypeCode>VAT</ram:TypeCode>
              <ram:BasisAmount>24.68</ram:BasisAmount>
              <ram:CategoryCode>S</ram:CategoryCode>
              <ram:RateApplicablePercent>20</ram:RateApplicablePercent>
            </ram:ApplicableTradeTax>
            <ram:SpecifiedTradePaymentTerms>
              <ram:DueDateDateTime>
                <udt:DateTimeString format="102">20260803</udt:DateTimeString>
              </ram:DueDateDateTime>
            </ram:SpecifiedTradePaymentTerms>
            <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
              <ram:LineTotalAmount>24.68</ram:LineTotalAmount>
              <ram:TaxBasisTotalAmount>24.68</ram:TaxBasisTotalAmount>
              <ram:TaxTotalAmount currencyID="EUR">4.94</ram:TaxTotalAmount>
              <ram:GrandTotalAmount>29.62</ram:GrandTotalAmount>
              <ram:TotalPrepaidAmount>0.00</ram:TotalPrepaidAmount>
              <ram:DuePayableAmount>29.62</ram:DuePayableAmount>
            </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
          </ram:ApplicableHeaderTradeSettlement>
        </rsm:SupplyChainTradeTransaction>
      </rsm:CrossIndustryInvoice>
      "
    `);
  });

  it('is deterministic — the same input always yields the same bytes', () => {
    expect(buildCii(invoice(), 'en16931')).toBe(buildCii(invoice(), 'en16931'));
  });

  it('carries the XRechnung guideline id and buyer reference for that profile', () => {
    const xml = buildCii(invoice({ buyer_reference: '991-33333TEST-33' }), 'xrechnung');
    expect(xml).toContain('urn:xoev-de:kosit:standard:xrechnung_3.0');
    expect(xml).toContain('<ram:BuyerReference>991-33333TEST-33</ram:BuyerReference>');
  });

  it('omits an unknown field rather than writing it empty', () => {
    // An empty <ram:CityName/> claims "the city is the empty string", which is
    // a different and worse assertion than not knowing it.
    const xml = buildCii(
      invoice({ buyer: { name: 'Nordwind AG', address: { country_code: 'DE' } } }),
      'en16931',
    );
    // Scoped to the BUYER block — the seller still has a full address, so a
    // whole-document check would pass for the wrong reason.
    const buyerBlock = xml.slice(xml.indexOf('<ram:BuyerTradeParty>'), xml.indexOf('</ram:BuyerTradeParty>'));
    expect(buyerBlock).not.toContain('<ram:CityName');
    expect(buyerBlock).not.toContain('<ram:PostcodeCode');
    expect(buyerBlock).not.toContain('<ram:LineOne');
    expect(buyerBlock).toContain('<ram:CountryID>DE</ram:CountryID>');
  });

  it('escapes text that would otherwise break the document', () => {
    const xml = buildCii(invoice({ seller: { ...invoice().seller, name: 'Müller & Co <GmbH>' } }), 'en16931');
    expect(xml).toContain('<ram:Name>Müller &amp; Co &lt;GmbH&gt;</ram:Name>');
    // And the result is still parseable — the real assertion.
    expect(() => parseXml(xml)).not.toThrow();
  });

  it('subtracts a prepayment from the amount due', () => {
    const xml = buildCii(invoice({ paid_cents: 1000 }), 'en16931');
    expect(xml).toContain('<ram:TotalPrepaidAmount>10.00</ram:TotalPrepaidAmount>');
    expect(xml).toContain('<ram:DuePayableAmount>19.62</ram:DuePayableAmount>');
  });

  it('renders an exemption reason for a category that requires one', () => {
    const reverse = invoice({
      lines: [
        { id: '1', name: 'Consulting', quantity: 1, unit_price_cents: 10_000, vat_category: 'AE', vat_rate: 0, net_cents: 10_000 },
      ],
      vat_breakdown: [
        { category: 'AE', rate: 0, base_cents: 10_000, vat_cents: 0, exemption_reason: 'Reverse charge' },
      ],
      net_cents: 10_000,
      vat_total_cents: 0,
      gross_cents: 10_000,
    });
    expect(validateInvoice(reverse, 'en16931').valid).toBe(true);
    const xml = buildCii(reverse, 'en16931');
    expect(xml).toContain('<ram:ExemptionReason>Reverse charge</ram:ExemptionReason>');
    // Order matters here too: the reason sits between TypeCode and BasisAmount.
    expect(xml.indexOf('ExemptionReason')).toBeGreaterThan(xml.indexOf('<ram:TypeCode>VAT</ram:TypeCode>'));
    expect(xml.indexOf('ExemptionReason')).toBeLessThan(xml.indexOf('<ram:BasisAmount>'));
  });
});

describe('a document we generate is a document we can read back', () => {
  it('round-trips through the inbound parser', () => {
    const input = invoice();
    const parsed = parseCii(buildCii(input, 'en16931'));
    expect(parsed).toMatchObject({
      number: 'INV-2026-0001',
      issue_date: '2026-07-20',
      currency: 'EUR',
      seller_name: '0815software GmbH',
      seller_vat_id: 'ATU12345678',
      buyer_name: 'Nordwind AG',
      net_cents: 2468,
      vat_total_cents: 494,
      gross_cents: 2962,
      guideline_id: 'urn:cen.eu:en16931:2017',
    });
  });

  it('round-trips money exactly, across a range of awkward amounts', () => {
    for (const cents of [1, 7, 70, 99, 100, 1999, 123_456_789]) {
      const input = invoice({
        lines: [{ id: '1', name: 'X', quantity: 1, unit_price_cents: cents, vat_category: 'Z', vat_rate: 0, net_cents: cents }],
        vat_breakdown: [{ category: 'Z', rate: 0, base_cents: cents, vat_cents: 0 }],
        net_cents: cents,
        vat_total_cents: 0,
        gross_cents: cents,
      });
      expect(parseCii(buildCii(input, 'en16931')).gross_cents, String(cents)).toBe(cents);
    }
  });
});

describe('the XML writer itself', () => {
  it('escapes all five predefined entities', () => {
    expect(escapeXml(`a&b<c>d"e'f`)).toBe('a&amp;b&lt;c&gt;d&quot;e&apos;f');
  });

  it('drops control characters XML forbids, since no escape makes them legal', () => {
    expect(escapeXml('a bc')).toBe('abc');
    // Tab, CR and LF are legal and survive.
    expect(escapeXml('a\tb\nc')).toBe('a\tb\nc');
  });

  it('renders an empty element rather than an open/close pair', () => {
    expect(renderXml(el('x', []))).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<x/>\n');
  });
});
