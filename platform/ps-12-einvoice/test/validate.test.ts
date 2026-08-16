import { describe, expect, it } from 'vitest';
import { validateInvoice, vatFor } from '../server/validate.js';
import type { EInvoiceInput, Profile, VatCategory } from '../shared/types.js';

/**
 * The EN 16931 business rules.
 *
 * This is the file that justifies the service. An e-invoice that is merely
 * well-formed XML is worthless — the recipient's system checks these rules and
 * rejects the document if they do not hold, days later, with a message the
 * sender never sees. Every case below is a document that would have been
 * ACCEPTED by a naive exporter and REJECTED by the recipient.
 */

function invoice(overrides: Partial<EInvoiceInput> = {}): EInvoiceInput {
  return {
    number: 'INV-2026-0001',
    issue_date: '2026-07-20',
    due_date: '2026-08-03',
    currency: 'EUR',
    buyer_reference: '991-33333TEST-33',
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
      { id: '1', name: 'Consulting', quantity: 2, unit_price_cents: 1234, vat_category: 'S', vat_rate: 20, net_cents: 2468 },
    ],
    vat_breakdown: [{ category: 'S', rate: 20, base_cents: 2468, vat_cents: 494 }],
    net_cents: 2468,
    vat_total_cents: 494,
    gross_cents: 2962,
    payment: { iban: 'AT611904300234573201', bic: 'BKAUATWW' },
    ...overrides,
  };
}

/** The rule ids a document breaks, for compact assertions. */
function rules(input: EInvoiceInput, profile: Profile = 'en16931'): string[] {
  return validateInvoice(input, profile).violations.map((v) => v.rule);
}

