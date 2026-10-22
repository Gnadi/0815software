/**
 * Minimal hand-rolled PDF writer — zero dependencies, fully offline.
 *
 * Scope is deliberately tiny: A4 pages, the built-in Type1 base fonts
 * (Helvetica for prose, Courier for tabular figures — fixed-width glyphs
 * make right-alignment exact without font metric tables), WinAnsi
 * encoding (covers Latin-1 plus the € sign at 0x80), text and hairline
 * ops, uncompressed content streams. That is everything an order
 * confirmation and a delivery note need, and the output is valid PDF 1.4
 * that every viewer opens. The writer is MOD-13's; the layouts are this
 * module's.
 */

import { fmtEur } from '../shared/money.js';
import type { DeliveryNote, OrderDetail } from '../shared/types.js';
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

// ── Layouts ─────────────────────────────────────────────────────────────

const M = 56; // page margin
const R = A4.width - M; // right edge

function fmtQty(quantity: number): string {
  return String(Math.round(quantity * 1000) / 1000).replace('.', ',');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function deDate(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
}

/** Letterhead, recipient block and the meta column; returns where the body starts. */
function head(page: Page, seller: SellerConfig, title: string, order: OrderDetail, meta: [string, string][]): number {
  page.text('F2', 26, M, 78, '0815');
  page.text('F3', 6.5, M, 92, `${seller.name.toUpperCase()} · STANDARD BUSINESS SOFTWARE`, 0.45);
  page.textRight('F4', 13, R, 78, title);
  page.line(M, 106, R, 0.8, 0.2);
  page.text('F1', 7, M, 122, [seller.name, ...seller.addressLines].join(' · '), 0.45);

  const y = 150;
  page.text('F2', 10, M, y + 16, order.customer.name);
  let addrY = y + 30;
  for (const line of order.customer.address_lines) {
    page.text('F1', 9, M, addrY, line, 0.25);
    addrY += 13;
  }
  if (order.customer.contact_person) {
    page.text('F1', 9, M, addrY, `z. H. ${order.customer.contact_person}`, 0.25);
    addrY += 13;
  }
  let metaY = y;
  for (const [label, value] of meta) {
    page.text('F4', 7, 356, metaY, label, 0.45);
    page.textRight('F3', 9, R, metaY, value);
    metaY += 16;
  }
  return Math.max(addrY, metaY) + 24;
}

function foot(page: Page, seller: SellerConfig, number: string): void {
  const fy = A4.height - 64;
  page.line(M, fy - 14, R, 0.5, 0.6);
  page.text('F3', 7, M, fy, `${seller.name} · UID ${seller.vatId}`, 0.45);
  page.textRight('F3', 7, R, fy, number, 0.45);
}

/** Auftragsbestätigung: what was ordered, at which prices. */
export function renderOrderPdf(order: OrderDetail, seller: SellerConfig): Buffer {
  const pages: Page[] = [];
  let page = new Page();
  pages.push(page);
  const meta: [string, string][] = [
    ['ORDER NO', order.number],
    ['ORDER DATE', deDate(order.order_date)],
  ];
  if (order.customer_reference) meta.push(['YOUR ORDER', truncate(order.customer_reference, 24)]);
  if (order.customer.vat_id) meta.push(['YOUR VAT ID', order.customer.vat_id]);
  let y = head(page, seller, order.status === 'cancelled' ? 'ORDER · CANCELLED' : 'ORDER CONFIRMATION', order, meta);

  const COL = { qty: 330, price: 420, disc: 460, vat: 490, net: R };
  const tableHead = (p: Page, at: number): number => {
    p.text('F4', 7, M, at, 'POS', 0.45);
    p.text('F4', 7, M + 30, at, 'DESCRIPTION', 0.45);
    p.textRight('F4', 7, COL.qty, at, 'QTY', 0.45);
    p.textRight('F4', 7, COL.price, at, 'UNIT', 0.45);
    p.textRight('F4', 7, COL.disc, at, 'DISC', 0.45);
    p.textRight('F4', 7, COL.vat, at, 'VAT', 0.45);
    p.textRight('F4', 7, COL.net, at, 'NET', 0.45);
    p.line(M, at + 6, R, 0.7, 0.3);
    return at + 22;
  };
  y = tableHead(page, y);
  for (const line of order.lines) {
    if (y > A4.height - 180) {
      page = new Page();
      pages.push(page);
      y = tableHead(page, 78);
    }
    page.text('F3', 9, M, y, String(line.position), 0.45);
    page.text('F1', 9, M + 30, y, truncate(line.description, 44));
    page.textRight('F3', 9, COL.qty, y, fmtQty(line.quantity));
    page.textRight('F3', 9, COL.price, y, fmtEur(line.unit_price_cents));
    page.textRight('F3', 9, COL.disc, y, line.discount_percent > 0 ? `${line.discount_percent}%` : '');
    page.textRight('F3', 9, COL.vat, y, `${line.vat_rate}%`);
    page.textRight('F3', 9, COL.net, y, fmtEur(line.net_cents));
    y += 16;
  }
  page.line(M, y - 6, R, 0.5, 0.6);
  y += 14;
  const total = (label: string, cents: number, bold = false): void => {
    page.text('F4', 7, 340, y, label, bold ? 0 : 0.45);
    page.textRight(bold ? 'F4' : 'F3', bold ? 10 : 9, R, y, fmtEur(cents));
    y += 16;
  };
  total('NET', order.totals.net_cents);
  total('VAT', order.totals.vat_cents);
  total('GROSS', order.totals.gross_cents, true);
  y += 12;
  if (order.status === 'cancelled' && order.cancel_reason) {
    page.text('F2', 9, M, y, `Cancelled: ${truncate(order.cancel_reason, 90)}`, 0.2);
    y += 16;
  }
  if (order.note) page.text('F1', 8.5, M, y, truncate(order.note, 100), 0.3);
  foot(page, seller, order.number);
  return buildPdf(pages);
}

/**
 * Lieferschein: what was delivered, for the recipient to check and sign. No
 * prices — it travels with the goods and is read by whoever unpacks them.
 */
export function renderDeliveryNotePdf(note: DeliveryNote, order: OrderDetail, seller: SellerConfig): Buffer {
  const pages: Page[] = [];
  let page = new Page();
  pages.push(page);
  const meta: [string, string][] = [
    ['DELIVERY NOTE', note.number],
    ['DELIVERED', deDate(note.delivered_on)],
    ['ORDER NO', order.number],
  ];
  if (order.customer_reference) meta.push(['YOUR ORDER', truncate(order.customer_reference, 24)]);
  let y = head(page, seller, 'DELIVERY NOTE', order, meta);

  const COL = { ordered: 420, qty: R };
  const tableHead = (p: Page, at: number): number => {
    p.text('F4', 7, M, at, 'POS', 0.45);
    p.text('F4', 7, M + 30, at, 'DESCRIPTION', 0.45);
    p.textRight('F4', 7, COL.ordered, at, 'ORDERED', 0.45);
    p.textRight('F4', 7, COL.qty, at, 'DELIVERED', 0.45);
    p.line(M, at + 6, R, 0.7, 0.3);
    return at + 22;
  };
  y = tableHead(page, y);
  for (const line of note.lines) {
    if (y > A4.height - 200) {
      page = new Page();
      pages.push(page);
      y = tableHead(page, 78);
    }
    const ordered = order.lines.find((l) => l.id === line.order_line_id);
    page.text('F3', 9, M, y, String(line.position), 0.45);
    page.text('F1', 9, M + 30, y, truncate(line.description, 52));
    page.textRight('F3', 9, COL.ordered, y, ordered ? fmtQty(ordered.quantity) : '');
    page.textRight('F4', 9, COL.qty, y, fmtQty(line.quantity));
    y += 16;
  }
  page.line(M, y - 6, R, 0.5, 0.6);
  y += 18;
  if (note.note) {
    page.text('F1', 8.5, M, y, truncate(note.note, 100), 0.3);
    y += 18;
  }
  y += 30;
  page.line(M, y, M + 200, 0.5, 0.4);
  page.line(R - 200, y, R, 0.5, 0.4);
  page.text('F1', 7, M, y + 12, 'Date, signature recipient', 0.45);
  page.text('F1', 7, R - 200, y + 12, 'Goods received in good order', 0.45);
  foot(page, seller, note.number);
  return buildPdf(pages);
}
