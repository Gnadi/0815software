import type { EInvoiceModel } from '../shared/einvoice.js';

/**
 * The e-invoice cases the golden files in test/fixtures/einvoice/ are made
 * from — one per VAT situation this module can express, plus the
 * cancellation and a public-sector buyer addressed by Leitweg-ID.
 *
 * Every golden file was validated OUTSIDE this repository before it was
 * committed: Mustang 2.26.0 (EN 16931 + XRechnung 3.0 schematron, KoSIT
 * rules; veraPDF for the PDF/A) and the Factur-X EN16931 XSD. A change to the
 * renderer changes a golden file, which fails the test until someone has
 * re-validated and re-generated them: `npm run einvoice:fixtures`, then
 * `scripts/validate-einvoice.sh` (needs Java). See docs/E-RECHNUNG.md.
 */

export const BASE: EInvoiceModel = {
  type_code: '380', number: 'INV-2026-0042', issue_date: '2026-10-21', due_date: '2026-11-04', delivery_date: '2026-10-15', period: null,
  payment_terms_days: 14, buyer_reference: 'PO-7781', note: null, preceding: null, exemption: null,
  seller: { name: 'Beispiel GmbH', address_lines: [], street: 'Hauptstraße 1', postcode: '80331', city: 'München', country: 'DE',
    vat_id: 'DE123456789', tax_number: null, iban: 'DE02120300000000202051', bic: null, contact_name: 'Erika Mustermann', phone: '+49 89 123456', email: 'rechnung@beispiel.de', einvoice_address: null },
  buyer: { name: 'Kunde GmbH', address: null, street: 'Ring 5', postcode: '1010', city: 'Wien', country: 'AT', vat_id: 'ATU12345678', email: 'ap@kunde.at', einvoice_address: null },
  lines: [{ position: 1, description: 'Leistung', quantity: 1.5, unit_price_cents: 10000, vat_rate: 0 }],
  line_rounding: 'decimal',
};

