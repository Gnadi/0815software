/**
 * Minimal hand-rolled PDF writer — zero dependencies, fully offline.
 *
 * Scope is deliberately tiny: A4 pages, the built-in Type1 base fonts
 * (Helvetica for prose, Courier for tabular figures — fixed-width glyphs
 * make right-alignment exact without font metric tables), WinAnsi
 * encoding (covers Latin-1 plus the € sign at 0x80), text and hairline
 * ops, uncompressed content streams. That is everything an invoice
 * needs, and the output is valid PDF 1.4 that every viewer opens.
 */

import { EXEMPTION_DEFAULT_REASON } from '../shared/einvoice.js';
import { fmtEur } from '../shared/money.js';
import type { CreditNote, Customer, InvoiceDetail } from '../shared/types.js';
import type { SellerConfig } from './config.js';
import { fonts, unicodeOf, winAnsiOf } from './fonts.js';

export const A4 = { width: 595.28, height: 841.89 };

export const FONTS = {
  F1: 'Helvetica',
  F2: 'Helvetica-Bold',
  F3: 'Courier',
  F4: 'Courier-Bold',
} as const;
export type FontKey = keyof typeof FONTS;

/** Courier glyph width: 600/1000 em — exact, per the AFM spec. */
const COURIER_EM = 0.6;

/** Letters WinAnsi lacks that carry no accent to strip: shown as the letter they are written like. */
const BASE_LETTER: Record<string, string> = { Ł: 'L', ł: 'l', Đ: 'D', đ: 'd', ı: 'i', Ħ: 'H', ħ: 'h', Ŧ: 'T', ŧ: 't', '−': '-' };

/**
 * A JS string as WinAnsi codes. Control characters (a tab pasted into a line
 * description) become spaces: they have no glyph, and a PDF/A may not show
 * the .notdef box in their place. A letter WinAnsi has no code for is shown
 * without its accent — "Łódź" as "Lódz", "Čech" as "Cech" — rather than as
 * "?", which said nothing; the XML carries the name exactly. Writing every
 * name as it is needs a Unicode font in the PDF (Identity-H), not yet done.
 *
 * Composed first: text pasted from a Mac often spells "ö" as "o" plus a
 * combining diaeresis, which WinAnsi has as one letter. An accent left over
 * after that has nothing to sit on in WinAnsi and is dropped.
 */
export function winAnsiCodes(text: string): number[] {
  const codes: number[] = [];
  for (const ch of text.normalize('NFC')) {
    const point = ch.codePointAt(0)!;
    if (point < 0x20 || (point >= 0x7f && point < 0xa0)) {
      codes.push(0x20);
      continue;
    }
    const direct = winAnsiOf(point);
    if (direct !== null) {
      codes.push(direct);
      continue;
    }
    const base = BASE_LETTER[ch] ?? ch.normalize('NFD').replace(/\p{M}/gu, '');
    if (base === '') continue;
    const fallback = base.length === 1 ? winAnsiOf(base.codePointAt(0)!) : null;
    codes.push(fallback ?? 0x3f); // '?'
  }
  return codes;
}

/** Escaped WinAnsi bytes for a PDF string literal. */
function escapeCodes(codes: number[]): string {
  let out = '';
  for (const code of codes) {
    if (code === 0x5c) out += '\\\\';
    else if (code === 0x28) out += '\\(';
    else if (code === 0x29) out += '\\)';
    else if (code >= 0x20 && code < 0x7f) out += String.fromCharCode(code);
    else out += `\\${code.toString(8).padStart(3, '0')}`;
  }
  return out;
}

const n = (value: number): string => String(Math.round(value * 100) / 100);

/** Width of `text` set in `font` at `size`, in points — the metrics both PDFs share (server/fonts.ts). */
export function textWidth(font: FontKey, size: number, text: string): number {
  const ttf = fonts()[font];
  let units = 0;
  for (const code of winAnsiCodes(text)) units += ttf.width(ttf.glyphOf(unicodeOf(code) ?? 0x3f));
  return (units * size) / 1000;
}

/**
 * `text` as lines no wider than `width`: broken at spaces, inside a word only
 * when the word alone is wider, and at the line breaks it already has. The
 * PDF used to cut texts off ("Wartungsvert…") while the XML carried them in
 * full — the picture of an e-invoice saying less than the invoice (review M1).
 */