describe('a complete invoice passes', () => {
  it('validates against EN 16931', () => {
    const result = validateInvoice(invoice(), 'en16931');
    expect(result.violations).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it('validates against the stricter XRechnung CIUS too', () => {
    expect(validateInvoice(invoice(), 'xrechnung').violations).toEqual([]);
  });
});

describe('mandatory document content', () => {
  it.each([
    ['BR-02', { number: '' }],
    ['BR-03', { issue_date: '' }],
    ['BR-06', { seller: { ...invoice().seller, name: '' } }],
    ['BR-07', { buyer: { ...invoice().buyer, name: '' } }],
    ['BR-16', { lines: [] }],
  ])('%s fires when the field is missing', (rule, patch) => {
    expect(rules(invoice(patch as Partial<EInvoiceInput>))).toContain(rule);
  });

  it('BR-09 fires when the seller has no country code', () => {
    const patched = invoice({ seller: { name: 'S', address: { city: 'Linz' } } });
    expect(rules(patched)).toContain('BR-09');
  });

  it('BR-11 fires when the buyer has no country code', () => {
    const patched = invoice({ buyer: { name: 'B', address: { city: 'Hamburg' } } });
    expect(rules(patched)).toContain('BR-11');
  });
});

describe('code lists', () => {
  // A shape check (`^[A-Z]{2}$`) accepts "DA" for Denmark. The recipient's
  // validator does not, and by then the invoice is weeks old.
  it('BR-CL-14 rejects a country code that is not a country', () => {
    const patched = invoice({ seller: { name: 'S', address: { country_code: 'XX' } } });
    expect(rules(patched)).toContain('BR-CL-14');
  });

  it('BR-CL-15 rejects the same on the buyer side', () => {
    const patched = invoice({ buyer: { name: 'B', address: { country_code: 'DA' } } });
    expect(rules(patched)).toContain('BR-CL-15');
  });

  it('BR-CL-04 rejects a currency that is not ISO 4217', () => {
    expect(rules(invoice({ currency: 'EURO' }))).toContain('BR-CL-04');
    expect(rules(invoice({ currency: 'CHF' }))).not.toContain('BR-CL-04');
  });

  it('BR-CL-01 rejects a document type that is neither invoice nor credit note', () => {
    expect(rules(invoice({ document_type: '325' as never }))).toContain('BR-CL-01');
  });

  it.each(['2026-13-01', '2026-02-30', '20260720', '2026-7-20', 'yesterday'])(
    'BR-CL-03 rejects the issue date %o',
    (date) => {
      expect(rules(invoice({ issue_date: date }))).toContain('BR-CL-03');
    },
  );

  it('BR-CL-03 accepts a leap day that exists and rejects one that does not', () => {
    expect(rules(invoice({ issue_date: '2028-02-29' }))).not.toContain('BR-CL-03');
    expect(rules(invoice({ issue_date: '2026-02-29' }))).toContain('BR-CL-03');
  });
});

describe('line-level rules', () => {
  it('BR-25 fires on a line with no item name', () => {
    const patched = invoice({
      lines: [{ id: '1', name: '', quantity: 1, unit_price_cents: 100, vat_category: 'S', vat_rate: 20, net_cents: 100 }],
      vat_breakdown: [{ category: 'S', rate: 20, base_cents: 100, vat_cents: 20 }],
      net_cents: 100,
      vat_total_cents: 20,
      gross_cents: 120,
    });
    expect(rules(patched)).toContain('BR-25');
  });

  it('BR-27 fires on a negative unit price', () => {
    const patched = invoice({
      lines: [{ id: '1', name: 'X', quantity: 1, unit_price_cents: -100, vat_category: 'S', vat_rate: 20, net_cents: -100 }],
    });
    expect(rules(patched)).toContain('BR-27');
  });

  it('BR-21 fires when two lines share an identifier', () => {
    const line = { name: 'X', quantity: 1, unit_price_cents: 100, vat_category: 'S' as const, vat_rate: 20, net_cents: 100 };
    const patched = invoice({
      lines: [{ id: '1', ...line }, { id: '1', ...line }],
      vat_breakdown: [{ category: 'S', rate: 20, base_cents: 200, vat_cents: 40 }],
      net_cents: 200,
      vat_total_cents: 40,
      gross_cents: 240,
    });
    expect(rules(patched)).toContain('BR-21');
  });
});

describe('the arithmetic rules', () => {
  // These are the reason a module hands PS-12 its own totals rather than
  // letting the service recompute them: the service checks that the numbers
  // the customer was shown are the numbers in the XML, and refuses if not.
  it('BR-CO-10 fires when the lines do not add up to the net total', () => {
    expect(rules(invoice({ net_cents: 2469, gross_cents: 2963 }))).toContain('BR-CO-10');
  });

  it('BR-CO-14 fires when the VAT breakdown does not add up to the VAT total', () => {
    expect(rules(invoice({ vat_total_cents: 495, gross_cents: 2963 }))).toContain('BR-CO-14');
  });

  it('BR-CO-15 fires when gross is not net plus VAT', () => {
    expect(rules(invoice({ gross_cents: 2963 }))).toContain('BR-CO-15');
  });

  it('is exact — one cent out is out', () => {
    expect(validateInvoice(invoice({ gross_cents: 2961 }), 'en16931').valid).toBe(false);
    expect(validateInvoice(invoice({ gross_cents: 2963 }), 'en16931').valid).toBe(false);
    expect(validateInvoice(invoice({ gross_cents: 2962 }), 'en16931').valid).toBe(true);
  });

  it('names the actual numbers, so the message is actionable', () => {
    const violation = validateInvoice(invoice({ gross_cents: 9999 }), 'en16931').violations.find(
      (v) => v.rule === 'BR-CO-15',
    );
    expect(violation?.message).toContain('2468');
    expect(violation?.message).toContain('494');
    expect(violation?.message).toContain('9999');
    expect(violation?.term).toBe('BT-112');
  });
});

describe('VAT category rules', () => {
  /** One line and one matching breakdown row at the given category. */
  function categorised(category: VatCategory, rate: number, reason?: string): EInvoiceInput {
    const vat = vatFor(10_000, rate);
    return invoice({
      lines: [{ id: '1', name: 'X', quantity: 1, unit_price_cents: 10_000, vat_category: category, vat_rate: rate, net_cents: 10_000 }],
      vat_breakdown: [{ category, rate, base_cents: 10_000, vat_cents: vat, exemption_reason: reason ?? null }],
      net_cents: 10_000,
      vat_total_cents: vat,
      gross_cents: 10_000 + vat,
    });
  }

  it('a standard-rated invoice at 20 % is fine', () => {
    expect(validateInvoice(categorised('S', 20), 'en16931').valid).toBe(true);
  });

  it('BR-S-05 fires on a standard-rated line at 0 %', () => {
    expect(rules(categorised('S', 0))).toContain('BR-S-05');
  });

  it('BR-S-10 fires when a standard-rated row carries an exemption reason', () => {
    expect(rules(categorised('S', 20, 'Not applicable'))).toContain('BR-S-10');
  });

  it('zero-rated needs no reason and must not carry one', () => {
    expect(validateInvoice(categorised('Z', 0), 'en16931').valid).toBe(true);
    expect(rules(categorised('Z', 0, 'Because'))).toContain('BR-Z-10');
  });

  // The heart of it. A 0 % line is not one thing: exempt, reverse charge,
  // intra-community, export and out-of-scope all show 0 % and all mean
  // different things to a tax authority — and every one of them legally
  // requires a stated reason. Emitting them as an undifferentiated "0 %" is
  // the most common way an e-invoice is valid XML and substantively wrong.
  it.each(['E', 'AE', 'K', 'G', 'O'] as const)(
    'BR-%s-10 requires an exemption reason for category %s',
    (category) => {
      expect(rules(categorised(category, 0))).toContain(`BR-${category}-10`);
      expect(validateInvoice(categorised(category, 0, 'Reverse charge'), 'en16931').valid).toBe(true);
    },
  );

  it.each(['Z', 'E', 'AE', 'K', 'G', 'O'] as const)('BR-%s-05 forces a zero rate for category %s', (category) => {
    expect(rules(categorised(category, 20, 'Reason'))).toContain(`BR-${category}-05`);
  });

  it('BR-S-08 fires when the taxable base does not match the lines that fed it', () => {
    const patched = invoice({ vat_breakdown: [{ category: 'S', rate: 20, base_cents: 2000, vat_cents: 400 }] });
    expect(rules(patched)).toContain('BR-S-08');
  });

  it('BR-S-09 fires when the VAT amount is not the base times the rate', () => {
    const patched = invoice({
      vat_breakdown: [{ category: 'S', rate: 20, base_cents: 2468, vat_cents: 493 }],
      vat_total_cents: 493,
      gross_cents: 2961,
    });
    expect(rules(patched)).toContain('BR-S-09');
  });

  it('BR-S-01 fires when a line uses a category with no breakdown row', () => {
    const patched = invoice({
      lines: [
        ...invoice().lines,
        { id: '2', name: 'Exempt thing', quantity: 1, unit_price_cents: 1000, vat_category: 'E', vat_rate: 0, net_cents: 1000 },
      ],
      net_cents: 3468,
      gross_cents: 3962,
    });
    expect(rules(patched)).toContain('BR-E-01');
  });

  it('BR-CO-18 fires when one category and rate appears in two rows', () => {
    const patched = invoice({
      vat_breakdown: [
        { category: 'S', rate: 20, base_cents: 2468, vat_cents: 494 },
        { category: 'S', rate: 20, base_cents: 2468, vat_cents: 494 },
      ],
      vat_total_cents: 988,
      gross_cents: 3456,
    });
    expect(rules(patched)).toContain('BR-CO-18');
  });

  it('rounds VAT the way MOD-04 rounds it, so the two cannot disagree', () => {
    // round(base × rate ÷ 100), half away from zero on non-negative input.
    expect(vatFor(2468, 20)).toBe(494);
    expect(vatFor(1, 20)).toBe(0);
    expect(vatFor(3, 20)).toBe(1);
    expect(vatFor(1000, 10)).toBe(100);
    expect(vatFor(2050, 10)).toBe(205);
  });
});

describe('a mixed-rate invoice, the realistic case', () => {
  it('validates when every category has its own row and reason', () => {
    const mixed = invoice({
      lines: [
        { id: '1', name: 'Consulting', quantity: 1, unit_price_cents: 100_000, vat_category: 'S', vat_rate: 20, net_cents: 100_000 },
        { id: '2', name: 'Books', quantity: 3, unit_price_cents: 2_000, vat_category: 'S', vat_rate: 10, net_cents: 6_000 },
        { id: '3', name: 'EU delivery', quantity: 1, unit_price_cents: 50_000, vat_category: 'K', vat_rate: 0, net_cents: 50_000 },
      ],
      vat_breakdown: [
        { category: 'S', rate: 20, base_cents: 100_000, vat_cents: 20_000 },
        { category: 'S', rate: 10, base_cents: 6_000, vat_cents: 600 },
        { category: 'K', rate: 0, base_cents: 50_000, vat_cents: 0, exemption_reason: 'Intra-community supply' },
      ],
      net_cents: 156_000,
      vat_total_cents: 20_600,
      gross_cents: 176_600,
    });
    expect(validateInvoice(mixed, 'en16931').violations).toEqual([]);
  });
});

describe('the XRechnung CIUS adds German requirements', () => {
  it('BR-DE-15 requires the buyer reference a recipient routes on', () => {
    const patched = invoice({ buyer_reference: null });
    expect(rules(patched, 'xrechnung')).toContain('BR-DE-15');
    // Plain EN 16931 does not require it — the profile is the difference.
    expect(rules(patched, 'en16931')).not.toContain('BR-DE-15');
  });

  it('BR-DE-1 requires payment instructions', () => {
    const patched = invoice({ payment: null });
    expect(rules(patched, 'xrechnung')).toContain('BR-DE-1');
    expect(rules(patched, 'en16931')).not.toContain('BR-DE-1');
  });

  it.each([
    ['BR-DE-3', { seller: { ...invoice().seller, address: { country_code: 'AT', postcode: '4020' } } }],
    ['BR-DE-4', { seller: { ...invoice().seller, address: { country_code: 'AT', city: 'Linz' } } }],
    ['BR-DE-8', { buyer: { ...invoice().buyer, address: { country_code: 'DE', postcode: '20359' } } }],
    ['BR-DE-9', { buyer: { ...invoice().buyer, address: { country_code: 'DE', city: 'Hamburg' } } }],
  ])('%s tightens an EN 16931 optional field into a required one', (rule, patch) => {
    const patched = invoice(patch as Partial<EInvoiceInput>);
    expect(rules(patched, 'xrechnung')).toContain(rule);
    expect(rules(patched, 'en16931')).not.toContain(rule);
  });

  it('BR-DE-16 requires the seller VAT identifier', () => {
    expect(rules(invoice({ seller: { ...invoice().seller, vat_id: null } }), 'xrechnung')).toContain('BR-DE-16');
  });
});

describe('violations are reported all at once', () => {
  // A validator that stops at the first problem turns fixing an invoice into
  // as many round trips as it has mistakes.
  it('reports every broken rule in one pass', () => {
    const broken = validateInvoice(
      {
        number: '',
        issue_date: '',
        seller: { name: '', address: {} },
        buyer: { name: '', address: {} },
        lines: [],
        vat_breakdown: [],
        net_cents: 1,
        vat_total_cents: 2,
        gross_cents: 99,
      } as EInvoiceInput,
      'en16931',
    );
    expect(broken.valid).toBe(false);
    expect(broken.violations.length).toBeGreaterThan(6);
    for (const rule of ['BR-02', 'BR-03', 'BR-06', 'BR-07', 'BR-09', 'BR-11', 'BR-16']) {
      expect(broken.violations.map((v) => v.rule)).toContain(rule);
    }
  });

  it('never throws, whatever it is handed', () => {
    for (const junk of [
      {},
      { lines: 'no' },
      { vat_breakdown: 42 },
      { seller: null },
      { lines: [null] },
      { vat_breakdown: [null] },
      { lines: [{}], vat_breakdown: [{}] },
      { buyer: 7, seller: 'x' },
    ]) {
      expect(() => validateInvoice(junk as unknown as EInvoiceInput, 'xrechnung')).not.toThrow();
    }
  });
});
