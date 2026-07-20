/**
 * Minimal hand-rolled PDF writer — zero dependencies, fully offline.
 *
 * Scope is deliberately tiny: A4 pages, the built-in Type1 base fonts
 * (Helvetica for prose, Courier for tabular figures — fixed-width glyphs
 * make right-alignment exact without font metric tables), WinAnsi
 * encoding (covers Latin-1 plus the € sign at 0x80), text and hairline
 * ops, uncompressed content streams. That is everything an offer needs,
 * and the output is valid PDF 1.4 that every viewer opens.
 */

import { fmtEur } from '../shared/money.js';
import type { Customer, OfferDetail } from '../shared/types.js';
import type { SellerConfig } from './config.js';

export const A4 = { width: 595.28, height: 841.89 };

const FONTS = {
  F1: 'Helvetica',
  F2: 'Helvetica-Bold',
  F3: 'Courier',
  F4: 'Courier-Bold',
} as const;
type FontKey = keyof typeof FONTS;

/** Courier glyph width: 600/1000 em — exact, per the AFM spec. */
const COURIER_EM = 0.6;

/** Map a JS string to escaped WinAnsi bytes for a PDF string literal. */
function winAnsi(text: string): string {
  const HIGH: Record<string, number> = {
    '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85,
    '†': 0x86, '‡': 0x87, '‰': 0x89, '‹': 0x8b,
    '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94,
    '•': 0x95, '–': 0x96, '—': 0x97, '›': 0x9b,
    '−': 0x2d, // minus sign → hyphen
  };
  let out = '';
  for (const ch of text) {
    let code = ch.codePointAt(0)!;
    if (code > 0xff) code = HIGH[ch] ?? 0x3f; // '?'
    if (code === 0x5c) out += '\\\\';
    else if (code === 0x28) out += '\\(';
    else if (code === 0x29) out += '\\)';
    else if (code >= 0x20 && code < 0x7f) out += String.fromCharCode(code);
    else out += `\\${code.toString(8).padStart(3, '0')}`;
  }
  return out;
}

const n = (value: number): string => String(Math.round(value * 100) / 100);

/** One page of drawing ops. y runs DOWN from the top edge (like CSS). */
export class Page {
  private ops: string[] = [];

  /** Left-aligned text. `gray` 0 = black … 1 = white. */
  text(font: FontKey, size: number, x: number, y: number, value: string, gray = 0): void {
    this.ops.push(
      `${n(gray)} g BT /${font} ${n(size)} Tf ${n(x)} ${n(A4.height - y)} Td (${winAnsi(value)}) Tj ET`,
    );
  }

