/**
 * Regenerate the e-invoice golden files from test/einvoice-cases.ts.
 *
 *   npm run einvoice:fixtures                 → test/fixtures/einvoice/*.xml
 *   npm run einvoice:fixtures -- <dir> pdf    → <dir>, plus a ZUGFeRD PDF per case
 *   npm run einvoice:fixtures -- <dir> matrix → <dir>, as `pdf`, plus every case of
 *     test/einvoice-matrix.ts the module does not refuse, in both profiles, and a
 *     ZUGFeRD PDF for each matrix credit note — what scripts/validate-einvoice.sh
 *     hands to the reference validator
 *
 * Only after `scripts/validate-einvoice.sh` has passed on the output may the
 * regenerated files be committed — see docs/E-RECHNUNG.md.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EINVOICE_PROFILES, eInvoiceProblems, renderCii, type EInvoiceModel } from '../shared/einvoice.js';
import { computeTotals, lineNetCents } from '../shared/money.js';
import type { InvoiceDetail } from '../shared/types.js';
import { layoutInvoice } from '../server/pdf.js';
import { buildPdfA } from '../server/pdfa.js';
import { CASES } from '../test/einvoice-cases.js';
import { MATRIX } from '../test/einvoice-matrix.js';

const out = process.argv[2] ?? join(import.meta.dirname, '..', 'test', 'fixtures', 'einvoice');
const mode = process.argv[3];
const withPdf = mode === 'pdf' || mode === 'matrix';
mkdirSync(out, { recursive: true });

/** The ZUGFeRD PDF/A of a model, laid out the way the API lays out an issued invoice. */
function zugferdPdf(model: EInvoiceModel): Buffer {
  const totals = computeTotals(model.lines);
  // A cancellation is laid out from the cancelled invoice; a partial credit
  // note (-GS) from a live one carrying the credit note's lines.
  const cancels = model.type_code === '381' && !model.number.includes('-GS');
  const detail: InvoiceDetail = {
    // A cancellation is laid out from the invoice it cancels, as the API does.
    id: 1, number: model.preceding?.number ?? model.number, customer_id: 1, customer_name: model.buyer.name,
    status: cancels ? 'cancelled' : 'sent',
    payment_status: 'unpaid', issue_date: model.preceding?.issue_date ?? model.issue_date, due_date: model.due_date, overdue: false,
    net_cents: totals.net_cents, vat_cents: totals.vat_cents, gross_cents: totals.gross_cents, paid_cents: 0,
    created_at: model.issue_date, payment_terms_days: model.payment_terms_days, note: cancels || model.type_code === '380' ? model.note : null,
    buyer_reference: model.buyer_reference, delivery_date: model.delivery_date,
    tax_exemption_category: model.exemption?.category ?? null, tax_exemption_reason: model.exemption?.reason ?? null,
    parties_frozen: true, cancelled_at: cancels ? `${model.issue_date}T00:00:00Z` : null,
    cancellation_reason: cancels ? 'Doppelt fakturiert' : null,
    lines: model.lines.map((l, i) => ({ ...l, id: i + 1, invoice_id: 1, net_cents: lineNetCents(l) })),
    vat_breakdown: totals.by_rate, payments: [], open_cents: totals.gross_cents,
    credited_cents: 0, credit_notes: [], creditable: [],
  };
  const pages = layoutInvoice(
    detail,
    { name: model.buyer.name, address: [model.buyer.street, `${model.buyer.postcode} ${model.buyer.city}`].join('\n'), vat_id: model.buyer.vat_id },
    { name: model.seller.name, addressLines: [model.seller.street ?? '', `${model.seller.postcode} ${model.seller.city}`], vatId: model.seller.vat_id ?? '', iban: model.seller.iban, bic: model.seller.bic ?? '' },
    model.type_code === '381'
      ? { number: model.number, date: model.issue_date, ...(model.number.includes('-GS') ? { reason: model.note ?? '' } : {}) }
      : undefined,
  );
  return buildPdfA(pages, { xml: renderCii(model, 'zugferd'), title: `Rechnung ${model.number}`, author: model.seller.name, date: model.issue_date });
}

for (const [name, model] of Object.entries(CASES)) {
  for (const profile of EINVOICE_PROFILES) writeFileSync(join(out, `${name}-${profile}.xml`), renderCii(model, profile));
  if (withPdf) writeFileSync(join(out, `${name}-zugferd.pdf`), zugferdPdf(model));
}

let matrixFiles = 0;
if (mode === 'matrix') {
  for (const [name, model] of Object.entries(MATRIX)) {
    for (const profile of EINVOICE_PROFILES) {
      // A refused model is never served, so there is nothing to validate.
      if (eInvoiceProblems(model, profile).length > 0) continue;
      writeFileSync(join(out, `matrix-${name}-${profile}.xml`), renderCii(model, profile));
      matrixFiles++;
      if (profile === 'zugferd' && model.type_code === '381') {
        writeFileSync(join(out, `matrix-${name}-zugferd.pdf`), zugferdPdf(model));
        matrixFiles++;
      }
    }
  }
}
console.log(`wrote ${Object.keys(CASES).length} cases${mode === 'matrix' ? ` and ${matrixFiles} matrix files` : ''} to ${out}`);
