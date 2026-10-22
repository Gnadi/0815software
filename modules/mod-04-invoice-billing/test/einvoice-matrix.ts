import type { EInvoiceModel } from '../shared/einvoice.js';
import { BASE } from './einvoice-cases.js';

/**
 * A matrix of e-invoice models across the dimensions whose rules interact:
 * VAT category × how the seller is identified × who the buyer is, plus the
 * credit note. `eInvoiceProblems` (shared/einvoice.ts) mirrors the EN 16931
 * and XRechnung rules this module's data can break; the matrix is how that
 * mirror is held to the real artefacts — every model it does NOT refuse is
 * rendered and validated with Mustang (scripts/validate-einvoice.sh, the
 * e-invoice workflow in CI). The golden cases cover eleven happy paths; this
 * covers the combinations, which is where the review found files that were
 * served although they failed (docs/E-RECHNUNG-REVIEW.md, H2).
 */

type Lines = EInvoiceModel['lines'];
const line = (position: number, vat_rate: number, unit_price_cents = 10000): Lines[number] => ({
  position,
  description: `Leistung ${position}`,
  quantity: 2,
  unit_price_cents,
  vat_rate,
});

const CATEGORIES: Record<string, Pick<EInvoiceModel, 'lines' | 'exemption'>> = {
  s19: { lines: [line(1, 19)], exemption: null },
  s7_19: { lines: [line(1, 7, 1999), line(2, 19)], exemption: null },
  e: { lines: [line(1, 0)], exemption: { category: 'E', reason: 'Steuerfrei nach § 4 Nr. 14 UStG' } },
  e_s19: { lines: [line(1, 0), line(2, 19, 4550)], exemption: { category: 'E', reason: 'Steuerfrei nach § 4 Nr. 14 UStG' } },
  ae: { lines: [line(1, 0)], exemption: { category: 'AE', reason: null } },
  k: { lines: [line(1, 0)], exemption: { category: 'K', reason: null } },
  g: { lines: [line(1, 0)], exemption: { category: 'G', reason: null } },
  z: { lines: [line(1, 0)], exemption: { category: 'Z', reason: null } },
  o: { lines: [line(1, 0)], exemption: { category: 'O', reason: null } },
};

const SELLERS: Record<string, Partial<EInvoiceModel['seller']>> = {
  vat: { vat_id: 'DE123456789', tax_number: null, registration: null },
  vat_taxno: { vat_id: 'DE123456789', tax_number: '143/123/45678', registration: 'HRB 12345' },
  taxno_reg: { vat_id: null, tax_number: '143/123/45678', registration: 'HRB 12345' },
  taxno: { vat_id: null, tax_number: '143/123/45678', registration: null },
  reg: { vat_id: null, tax_number: null, registration: 'HRB 12345' },
};

const BUYERS: Record<string, { buyer: Partial<EInvoiceModel['buyer']>; buyer_reference?: string }> = {
  de_vat: { buyer: { street: 'Kundenweg 5', postcode: '10115', city: 'Berlin', country: 'DE', vat_id: 'DE987654321' } },
  de: { buyer: { street: 'Kundenweg 5', postcode: '10115', city: 'Berlin', country: 'DE', vat_id: null } },
  at_vat: { buyer: { street: 'Ring 5', postcode: '1010', city: 'Wien', country: 'AT', vat_id: 'ATU12345678' } },
  ch: { buyer: { street: 'Bahnhofstrasse 1', postcode: '8001', city: 'Zürich', country: 'CH', vat_id: null } },
  xi: { buyer: { street: 'Main Street 1', postcode: 'BT1 1AA', city: 'Belfast', country: 'XI', vat_id: 'XI123456789' } },
  public: {
    buyer: { street: 'Rathausplatz 1', postcode: '12345', city: 'Musterhausen', country: 'DE', vat_id: null, einvoice_address: '991-33333TEST-33' },
    buyer_reference: '991-33333TEST-33',
  },
};

function model(category: string, seller: string, buyer: string, creditNote = false): EInvoiceModel {
  const b = BUYERS[buyer]!;
  return {
    ...BASE,
    ...CATEGORIES[category]!,
    buyer_reference: b.buyer_reference ?? BASE.buyer_reference,
    seller: { ...BASE.seller, ...SELLERS[seller]! },
    buyer: { ...BASE.buyer, name: 'Kunde GmbH', email: 'ap@kunde.example', einvoice_address: null, ...b.buyer },
    ...(creditNote
      ? {
          type_code: '381' as const,
          number: 'INV-2026-0042-GS1',
          due_date: null,
          note: 'Gutschrift zur Rechnung INV-2026-0042 vom 2026-10-01: Teil zurück',
          preceding: { number: 'INV-2026-0042', issue_date: '2026-10-01' },
        }
      : {}),
  };
}

/** Every combination, keyed "<category>-<seller>-<buyer>", and the credit notes as "...-gs". */
export const MATRIX: Record<string, EInvoiceModel> = Object.fromEntries([
  ...Object.keys(CATEGORIES).flatMap((c) =>
    Object.keys(SELLERS).flatMap((s) => Object.keys(BUYERS).map((b) => [`${c}-${s}-${b}`, model(c, s, b)] as const)),
  ),
  // Credit notes: to a foreign buyer, so the 0 % categories have a buyer they fit.
  ...Object.keys(CATEGORIES).map((c) => {
    const buyer = c === 'g' ? 'ch' : 'at_vat';
    return [`${c}-vat_taxno-${buyer}-gs`, model(c, 'vat_taxno', buyer, true)] as const;
  }),
]);

/**
 * The review's probes that were served or rendered although they fail
 * validation (H2). Each must now be refused, naming the business term.
 */
export const REFUSED: Record<string, { model: EInvoiceModel; term: string }> = {
  // J: a buyer VAT id without a country prefix (BR-CO-09).
  J: { model: model('s19', 'vat', 'de_vat'), term: 'BT-48' },
  // K: a country code that is not in the code list (BR-CL-14).
  K: { model: model('g', 'vat', 'ch'), term: 'BT-55' },
  // O: impossible calendar dates (no validator checks them).
  O: { model: { ...model('s19', 'vat', 'de_vat'), issue_date: '2026-02-31', delivery_date: '2026-02-30' }, term: 'BT-2' },
  // P: an export from a seller with a Steuernummer but no VAT id (BR-G-02).
  P: { model: model('g', 'taxno_reg', 'ch'), term: 'BT-31' },
  // Q: exempt lines from a seller with neither VAT id nor Steuernummer (BR-E-02, BR-DE-16).
  Q: { model: model('e', 'reg', 'de'), term: 'BT-31' },
};
REFUSED.J!.model.buyer = { ...REFUSED.J!.model.buyer, vat_id: '123456789' };
REFUSED.K!.model.buyer = { ...REFUSED.K!.model.buyer, country: 'UK' };