  /** Right-aligned text — Courier fonts only (fixed glyph width). */
  textRight(font: 'F3' | 'F4', size: number, xRight: number, y: number, value: string, gray = 0): void {
    this.text(font, size, xRight - value.length * COURIER_EM * size, y, value, gray);
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

// ── Offer layout ───────────────────────────────────────────────────────

const M = 56; // page margin
const R = A4.width - M; // right edge
const COL = { qty: 320, disc: 372, price: 452, vat: 486, net: R }; // right edges of number columns

function fmtQty(quantity: number): string {
  return String(Math.round(quantity * 1000) / 1000);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Wrap a paragraph to a rough character budget per line. */
function wrap(text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current === '') current = word;
    else if ((current + ' ' + word).length <= max) current += ' ' + word;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function tableHead(page: Page, y: number): number {
  page.text('F4', 7, M, y, 'POS', 0.45);
  page.text('F4', 7, M + 26, y, 'DESCRIPTION', 0.45);
  page.textRight('F4', 7, COL.qty, y, 'QTY', 0.45);
  page.textRight('F4', 7, COL.disc, y, 'DISC', 0.45);
  page.textRight('F4', 7, COL.price, y, 'UNIT', 0.45);
  page.textRight('F4', 7, COL.vat, y, 'VAT', 0.45);
  page.textRight('F4', 7, COL.net, y, 'NET', 0.45);
  page.line(M, y + 6, R, 0.7, 0.3);
  return y + 22;
}

/** Render an offer as a letterhead-style PDF. */
export function renderOfferPdf(offer: OfferDetail, customer: Customer, seller: SellerConfig): Buffer {
  const pages: Page[] = [];
  let page = new Page();
  pages.push(page);

  const heading =
    offer.status === 'accepted'
      ? 'OFFER — ACCEPTED'
      : offer.status === 'rejected'
        ? 'OFFER — DECLINED'
        : offer.status === 'withdrawn'
          ? 'OFFER — WITHDRAWN'
          : offer.status === 'superseded'
            ? 'OFFER — SUPERSEDED'
            : offer.status === 'expired'
              ? 'OFFER — EXPIRED'
              : 'OFFER';

  // ── Letterhead ──
  page.text('F2', 26, M, 78, '0815');
  page.text('F3', 6.5, M, 92, `${seller.name.toUpperCase()} · STANDARD BUSINESS SOFTWARE`, 0.45);
  page.textRight('F4', 13, R, 78, heading);
  page.line(M, 106, R, 0.8, 0.2);

  const sellerLine = [seller.name, ...seller.addressLines].join(' · ');
  page.text('F1', 7, M, 122, sellerLine, 0.45);

  // ── Bill-to / meta ──
  let y = 150;
  page.text('F4', 7, M, y, 'PREPARED FOR', 0.45);
  page.text('F2', 10, M, y + 16, customer.name);
  let addrY = y + 30;
  if (customer.contact_person) {
    page.text('F1', 9, M, addrY, `Attn: ${customer.contact_person}`, 0.25);
    addrY += 13;
  }
  for (const line of customer.address?.split('\n') ?? []) {
    page.text('F1', 9, M, addrY, line, 0.25);
    addrY += 13;
  }
  if (customer.vat_id) {
    page.text('F3', 8, M, addrY + 2, `VAT ${customer.vat_id}`, 0.45);
    addrY += 15;
  }

  const metaX = 340;
  const meta: [string, string][] = [
    ['OFFER NO', offer.number ?? 'DRAFT'],
    ['ISSUED', offer.sent_at?.slice(0, 10) ?? '—'],
    ['VALID UNTIL', offer.valid_until ?? '—'],
  ];
  if (offer.supersedes_number) meta.push(['REVISION OF', offer.supersedes_number]);
  if (offer.superseded_by_number) meta.push(['SUPERSEDED BY', offer.superseded_by_number]);
  let metaY = y;
  for (const [label, value] of meta) {
    page.text('F4', 7, metaX, metaY, label, 0.45);
    page.textRight('F3', 9, R, metaY, value);
    metaY += 16;
  }

  y = Math.max(addrY, metaY) + 22;

  // ── Title ──
  page.text('F2', 13, M, y, truncate(offer.title, 60));
  y += 20;

  if (offer.number === null) {
    page.text('F2', 10, M, y, 'DRAFT — NOT YET SENT', 0.3);
    y += 18;
  }

  // ── Intro text ──
  if (offer.intro) {
    for (const line of wrap(offer.intro, 96)) {
      page.text('F1', 9, M, y, line, 0.25);
      y += 13;
    }
    y += 8;
  }

  // ── Line items ──
  y = tableHead(page, y);
  for (const line of offer.lines) {
    if (y > A4.height - 220) {
      page = new Page();
      pages.push(page);
      y = tableHead(page, 78);
    }
    page.text('F3', 9, M, y, String(line.position), 0.45);
    page.text('F1', 9, M + 26, y, truncate(line.description, 40));
    page.textRight('F3', 9, COL.qty, y, fmtQty(line.quantity));
    page.textRight('F3', 9, COL.disc, y, line.discount_percent > 0 ? `${fmtQty(line.discount_percent)}%` : '—');
    page.textRight('F3', 9, COL.price, y, fmtEur(line.unit_price_cents));
    page.textRight('F3', 9, COL.vat, y, `${line.vat_rate}%`);
    page.textRight('F3', 9, COL.net, y, fmtEur(line.net_cents));
    y += 16;
  }
  page.line(M, y - 6, R, 0.5, 0.6);

  // ── Totals / VAT summary ──
  if (y > A4.height - 240) {
    page = new Page();
    pages.push(page);
    y = 78;
  }
  y += 14;
  const label = (text: string, value: string, bold = false): void => {
    page.text('F4', 7, 330, y, text, bold ? 0 : 0.45);
    page.textRight(bold ? 'F4' : 'F3', bold ? 10 : 9, R, y, value);
    y += 16;
  };
  if (offer.discount_cents > 0) {
    label('SUBTOTAL', fmtEur(offer.net_cents + offer.discount_cents));
    label('LINE DISCOUNTS', fmtEur(-offer.discount_cents));
  }
  label('NET TOTAL', fmtEur(offer.net_cents));
  for (const row of offer.vat_breakdown) {
    if (row.rate === 0) continue;
    label(`VAT ${row.rate}% OF ${fmtEur(row.base_cents)}`, fmtEur(row.vat_cents));
  }
  page.line(330, y - 4, R, 0.8, 0.2);
  y += 6;
  label('GROSS TOTAL', fmtEur(offer.gross_cents), true);

  // ── Terms ──
  y += 12;
  if (offer.terms) {
    page.text('F4', 7, M, y, 'TERMS', 0.45);
    y += 14;
    for (const line of wrap(offer.terms, 100)) {
      page.text('F1', 8.5, M, y, line, 0.3);
      y += 12;
    }
    y += 6;
  }
  if (offer.status === 'sent' || offer.status === 'expired') {
    page.text(
      'F1', 8.5, M, y,
      `This offer is valid until ${offer.valid_until}. To accept it, use the acceptance link we sent you.`,
      0.3,
    );
  }

  // ── Footer ──
  const fy = A4.height - 64;
  page.line(M, fy - 14, R, 0.5, 0.6);
  page.text('F3', 7, M, fy, `${seller.name} · VAT ${seller.vatId}`, 0.45);
  page.text('F3', 7, M, fy + 11, seller.email, 0.45);
  page.textRight('F3', 7, R, fy, offer.number ?? 'DRAFT', 0.45);

  return buildPdf(pages);
}
