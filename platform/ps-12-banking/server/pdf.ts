/**
 * Minimal hand-rolled PDF writer — zero dependencies, fully offline.
 *
 * The generic half of `modules/mod-04-invoice-billing/server/pdf.ts`, copied
 * rather than shared: the catalogue's rule is that a module and a service never
 * import each other's code, and a hundred lines of PDF primitives is a smaller
 * price than a dependency between two deployable units.
 *
 * Scope is deliberately tiny: A4 pages, the built-in Type1 base fonts
 * (Helvetica for prose, Courier for anything that has to line up — fixed-width
 * glyphs make alignment exact without font metric tables), WinAnsi encoding,
 * text and hairline ops, uncompressed content streams. That is everything the
 * INI letter needs, and the output is valid PDF 1.4 that every viewer opens.
 */

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
