import { inflateSync, constants } from 'node:zlib';

/**
 * What can be read out of a PDF without a PDF library: the streams, an
 * embedded e-invoice (ZUGFeRD / Factur-X carry the XML as an associated
 * file), and the text layer of a PDF that was *generated* — the invoice a
 * supplier's software printed, not one somebody scanned.
 *
 * The text layer is read from the content streams' show-text operators
 * (`Tj`, `TJ`, `'`, `"`) in literal-string form, which is what single-byte
 * fonts (WinAnsi, the standard 14) produce. Composite fonts write glyph ids
 * in hex strings that mean nothing without the font's ToUnicode map; those
 * are left out rather than guessed, and a PDF that yields no text is handed
 * to a vision model or refused — never filled with invented values.
 */

export interface PdfStream {
  dict: string;
  data: Buffer;
}

/** Every stream in the file, inflated where it is Flate-encoded. */
export function pdfStreams(pdf: Buffer): PdfStream[] {
  const latin = pdf.toString('latin1');
  const out: PdfStream[] = [];
  const keyword = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = keyword.exec(latin))) {
    // `endstream` also ends in "stream" — skip it.
    if (latin.slice(Math.max(0, m.index - 3), m.index) === 'end') continue;
    const objStart = latin.lastIndexOf(' obj', m.index);
    if (objStart === -1) continue;
    const dict = latin.slice(objStart + 4, m.index);
    const start = m.index + m[0].length;
    const end = latin.indexOf('endstream', start);
    if (end === -1) break;
    let raw = pdf.subarray(start, end);
    // The EOL before `endstream` is not part of the data.
    if (raw.at(-1) === 0x0a) raw = raw.subarray(0, -1);
    if (raw.at(-1) === 0x0d) raw = raw.subarray(0, -1);
    let data: Buffer = raw;
    if (/\/FlateDecode/.test(dict)) {
      try {
        data = inflateSync(raw, { finishFlush: constants.Z_SYNC_FLUSH });
      } catch {
        keyword.lastIndex = end;
        continue; // a stream we cannot inflate is one we cannot read
      }
    } else if (/\/Filter/.test(dict)) {
      keyword.lastIndex = end;
      continue; // DCT (a JPEG), CCITT …: pixels, not text
    }
    out.push({ dict, data });
    keyword.lastIndex = end;
  }
  return out;
}

/** The XML of an embedded e-invoice, if the PDF carries one. */
export function embeddedInvoiceXml(streams: PdfStream[]): string | null {
  for (const s of streams) {
    if (!/\/Type\s*\/EmbeddedFile/.test(s.dict)) continue;
    const xml = s.data.toString('utf8');
    if (/CrossIndustryInvoice|urn:oasis:names:specification:ubl|ebinterface/.test(xml.slice(0, 4000))) return xml;
  }
  return null;
}

function readLiteral(src: string, at: number): { value: string; end: number } {
  // `at` points just past the opening parenthesis.
  let depth = 1;
  let out = '';
  let i = at;
  for (; i < src.length && depth > 0; i++) {
    const c = src[i]!;
    if (c === '\\') {
      const n = src[++i]!;
      if (n === 'n') out += '\n';
      else if (n === 'r') out += '\r';
      else if (n === 't') out += '\t';
      else if (n === 'b' || n === 'f') out += '';
      else if (/[0-7]/.test(n)) {
        let oct = n;
        while (oct.length < 3 && /[0-7]/.test(src[i + 1] ?? '')) oct += src[++i];
        out += String.fromCharCode(parseInt(oct, 8));
      } else if (n === '\r' || n === '\n') {
        if (n === '\r' && src[i + 1] === '\n') i++;
      } else out += n;
    } else if (c === '(') {
      depth++;
      out += c;
    } else if (c === ')') {
      depth--;
      if (depth > 0) out += c;
    } else out += c;
  }
  return { value: out, end: i };
}

/** WinAnsi bytes that differ from Latin-1 — the ones invoices actually use. */
const WIN_ANSI: Record<number, string> = { 0x80: '€', 0x84: '„', 0x93: '“', 0x94: '”', 0x96: '–', 0x97: '—', 0x91: '‘', 0x92: '’', 0x85: '…' };
const winAnsi = (s: string) => s.replace(/[\x80-\x9f]/g, (c) => WIN_ANSI[c.charCodeAt(0)] ?? '');

