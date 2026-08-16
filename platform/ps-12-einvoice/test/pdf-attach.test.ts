import { describe, expect, it } from 'vitest';
import { attachFacturX, extractFacturX, FACTUR_X_FILENAME, PdfAttachError } from '../server/pdf-attach.js';

/**
 * The ZUGFeRD / Factur-X hybrid: the EN 16931 XML living inside the PDF.
 *
 * Two properties, and the first is the one the whole design rests on.
 *
 * **The caller's bytes are not touched.** A module hands over a PDF it
 * rendered; the result must be that PDF with objects appended, byte-identical
 * as a prefix. That is what makes it safe for PS-12 to do this without owning
 * a renderer, and what means a change to MOD-04's layout can never break the
 * attachment.
 *
 * **A reader can get the XML back out.** Asserted by extracting it, not by
 * checking that some bytes are present — the round trip is what a consuming
 * system actually performs.
 */

/**
 * A minimal but structurally real PDF, built the way the modules' writers
 * build one: catalog, pages, one page, one content stream, xref, trailer.
 */
function samplePdf(): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >>',
    '<< /Length 44 >>\nstream\nBT /F1 12 Tf 72 720 Td (Invoice) Tj ET\nendstream',
  ];
  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const XML = '<?xml version="1.0" encoding="UTF-8"?>\n<rsm:CrossIndustryInvoice>ä€</rsm:CrossIndustryInvoice>\n';

describe('attaching the invoice XML', () => {
  it('leaves the original document byte-identical as a prefix', () => {
    const original = samplePdf();
    const hybrid = attachFacturX(original, XML, 'EN 16931');
    expect(hybrid.subarray(0, original.length).equals(original)).toBe(true);
    expect(hybrid.length).toBeGreaterThan(original.length);
  });

  it('round-trips the XML, including non-ASCII', () => {
    const hybrid = attachFacturX(samplePdf(), XML, 'EN 16931');
    expect(extractFacturX(hybrid)).toBe(XML);
  });

  it('names the attachment exactly what ZUGFeRD readers look for', () => {
    const text = attachFacturX(samplePdf(), XML, 'EN 16931').toString('latin1');
    expect(FACTUR_X_FILENAME).toBe('factur-x.xml');
    expect(text).toContain(`/F (${FACTUR_X_FILENAME})`);
    expect(text).toContain(`/UF (${FACTUR_X_FILENAME})`);
  });

  // The load-bearing key: /Alternative says this attachment IS the invoice in
  // another form. Without it a reader treats the XML as a supplementary file
  // and never parses it as the invoice.
  it('declares the attachment as an alternative representation', () => {
    const text = attachFacturX(samplePdf(), XML, 'EN 16931').toString('latin1');
    expect(text).toContain('/AFRelationship /Alternative');
  });

  it('registers it where readers look: the name tree and /AF', () => {
    const text = attachFacturX(samplePdf(), XML, 'EN 16931').toString('latin1');
    expect(text).toContain('/Names << /EmbeddedFiles');
    expect(text).toMatch(/\/AF \[\d+ 0 R\]/);
  });

  it('carries the original catalog keys forward', () => {
    // The appended catalog SUPERSEDES the original, so anything it held has to
    // come along — a document that loses /Pages is a document with no pages.
    const text = attachFacturX(samplePdf(), XML, 'EN 16931').toString('latin1');
    const lastCatalog = text.slice(text.lastIndexOf('1 0 obj'));
    expect(lastCatalog).toContain('/Type /Catalog');
    expect(lastCatalog).toContain('/Pages 2 0 R');
  });

  it('writes an incremental xref chained to the original one', () => {
    const original = samplePdf();
    const hybrid = attachFacturX(original, XML, 'EN 16931').toString('latin1');
    const originalStartxref = Number(/startxref\s+(\d+)/.exec(original.toString('latin1'))![1]);
    expect(hybrid).toContain(`/Prev ${originalStartxref}`);
    // Exactly two %%EOF markers: the original's and this update's.
    expect(hybrid.match(/%%EOF/g)).toHaveLength(2);
  });

  it('declares the profile in the XMP a reader checks before parsing', () => {
    const en = attachFacturX(samplePdf(), XML, 'EN 16931').toString('latin1');
    expect(en).toContain('<fx:ConformanceLevel>EN 16931</fx:ConformanceLevel>');
    expect(en).toContain(`<fx:DocumentFileName>${FACTUR_X_FILENAME}</fx:DocumentFileName>`);

    const xr = attachFacturX(samplePdf(), XML, 'XRECHNUNG').toString('latin1');
    expect(xr).toContain('<fx:ConformanceLevel>XRECHNUNG</fx:ConformanceLevel>');
  });

  // Claiming a conformance the document does not have is worse than claiming
  // none: a validator downstream tests the claim, and the modules' PDF writers
  // use non-embedded base-14 fonts, which PDF/A-3 forbids.
  it('does NOT claim PDF/A conformance it cannot deliver', () => {
    const text = attachFacturX(samplePdf(), XML, 'EN 16931').toString('latin1');
    expect(text).not.toContain('pdfaid');
  });

  it('is deterministic when the timestamp is pinned', () => {
    const at = '2026-07-20T09:00:00Z';
    const a = attachFacturX(samplePdf(), XML, 'EN 16931', { at });
    const b = attachFacturX(samplePdf(), XML, 'EN 16931', { at });
    expect(a.equals(b)).toBe(true);
    expect(a.toString('latin1')).toContain('(D:20260720090000Z)');
  });

  it('survives being attached to a document that was already updated once', () => {
    // An incremental update on top of an incremental update — the case that
    // breaks a naive "count the obj occurrences" implementation.
    const once = attachFacturX(samplePdf(), XML, 'EN 16931');
    const twice = attachFacturX(once, '<?xml version="1.0"?><second/>', 'XRECHNUNG');
    expect(twice.subarray(0, once.length).equals(once)).toBe(true);
    expect(extractFacturX(twice)).toBe('<?xml version="1.0"?><second/>');
    expect(twice.toString('latin1').match(/%%EOF/g)).toHaveLength(3);
  });
});

