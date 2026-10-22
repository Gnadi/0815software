import type { EInvoiceModel } from '../shared/einvoice.js';
import { CASES } from './einvoice-cases.js';

/**
 * The ebInterface cases the golden files in test/fixtures/ebinterface/ are
 * made from. Every one is validated against the official ebInterface 6.1
 * schema in test/ebinterface.test.ts; regenerate with
 * `npm run ebinterface:fixtures` after a renderer change, and commit only what
 * that test then accepts. (The EN 16931 cases in einvoice-cases.ts are
 * rendered as ebInterface too, but have no ebInterface golden file.)
 */

/** An Austrian seller and buyer — what this format is mostly for. */
export const AT_BASE: EInvoiceModel = {
  ...CASES.standard!,
  number: 'RE-2026-0042',
  buyer_reference: '4500012345',
  note: null,
  seller: {
    ...CASES.standard!.seller,
    name: 'Muster & Söhne GmbH',
    street: 'Lassallestraße 5',
    postcode: '1020',
    city: 'Wien',
    country: 'AT',
    vat_id: 'ATU12345678',
    registration: 'FN 123456a',
    iban: 'AT61 1904 3002 3457 3201',
    bic: 'BKAUATWW',
    phone: '+43 1 234567',
    email: 'rechnung@muster.at',
  },
  buyer: {
    ...CASES.standard!.buyer,
    name: 'Kunde GmbH',
    street: 'Hauptplatz 1',
    postcode: '8010',
    city: 'Graz',
    country: 'AT',
    vat_id: 'ATU87654321',
    email: 'ap@kunde.at',
  },
  lines: [
    { position: 1, description: 'Beratung', quantity: 3, unit_price_cents: 33, vat_rate: 20 },
    { position: 2, description: 'Fachbuch', quantity: 2.5, unit_price_cents: 1999, vat_rate: 10 },
    { position: 3, description: 'Pflanzen', quantity: 1, unit_price_cents: 1250, vat_rate: 13 },
    { position: 4, description: 'Lizenz', quantity: 1, unit_price_cents: 120000, vat_rate: 20 },
  ],
};

export const AT_CASES: Record<string, EInvoiceModel> = {
  'at-standard': AT_BASE,
  // An invoice to a federal body: supplier number and order reference.
  'at-bund': {
    ...AT_BASE,
    buyer_reference: '4711000123',
    buyer: { ...AT_BASE.buyer, name: 'Bundesministerium für Beispiele', vat_id: null, supplier_number: '312345' },
  },
  'at-kleinunternehmer': {
    ...AT_BASE,
    seller: { ...AT_BASE.seller, vat_id: null },
    exemption: { category: 'E', reason: 'Umsatzsteuerbefreit – Kleinunternehmer gem. § 6 Abs. 1 Z 27 UStG' },
    lines: [{ position: 1, description: 'Grafikdesign', quantity: 8, unit_price_cents: 6500, vat_rate: 0 }],
  },
  'at-storno': {
    ...AT_BASE,
    type_code: '381',
    number: 'RE-2026-0042-ST',
    issue_date: '2026-10-25',
    due_date: null,
    note: 'Storno der Rechnung RE-2026-0042',
    preceding: { number: 'RE-2026-0042', issue_date: '2026-10-21' },
  },
};