export function wrapText(font: FontKey, size: number, text: string, width: number): string[] {
  const fits = (line: string): boolean => textWidth(font, size, line) <= width;
  const lines: string[] = [];
  for (const paragraph of text.split(/\r?\n/)) {
    let line = '';
    for (let word of paragraph.split(/ +/).filter((w) => w !== '')) {
      const longer = line === '' ? word : `${line} ${word}`;
      if (fits(longer)) {
        line = longer;
        continue;
      }
      if (line !== '') lines.push(line);
      while (!fits(word)) {
        let cut = word.length - 1;
        while (cut > 1 && !fits(word.slice(0, cut))) cut--;
        lines.push(word.slice(0, cut));
        word = word.slice(cut);
      }
      line = word;
    }
    lines.push(line);
  }
  return lines;
}

/** One page of drawing ops. y runs DOWN from the top edge (like CSS). */
export class Page {
  private ops: string[] = [];
  /** Which WinAnsi codes each font shows — what a PDF/A font subset must keep. */
  readonly used = new Map<FontKey, Set<number>>();

  /** Left-aligned text. `gray` 0 = black … 1 = white. */
  text(font: FontKey, size: number, x: number, y: number, value: string, gray = 0): void {
    const codes = winAnsiCodes(value);
    const used = this.used.get(font) ?? new Set<number>();
    for (const code of codes) used.add(code);
    this.used.set(font, used);
    this.ops.push(
      `${n(gray)} g BT /${font} ${n(size)} Tf ${n(x)} ${n(A4.height - y)} Td (${escapeCodes(codes)}) Tj ET`,
    );
  }

  /** Right-aligned text — Courier fonts only (fixed glyph width). */
  textRight(font: 'F3' | 'F4', size: number, xRight: number, y: number, value: string, gray = 0): void {
    // Counted in the glyphs shown, not UTF-16 units: "😀" is one "?", a dropped accent none.
    this.text(font, size, xRight - winAnsiCodes(value).length * COURIER_EM * size, y, value, gray);
  }

  /** Horizontal hairline. */
  line(x1: number, y: number, x2: number, width = 0.5, gray = 0.6): void {
    this.ops.push(
      `${n(width)} w ${n(gray)} G ${n(x1)} ${n(A4.height - y)} m ${n(x2)} ${n(A4.height - y)} l S`,
    );
  }

  content(): string {
    return this.ops.join('\n');
  }
}

/** Assemble pages into a complete PDF file. */
export function buildPdf(pages: Page[]): Buffer {
  const fontKeys = Object.keys(FONTS) as FontKey[];
  // Object ids: 1 catalog, 2 pages, 3..(2+nFonts) fonts, then [page, content] pairs.
  const firstPageId = 3 + fontKeys.length;
  const pageIds = pages.map((_, i) => firstPageId + i * 2);

  const resources = `<< /Font << ${fontKeys.map((k, i) => `/${k} ${3 + i} 0 R`).join(' ')} >> >>`;
  const objects: string[] = [
    `<< /Type /Catalog /Pages 2 0 R >>`,
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`,
    ...fontKeys.map(
      (k) => `<< /Type /Font /Subtype /Type1 /BaseFont /${FONTS[k]} /Encoding /WinAnsiEncoding >>`,
    ),
  ];
  for (const page of pages) {
    const stream = page.content();
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(A4.width)} ${n(A4.height)}] /Resources ${resources} /Contents ${objects.length + 2} 0 R >>`,
    );
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }

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

// ── Invoice layout ─────────────────────────────────────────────────────

const M = 56; // page margin
const R = A4.width - M; // right edge
const COL = { qty: 356, price: 432, vat: 466, net: R }; // right edges of number columns
/** The description column ends where the widest quantity ("999.999,9999", 9 pt Courier) begins. */
const DESCRIPTION_WIDTH = COL.qty - 12 * COURIER_EM * 9 - 6 - (M + 30);
/** Where the page body ends: the footer's rule sits 78 pt above the bottom edge. */
const BODY_END = A4.height - 90;

/**
 * A quantity as the XML states it — four decimals at most — and written the
 * way the amounts beside it are: 1.234,5. It used to show three, so 0.33333
 * read 0.333 here and 0.3333 in the XML, with a dot a German reader takes for
 * a thousands separator.
 */