describe('refusing what is not a PDF', () => {
  it.each([
    ['plain text', Buffer.from('this is not a PDF')],
    ['empty', Buffer.alloc(0)],
    ['XML', Buffer.from('<?xml version="1.0"?><x/>')],
  ])('throws on %s rather than producing a broken file', (_label, bytes) => {
    expect(() => attachFacturX(bytes, XML, 'EN 16931')).toThrow(PdfAttachError);
  });

  it('throws on a PDF header with no trailer', () => {
    expect(() => attachFacturX(Buffer.from('%PDF-1.4\nnothing else'), XML, 'EN 16931')).toThrow(PdfAttachError);
  });

  it('returns null when asked to extract from a PDF with no attachment', () => {
    expect(extractFacturX(samplePdf())).toBeNull();
  });
});

describe('against a PDF this catalogue actually produces', () => {
  // The sample above is hand-built and therefore agrees with my assumptions by
  // construction. This one comes from MOD-04's real renderer — the writer whose
  // output an operator would actually attach — so a change to it that broke the
  // trailer or the catalog would fail here rather than in a customer's reader.
  it('attaches to a real MOD-04 invoice PDF and round-trips', async () => {
    const { renderInvoicePdf } = await import('../../../modules/mod-04-invoice-billing/server/pdf.js');
    const invoice = {
      id: 1,
      number: 'INV-2026-0001',
      customer_id: 1,
      customer_name: 'Nordwind AG',
      status: 'sent',
      payment_status: 'unpaid',
      issue_date: '2026-07-20',
      due_date: '2026-08-03',
      overdue: false,
      payment_terms_days: 14,
      note: 'Danke für Ihren Auftrag.',
      cancelled_at: null,
      cancellation_reason: null,
      lines: [
        {
          id: 1,
          invoice_id: 1,
          position: 1,
          description: 'Consulting',
          quantity: 2,
          unit_price_cents: 1234,
          vat_rate: 20,
          vat_category: 'S',
          net_cents: 2468,
        },
      ],
      vat_breakdown: [{ rate: 20, base_cents: 2468, vat_cents: 494 }],
      payments: [],
      net_cents: 2468,
      vat_cents: 494,
      gross_cents: 2962,
      paid_cents: 0,
      open_cents: 2962,
      created_at: '2026-07-20T09:00:00Z',
    };
    const customer = {
      id: 1,
      name: 'Nordwind AG',
      email: 'rechnungen@nordwind.example',
      vat_id: 'DE811234567',
      address: 'Hafenstraße 4\n20359 Hamburg',
      created_at: '2026-01-01T00:00:00Z',
    };
    const seller = {
      name: '0815software GmbH',
      addressLines: ['Teststraße 1', '4020 Linz', 'Austria'],
      vatId: 'ATU12345678',
      iban: 'AT611904300234573201',
      bic: 'BKAUATWW',
    };

    const pdf = renderInvoicePdf(invoice as never, customer as never, seller as never);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');

    const hybrid = attachFacturX(pdf, XML, 'EN 16931', { at: '2026-07-20T09:00:00Z' });
    expect(hybrid.subarray(0, pdf.length).equals(pdf)).toBe(true);
    expect(extractFacturX(hybrid)).toBe(XML);

    // The page content survived: the invoice number is still drawn on it.
    expect(hybrid.toString('latin1')).toContain('INV-2026-0001');
  });
});