interface Fragment {
  x: number;
  y: number;
  text: string;
}

/**
 * The text fragments one content stream shows, with where each starts.
 * Position matters more than order: a generated invoice draws a label and
 * its amount as two separate strings on one baseline, often far apart and
 * in any order, and only the shared baseline says they belong together.
 */
function streamFragments(content: string): Fragment[] {
  const out: Fragment[] = [];
  let operands: number[] = [];
  let strings: string[] = [];
  let lineX = 0;
  let lineY = 0;
  let leading = 0;
  let i = 0;
  const moveTo = (x: number, y: number) => {
    lineX = x;
    lineY = y;
  };
  const show = () => {
    const text = strings.join('');
    if (text.trim() !== '') out.push({ x: lineX, y: lineY, text });
  };
  while (i < content.length) {
    const c = content[i]!;
    if (c === '(') {
      const lit = readLiteral(content, i + 1);
      strings.push(winAnsi(lit.value));
      i = lit.end;
      continue;
    }
    if (c === '%') {
      const nl = content.indexOf('\n', i);
      i = nl === -1 ? content.length : nl + 1;
      continue;
    }
    if (c === '<' && content[i + 1] !== '<') {
      // A hex string: glyph ids of a composite font, unreadable without its map.
      const close = content.indexOf('>', i);
      i = close === -1 ? content.length : close + 1;
      continue;
    }
    if (c === '/') {
      const name = /^\/[^\s/\[\]()<>{}%]*/.exec(content.slice(i))![0];
      i += name.length;
      continue;
    }
    const num = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(content.slice(i, i + 24));
    if (num) {
      operands.push(Number(num[0]));
      i += num[0].length;
      continue;
    }
    if (/[A-Za-z'"*]/.test(c)) {
      const op = /^[A-Za-z'"*]+/.exec(content.slice(i, i + 4))![0];
      const [a, b] = operands.slice(-2) as [number, number];
      if (op === 'BT') moveTo(0, 0);
      else if (op === 'Td') moveTo(lineX + (a ?? 0), lineY + (b ?? 0));
      else if (op === 'TD') {
        leading = -(b ?? 0);
        moveTo(lineX + (a ?? 0), lineY + (b ?? 0));
      } else if (op === 'TL') leading = operands.at(-1) ?? 0;
      else if (op === 'Tm') moveTo(operands.at(-2) ?? 0, operands.at(-1) ?? 0);
      else if (op === 'T*') moveTo(lineX, lineY - (leading || 12));
      else if (op === 'Tj' || op === 'TJ') show();
      else if (op === "'" || op === '"') {
        moveTo(lineX, lineY - (leading || 12));
        show();
      }
      operands = [];
      strings = [];
      i += op.length;
      continue;
    }
    i++;
  }
  return out;
}

/** Fragments sharing a baseline become one line, left to right, top to bottom. */
function linesOf(fragments: Fragment[]): string {
  const rows = new Map<number, Fragment[]>();
  for (const f of fragments) {
    const key = [...rows.keys()].find((y) => Math.abs(y - f.y) < 2) ?? f.y;
    rows.set(key, [...(rows.get(key) ?? []), f]);
  }
  return [...rows.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, row]) =>
      row
        .sort((p, q) => p.x - q.x)
        .map((f) => f.text.trim())
        .join('  '),
    )
    .join('\n');
}

/** The PDF's text layer, best effort; empty when it has none we can read. */
export function pdfText(streams: PdfStream[]): string {
  return streams
    .filter((s) => !/\/Type\s*\/(EmbeddedFile|XObject|Metadata|XRef|ObjStm|FontFile)/.test(s.dict) && !/\/(Length1|Subtype\s*\/Image)/.test(s.dict))
    .map((s) => s.data.toString('latin1'))
    .filter((c) => /\bBT\b/.test(c))
    .map((c) => linesOf(streamFragments(c)))
    .filter((t) => t !== '')
    .join('\n');
}

export const isPdf = (data: Buffer) => data.subarray(0, 5).toString('latin1') === '%PDF-';