function fmtQty(quantity: number): string {
  const tenThousandths = Math.round(quantity * 10_000);
  const whole = String(Math.floor(tenThousandths / 10_000)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  const fraction = String(tenThousandths % 10_000).padStart(4, '0').replace(/0+$/, '');
  return fraction === '' ? whole : `${whole},${fraction}`;
}

function tableHead(page: Page, y: number): number {
  page.text('F4', 7, M, y, 'POS', 0.45);
  page.text('F4', 7, M + 30, y, 'DESCRIPTION', 0.45);
  page.textRight('F4', 7, COL.qty, y, 'QTY', 0.45);
  page.textRight('F4', 7, COL.price, y, 'UNIT PRICE', 0.45);
  page.textRight('F4', 7, COL.vat, y, 'VAT', 0.45);
  page.textRight('F4', 7, COL.net, y, 'NET', 0.45);
  page.line(M, y + 6, R, 0.7, 0.3);
  return y + 22;
}

/**
 * The customer fields the letterhead prints, and the number the customer knows
 * us by — which the e-invoice carries as BT-29, so the picture names it too.
 */
export type PdfCustomer = Pick<Customer, 'name' | 'address' | 'vat_id'> & { supplier_number?: string | null };

/** Render an invoice as a letterhead-style PDF. */
export function renderInvoicePdf(invoice: InvoiceDetail, customer: PdfCustomer, seller: SellerConfig): Buffer {
  return buildPdf(layoutInvoice(invoice, customer, seller));
}

/**
 * The invoice as a partial credit note shows it: the credit note's lines and
 * totals under the invoice's header data (parties, service date, reference,
 * VAT exemption), with nothing paid or open — the document states what is
 * credited, not where the account stands.
 */
export function creditNoteView(invoice: InvoiceDetail, note: CreditNote): InvoiceDetail {
  return {
    ...invoice,
    status: 'sent',
    lines: note.lines,
    vat_breakdown: note.vat_breakdown,
    net_cents: note.net_cents,
    vat_cents: note.vat_cents,
    gross_cents: note.gross_cents,
    credited_cents: 0,
    paid_cents: 0,
    open_cents: 0,
    note: null,
    cancellation_reason: null,
    payments: [],
    credit_notes: [],
    creditable: [],
  };
}

/** Render a partial credit note — the same layout, its own number and date. */
export function renderCreditNotePdf(invoice: InvoiceDetail, note: CreditNote, customer: PdfCustomer, seller: SellerConfig): Buffer {
  return buildPdf(
    layoutInvoice(creditNoteView(invoice, note), customer, seller, { number: note.number, date: note.issue_date, reason: note.reason }),
  );
}

/**
 * Lay an invoice out as pages. Shared by the plain PDF above and the PDF/A-3
 * that carries a ZUGFeRD invoice (server/pdfa.ts), so the two cannot differ
 * in anything but the fonts they are set in.
 */
export function layoutInvoice(
  invoice: InvoiceDetail,
  customer: PdfCustomer,
  seller: SellerConfig,
  /**
   * Lay out a CREDIT NOTE on `invoice` instead (type 381), with its own
   * number and date and a reference to the invoice: its cancellation when
   * there is no `reason`, a partial credit note (whose lines `invoice` then
   * carries, see `creditNoteView`) when there is.
   */
  cancellation?: { number: string; date: string; reason?: string },
): Page[] {
  const partial = cancellation?.reason !== undefined;
  const pages: Page[] = [];
  let page = new Page();
  pages.push(page);

  // ── Letterhead ──
  page.text('F2', 26, M, 78, '0815');
  page.text('F3', 6.5, M, 92, `${seller.name.toUpperCase()} · STANDARD BUSINESS SOFTWARE`, 0.45);
  page.textRight(
    'F4', 13, R, 78,
    partial
      ? 'CREDIT NOTE'
      : cancellation
        ? 'CREDIT NOTE · CANCELLATION'
        : invoice.status === 'cancelled'
          ? 'CANCELLED INVOICE'
          : 'INVOICE',
  );
  page.line(M, 106, R, 0.8, 0.2);

  // ── Seller / bill-to / meta ──
  const sellerLine = [seller.name, ...seller.addressLines].join(' · ');
  page.text('F1', 7, M, 122, sellerLine, 0.45);

  let y = 150;
  const metaX = 356;
  const billTo = metaX - 12 - M;
  page.text('F4', 7, M, y, 'BILL TO', 0.45);
  let addrY = y + 16;
  for (const line of wrapText('F2', 10, customer.name, billTo)) {
    page.text('F2', 10, M, addrY, line);
    addrY += 13;
  }
  addrY += 1;
  for (const line of wrapText('F1', 9, customer.address ?? '', billTo).filter((l) => l !== '')) {
    page.text('F1', 9, M, addrY, line, 0.25);
    addrY += 13;
  }
  if (customer.vat_id) {
    page.text('F3', 8, M, addrY + 2, `VAT ${customer.vat_id}`, 0.45);
    addrY += 15;
  }

  const meta: [string, string][] = cancellation
    ? [
        ['CREDIT NOTE NO', cancellation.number],
        ['ISSUE DATE', cancellation.date],
        [partial ? 'CORRECTS' : 'CANCELS', invoice.number ?? '—'],
        ['INVOICE DATE', invoice.issue_date ?? '—'],
      ]
    : [
        ['INVOICE NO', invoice.number ?? 'DRAFT'],
        ['ISSUE DATE', invoice.issue_date ?? '—'],
        ['DUE DATE', invoice.due_date ?? '—'],
        ['TERMS', `${invoice.payment_terms_days} DAYS NET`],
      ];
  // The date of supply is a mandatory invoice field (§ 14 Abs. 4 Nr. 6 UStG,
  // § 11 Abs. 1 Z 3 lit. d UStG-AT): the service period when there is one,
  // the service date beside it only when one was entered, and without either
  // the issue date — as in the XML.
  if (invoice.issue_date !== null) {
    const period = invoice.period_start !== null && invoice.period_end !== null;
    const rows: [string, string][] = [];
    // One day per row like every other date here; as one value it would wrap.
    if (period) rows.push(['SERVICE FROM', invoice.period_start!], ['SERVICE TO', invoice.period_end!]);
    if (invoice.delivery_date !== null || !period) rows.push(['SERVICE DATE', invoice.delivery_date ?? invoice.issue_date]);
    meta.splice(2, 0, ...rows);
  }
  if (invoice.buyer_reference) meta.push(['YOUR REF', invoice.buyer_reference]);
  if (customer.supplier_number) meta.push(['SUPPLIER NO', customer.supplier_number]);
  if (invoice.status === 'cancelled' && !cancellation) {
    meta.push(['CANCELLED', invoice.cancelled_at?.slice(0, 10) ?? '']);
  }
  let metaY = y;
  for (const [label, value] of meta) {
    page.text('F4', 7, metaX, metaY, label, 0.45);
    const lines = wrapText('F3', 9, value, R - metaX - textWidth('F4', 7, label) - 8);
    lines.forEach((line, i) => page.textRight('F3', 9, R, metaY + i * 11, line));
    metaY += 16 + (lines.length - 1) * 11;
  }

  y = Math.max(addrY, metaY) + 24;

  if (invoice.number === null) {
    page.text('F2', 10, M, y, 'DRAFT — NOT A VALID INVOICE', 0.3);
    y += 20;
  }

  // ── Line items ──
  y = tableHead(page, y);
  for (const line of invoice.lines) {
    const description = wrapText('F1', 9, line.description, DESCRIPTION_WIDTH);
    const extra = (description.length - 1) * 11;
    if (y + extra > A4.height - 200) {
      page = new Page();
      pages.push(page);
      y = tableHead(page, 78);
    }
    page.text('F3', 9, M, y, String(line.position), 0.45);
    description.forEach((text, i) => page.text('F1', 9, M + 30, y + i * 11, text));
    page.textRight('F3', 9, COL.qty, y, fmtQty(line.quantity));
    page.textRight('F3', 9, COL.price, y, fmtEur(line.unit_price_cents));
    page.textRight('F3', 9, COL.vat, y, `${line.vat_rate}%`);
    page.textRight('F3', 9, COL.net, y, fmtEur(line.net_cents));
    y += 16 + extra;
  }
  page.line(M, y - 6, R, 0.5, 0.6);

  // ── Totals / VAT summary ──
  if (y > A4.height - 220) {
    page = new Page();
    pages.push(page);
    y = 78;
  }
  y += 14;
  const label = (text: string, value: string, bold = false): void => {
    page.text('F4', 7, 340, y, text, bold ? 0 : 0.45);
    page.textRight(bold ? 'F4' : 'F3', bold ? 10 : 9, R, y, value);
    y += 16;
  };
  label('NET TOTAL', fmtEur(invoice.net_cents));
  for (const row of invoice.vat_breakdown) {
    if (row.rate === 0) continue;
    label(`VAT ${row.rate}% OF ${fmtEur(row.base_cents)}`, fmtEur(row.vat_cents));
  }
  page.line(340, y - 4, R, 0.8, 0.2);
  y += 6;
  label('GROSS TOTAL', fmtEur(invoice.gross_cents), true);
  if (invoice.paid_cents > 0 && invoice.status !== 'cancelled') {
    label('PAID', fmtEur(-invoice.paid_cents));
    label('BALANCE DUE', fmtEur(invoice.open_cents), true);
  }

  // ── Notes / cancellation ──
  // Each in full, wrapped, and continued on a new page rather than run into
  // the footer: the exemption reason and the description of the supply are
  // mandatory content (§ 14 Abs. 4 Nr. 5 and 8 UStG), not decoration.
  const paragraph = (font: FontKey, size: number, text: string, gray: number): void => {
    for (const line of wrapText(font, size, text, R - M)) {
      if (y > BODY_END) {
        page = new Page();
        pages.push(page);
        y = 78;
      }
      page.text(font, size, M, y, line, gray);
      y += 12;
    }
    y += 4;
  };
  y += 12;
  if (partial) {
    paragraph('F2', 9, `Partial credit on invoice ${invoice.number} of ${invoice.issue_date}.`, 0.2);
    paragraph('F2', 9, `Reason: ${cancellation!.reason!}`, 0.2);
  } else if (cancellation) {
    paragraph('F2', 9, `Cancels invoice ${invoice.number} of ${invoice.issue_date} in full.`, 0.2);
  }
  if (invoice.status === 'cancelled' && invoice.cancellation_reason) {
    paragraph('F2', 9, `${cancellation ? 'Reason' : 'Cancelled'}: ${invoice.cancellation_reason}`, 0.2);
  }
  if (invoice.note) paragraph('F1', 8.5, invoice.note, 0.3);
  // Why the 0 % lines carry no VAT. Required on the document itself — e.g.
  // "Steuerschuldnerschaft des Leistungsempfängers" for reverse charge.
  if (invoice.tax_exemption_category && invoice.lines.some((l) => l.vat_rate === 0)) {
    const reason = invoice.tax_exemption_reason ?? EXEMPTION_DEFAULT_REASON[invoice.tax_exemption_category];
    if (reason) paragraph('F2', 8.5, reason, 0.2);
  }
  if (invoice.status !== 'cancelled' && !cancellation) {
    const due = invoice.due_date ?? '—';
    paragraph(
      'F1', 8.5,
      `Payment within ${invoice.payment_terms_days} days of the invoice date (due ${due}). ` +
        `Please reference ${invoice.number ?? 'the invoice'} with your transfer.`,
      0.3,
    );
  }

  // ── Footer ──
  // The seller by every identifier its e-invoice carries. VAT id or
  // Steuernummer is a mandatory field (§ 14 Abs. 4 Nr. 2 UStG); a seller with
  // only the Steuernummer used to get an empty "VAT" here while the XML named
  // it, so the plain PDF lacked it and the ZUGFeRD picture differed.
  const ids = [
    seller.vatId && `VAT ${seller.vatId}`,
    seller.taxNumber && `TAX NO ${seller.taxNumber}`,
    seller.registration,
    seller.identifier && `ID ${seller.identifier}`,
  ].filter((id) => typeof id === 'string' && id.trim() !== '');
  const footer = [seller.name, ids.join(' · '), [`IBAN ${seller.iban}`, ...(seller.bic ? [`BIC ${seller.bic}`] : [])].join(' · ')];
  const fy = A4.height - 64;
  page.line(M, fy - 14, R, 0.5, 0.6);
  footer.filter((line) => line !== '').forEach((line, i) => page.text('F3', 7, M, fy + i * 11, line, 0.45));
  page.textRight('F3', 7, R, fy, cancellation?.number ?? invoice.number ?? 'DRAFT', 0.45);

  return pages;
}