export const CASES: Record<string, EInvoiceModel> = {
  // A German invoice with both German rates, a BIC, a delivery date before
  // the issue date, and a note that needs escaping.
  standard: {
    ...BASE,
    note: 'Projekt Müller & Söhne <Phase 2>',
    seller: { ...BASE.seller, bic: 'BYLADEM1001' },
    buyer: { ...BASE.buyer, name: 'Kunde AG', street: 'Kundenweg 5', postcode: '10115', city: 'Berlin', country: 'DE', vat_id: 'DE987654321', email: 'ap@kunde.de' },
    lines: [
      { position: 1, description: 'Beratung „Strategie“ – Tag', quantity: 3, unit_price_cents: 33, vat_rate: 19 },
      { position: 2, description: 'Fachbuch', quantity: 2.5, unit_price_cents: 1999, vat_rate: 7 },
      { position: 3, description: 'Lizenz', quantity: 1, unit_price_cents: 120000, vat_rate: 19 },
    ],
  },
  ae: { ...BASE, exemption: { category: 'AE', reason: null } },
  k: { ...BASE, exemption: { category: 'K', reason: null } },
  g: { ...BASE, buyer: { ...BASE.buyer, country: 'CH', vat_id: null }, exemption: { category: 'G', reason: null } },
  e: { ...BASE, buyer: { ...BASE.buyer, country: 'DE', vat_id: null }, exemption: { category: 'E', reason: 'Kein Ausweis von Umsatzsteuer, da Kleinunternehmer gemäß § 19 UStG' } },
  o: { ...BASE, seller: { ...BASE.seller, registration: 'HRB 12345' }, exemption: { category: 'O', reason: null } },
  z: { ...BASE, buyer: { ...BASE.buyer, country: 'DE' }, exemption: { category: 'Z', reason: null } },
  mixed_e: { ...BASE, buyer: { ...BASE.buyer, country: 'DE' }, exemption: { category: 'E', reason: 'Steuerfrei nach § 4 Nr. 14 UStG' }, lines: [...BASE.lines, { position: 2, description: 'Material', quantity: 2, unit_price_cents: 4550, vat_rate: 19 }] },
  taxno: { ...BASE, seller: { ...BASE.seller, vat_id: null, tax_number: '143/123/45678', registration: 'HRB 12345' }, buyer: { ...BASE.buyer, country: 'DE' }, lines: [{ position: 1, description: 'x', quantity: 1, unit_price_cents: 100, vat_rate: 19 }] },
  storno: { ...BASE, type_code: '381', number: 'INV-2026-0042-ST', due_date: null, note: 'Storno der Rechnung INV-2026-0042', preceding: { number: 'INV-2026-0042', issue_date: '2026-10-01' },
    buyer: { ...BASE.buyer, country: 'DE' }, lines: [{ position: 1, description: 'x', quantity: 3, unit_price_cents: 33, vat_rate: 19 }] },
  // A partial credit note (Teilgutschrift): 381 like the storno, but only part
  // of the invoice — two returned books at 7 %, the 19 % lines untouched.
  teilgutschrift: { ...BASE, type_code: '381', number: 'INV-2026-0042-GS1', issue_date: '2026-10-25', due_date: null,
    note: 'Gutschrift zur Rechnung INV-2026-0042 vom 2026-10-21: 2 Fachbücher retourniert', preceding: { number: 'INV-2026-0042', issue_date: '2026-10-21' },
    buyer: { ...BASE.buyer, country: 'DE' }, lines: [{ position: 1, description: 'Fachbuch', quantity: 2, unit_price_cents: 1999, vat_rate: 7 }] },
  // Review case C: a quantity with four decimals, rounded half up exactly
  // (0.3333 × 999.99 € = 333.30 €), and texts long enough that the PDF has to
  // wrap them — it used to cut them off.
  long: {
    ...BASE,
    buyer_reference: 'Bestellung 4500012345 / Kostenstelle 4711-0815 / Ansprechpartnerin Frau Meier',
    note: 'Projekt Sanierung Heizzentrale Schulzentrum Nord, Bauabschnitt 2 — Abrechnung nach Aufmaß vom 14.10.2026.',
    buyer: { ...BASE.buyer, name: 'Kunde AG', street: 'Kundenweg 5', postcode: '10115', city: 'Berlin', country: 'DE', vat_id: 'DE987654321', email: 'ap@kunde.de' },
    exemption: { category: 'E', reason: 'Steuerfrei nach § 4 Nr. 14 Buchst. a UStG (Heilbehandlungen im Bereich der Humanmedizin durch Ärzte, Zahnärzte, Heilpraktiker und Physiotherapeuten)' },
    lines: [
      { position: 1, description: 'Wartung der Heizungsanlage gemäß Wartungsvertrag Nr. 2026-117, inkl. Abgasmessung, Austausch der Zündelektrode und Prüfung des Ausdehnungsgefäßes', quantity: 0.3333, unit_price_cents: 99999, vat_rate: 19 },
      { position: 2, description: 'Heilbehandlung', quantity: 1, unit_price_cents: 5000, vat_rate: 0 },
    ],
  },
  // Review finding M7: a monthly fee billed for its service period (BG-14).
  // Its delivery date is the period's last day, as the API derives it when
  // none was entered.
  period: {
    ...BASE,
    delivery_date: '2026-10-31',
    period: { start: '2026-10-01', end: '2026-10-31' },
    buyer: { ...BASE.buyer, name: 'Kunde AG', street: 'Kundenweg 5', postcode: '10115', city: 'Berlin', country: 'DE', vat_id: 'DE987654321', email: 'ap@kunde.de' },
    lines: [{ position: 1, description: 'Wartungspauschale Oktober 2026', quantity: 1, unit_price_cents: 25000, vat_rate: 19 }],
  },
  leitweg: { ...BASE, buyer_reference: '991-12345-73', buyer: { ...BASE.buyer, country: 'DE', einvoice_address: '991-12345-73' }, lines: [{ position: 1, description: 'x', quantity: 1, unit_price_cents: 100, vat_rate: 7 }] },
};
