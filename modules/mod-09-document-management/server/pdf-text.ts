import { constants, inflateRawSync, inflateSync } from 'node:zlib';

/**
 * The text layer of a PDF, read without a PDF library.
 *
 * A PDF draws text as glyph codes in a font; which characters those codes
 * mean is the font's business. Office suites and browsers embed subset fonts
 * whose codes are arbitrary two-byte glyph ids, so reading the raw bytes as
 * Latin-1 — what a naive reader does — yields noise. This reader follows the
 * file the way a viewer's "copy text" does:
 *
 *   objects (top-level and inside object streams) → catalog → page tree →
 *   each page's content streams and resources → each font's /ToUnicode CMap
 *   (or, for simple fonts without one, its encoding and /Differences) →
 *   the show-text operators (Tj, TJ, ', ") with line breaks from the
 *   positioning operators (Td, TD, T*, Tm) — and Form XObjects recursively.
 *
 * What it does not do, by design: OCR (a scan has no text layer — the caller
 * says so instead of guessing), decryption (an encrypted file is reported as
 * such), and layout analysis beyond lines and word gaps.
 */

export type PdfTextStatus = 'text' | 'empty' | 'encrypted' | 'unreadable';

export interface PdfTextResult {
  status: PdfTextStatus;
  text: string;
}

// ── Values ────────────────────────────────────────────────────────────

interface Ref {
  ref: number;
}
interface Op {
  op: string;
}
type Val = number | boolean | null | string | Buffer | Ref | Val[] | Map<string, Val> | Op;

const isRef = (v: unknown): v is Ref => typeof v === 'object' && v !== null && 'ref' in v;
const isOp = (v: unknown): v is Op => typeof v === 'object' && v !== null && 'op' in v;
const isDict = (v: unknown): v is Map<string, Val> => v instanceof Map;

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

/** A lexer over latin1 text: one char per byte, so strings stay bytes. */
class Lexer {
  pos = 0;
  constructor(readonly s: string) {}

  private skip(): void {
    const s = this.s;
    while (this.pos < s.length) {
      const c = s.charCodeAt(this.pos);
      if (WS.has(c)) this.pos++;
      else if (c === 0x25) {
        while (this.pos < s.length && s[this.pos] !== '\n' && s[this.pos] !== '\r') this.pos++;
      } else break;
    }
  }

  /** The next value or operator; undefined at the end; `]`/`>>` as ops. */
  next(): Val | undefined {
    this.skip();
    const s = this.s;
    if (this.pos >= s.length) return undefined;
    const c = s[this.pos]!;
    if (c === '<' && s[this.pos + 1] === '<') {
      this.pos += 2;
      const dict = new Map<string, Val>();
      for (;;) {
        const key = this.next();
        if (key === undefined || (isOp(key) && key.op === '>>')) break;
        if (typeof key !== 'string' || !key.startsWith('/')) continue;
        const value = this.next();
        if (value === undefined || (isOp(value) && value.op === '>>')) break;
        dict.set(key.slice(1), value);
      }
      return dict;
    }
    if (c === '>' && s[this.pos + 1] === '>') {
      this.pos += 2;
      return { op: '>>' };
    }
    if (c === '<') {
      const end = s.indexOf('>', this.pos);
      const hex = s.slice(this.pos + 1, end === -1 ? s.length : end).replace(/[^0-9a-fA-F]/g, '');
      this.pos = end === -1 ? s.length : end + 1;
      return Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
    }
    if (c === '(') return this.literal();
    if (c === '[') {
      this.pos++;
      const arr: Val[] = [];
      for (;;) {
        const v = this.next();
        if (v === undefined || (isOp(v) && v.op === ']')) break;
        arr.push(v);
      }
      return arr;
    }
    if (c === ']' || c === ')' || c === '>' || c === '{' || c === '}') {
      this.pos++;
      return { op: c };
    }
    if (c === '/') {
      let end = this.pos + 1;
      while (end < s.length && !WS.has(s.charCodeAt(end)) && !DELIM.has(s[end]!)) end++;
      const name = s.slice(this.pos, end).replace(/#([0-9a-fA-F]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
      this.pos = end;
      return name;
    }
    let end = this.pos;
    while (end < s.length && !WS.has(s.charCodeAt(end)) && !DELIM.has(s[end]!)) end++;
    if (end === this.pos) end++;
    const word = s.slice(this.pos, end);
    this.pos = end;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
      // `12 0 R` is a reference, not two numbers and an operator.
      if (/^\d+$/.test(word)) {
        const m = /^\s+(\d+)\s+R(?=[\s/<>[\]()%]|$)/.exec(s.slice(this.pos, this.pos + 24));
        if (m) {
          this.pos += m[0].length;
          return { ref: Number(word) };
        }
      }
      return Number(word);
    }
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    return { op: word };
  }

  private literal(): Buffer {
    const s = this.s;
    const out: number[] = [];
    let depth = 1;
    this.pos++;
    while (this.pos < s.length) {
      const c = s[this.pos++]!;
      if (c === '\\') {
        const e = s[this.pos++] ?? '';
        const simple: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
        if (e in simple) out.push(simple[e]!);
        else if (/[0-7]/.test(e)) {
          let oct = e;
          while (oct.length < 3 && /[0-7]/.test(s[this.pos] ?? '')) oct += s[this.pos++];
          out.push(parseInt(oct, 8) & 0xff);
        } else if (e === '\r') {
          if (s[this.pos] === '\n') this.pos++;
        } else if (e !== '\n') out.push(e.charCodeAt(0));
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
      out.push(c.charCodeAt(0));
    }
    return Buffer.from(out);
  }

  /** Skip an inline image's binary data: everything up to `EI`. */
  skipInlineImage(): void {
    const m = /\sEI(?=[\s]|$)/g;
    m.lastIndex = this.pos;
    const hit = m.exec(this.s);
    this.pos = hit ? hit.index + hit[0].length : this.s.length;
  }
}

function parseValue(text: string): Val | undefined {
  return new Lexer(text).next();
}

// ── Objects ───────────────────────────────────────────────────────────

interface PdfObject {
  value: Val | undefined;
  stream: Buffer | null;
}

class PdfFile {
  readonly objects = new Map<number, PdfObject>();
  trailer: Map<string, Val> | null = null;

  constructor(pdf: Buffer) {
    const latin = pdf.toString('latin1');
    const objStart = /(\d+)\s+\d+\s+obj\b/g;
    let m: RegExpExecArray | null;
    while ((m = objStart.exec(latin))) {
      const num = Number(m[1]);
      const bodyStart = m.index + m[0].length;
      const endobj = latin.indexOf('endobj', bodyStart);
      const streamAt = latin.indexOf('stream', bodyStart);
      if (streamAt !== -1 && (endobj === -1 || streamAt < endobj) && latin.slice(streamAt - 3, streamAt) !== 'end') {
        const value = parseValue(latin.slice(bodyStart, streamAt));
        let dataStart = streamAt + 6;
        if (latin[dataStart] === '\r') dataStart++;
        if (latin[dataStart] === '\n') dataStart++;
        const length = isDict(value) ? value.get('Length') : undefined;
        let dataEnd = -1;
        if (typeof length === 'number' && dataStart + length <= pdf.length && /^\s*endstream/.test(latin.slice(dataStart + length, dataStart + length + 20))) {
          dataEnd = dataStart + length;
        } else {
          const es = latin.indexOf('endstream', dataStart);
          if (es === -1) break;
          dataEnd = es;
          if (latin[dataEnd - 1] === '\n') dataEnd--;
          if (latin[dataEnd - 1] === '\r') dataEnd--;
        }
        // A later definition (an incremental update) replaces an earlier one.
        this.objects.set(num, { value, stream: pdf.subarray(dataStart, dataEnd) });
        const after = latin.indexOf('endobj', dataEnd);
        objStart.lastIndex = after === -1 ? dataEnd : after + 6;
      } else {
        if (endobj === -1) break;
        this.objects.set(num, { value: parseValue(latin.slice(bodyStart, endobj)), stream: null });
        objStart.lastIndex = endobj + 6;
      }
    }

    // Objects compressed into object streams (PDF 1.5+): where modern
    // writers put fonts and page dictionaries.
    for (const obj of [...this.objects.values()]) {
      if (!isDict(obj.value) || obj.value.get('Type') !== '/ObjStm') continue;
      const data = this.decode(obj);
      const n = obj.value.get('N');
      const first = obj.value.get('First');
      if (!data || typeof n !== 'number' || typeof first !== 'number') continue;
      const header = data.subarray(0, first).toString('latin1').trim().split(/\s+/).map(Number);
      for (let i = 0; i < n; i++) {
        const num = header[2 * i];
        const off = header[2 * i + 1];
        if (num === undefined || off === undefined || this.objects.has(num)) continue;
        const end = i + 1 < n ? header[2 * i + 3]! : data.length - first;
        this.objects.set(num, { value: parseValue(data.subarray(first + off, first + end).toString('latin1')), stream: null });
      }
    }

    // The trailer: the last classic `trailer` dictionary, or the dictionary of
    // a cross-reference stream.
    const at = latin.lastIndexOf('trailer');
    if (at !== -1) {
      const v = parseValue(latin.slice(at + 7));
      if (isDict(v)) this.trailer = v;
    }
    if (!this.trailer?.has('Root')) {
      for (const obj of this.objects.values()) {
        if (isDict(obj.value) && obj.value.get('Type') === '/XRef' && obj.value.has('Root')) this.trailer = obj.value;
      }
    }
  }

  get(v: Val | undefined, depth = 0): Val | undefined {
    if (isRef(v) && depth < 32) return this.get(this.objects.get(v.ref)?.value, depth + 1);
    return v;
  }

  dict(v: Val | undefined): Map<string, Val> | null {
    const d = this.get(v);
    return isDict(d) ? d : null;
  }

  streamOf(v: Val | undefined): Buffer | null {
    const obj = isRef(v) ? this.objects.get(v.ref) : undefined;
    return obj ? this.decode(obj) : null;
  }

  decode(obj: PdfObject): Buffer | null {
    if (!obj.stream || !isDict(obj.value)) return obj.stream;
    const raw = this.get(obj.value.get('Filter'));
    const filters = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map((f) => this.get(f));
    let data: Buffer = obj.stream;
    for (const f of filters) {
      if (f === '/FlateDecode' || f === '/Fl') {
        try {
          data = inflateSync(data, { finishFlush: constants.Z_SYNC_FLUSH });
        } catch {
          try {
            data = inflateRawSync(data, { finishFlush: constants.Z_SYNC_FLUSH });
          } catch {
            return null;
          }
        }
      } else if (f === '/ASCIIHexDecode' || f === '/AHx') {
        const hex = data.toString('latin1').replace(/>.*$/s, '').replace(/[^0-9a-fA-F]/g, '');
        data = Buffer.from(hex.length % 2 ? `${hex}0` : hex, 'hex');
      } else if (f === '/ASCII85Decode' || f === '/A85') {
        data = ascii85(data);
      } else {
        return null; // DCT, JBIG2, CCITT …: pixels, not text
      }
    }
    return data;
  }
}

function ascii85(data: Buffer): Buffer {
  const s = data.toString('latin1').replace(/\s/g, '').replace(/^<~/, '').replace(/~>.*$/s, '');
  const out: number[] = [];
  let group: number[] = [];
  for (const ch of s) {
    if (ch === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let n = 0;
      for (const d of group) n = n * 85 + d;
      out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
      group = [];
    }
  }
  if (group.length > 1) {
    const len = group.length;
    while (group.length < 5) group.push(84);
    let n = 0;
    for (const d of group) n = n * 85 + d;
    const bytes = [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
    out.push(...bytes.slice(0, len - 1));
  }
  return Buffer.from(out);
}

// ── Fonts ─────────────────────────────────────────────────────────────

interface Font {
  /** Byte lengths of the codes this font uses, longest first. */
  lengths: number[];
  map: Map<number, string>;
  /** For simple fonts without a ToUnicode map: decode the byte itself. */
  fallback: ((code: number) => string) | null;
  /** Glyph advance in thousandths of the font size — where the next glyph starts. */
  width: (code: number) => number;
}

const defaultWidth = (): number => 500;

/** /Widths of a simple font, or /W of a composite font's descendant. */
function widthsOf(file: PdfFile, dict: Map<string, Val>): (code: number) => number {
  if (dict.get('Subtype') === '/Type0') {
    const descendants = file.get(dict.get('DescendantFonts'));
    const cid = file.dict(Array.isArray(descendants) ? descendants[0] : undefined);
    if (!cid) return () => 1000;
    const dw = file.get(cid.get('DW'));
    const fallback = typeof dw === 'number' ? dw : 1000;
    const table = new Map<number, number>();
    const w = file.get(cid.get('W'));
    if (Array.isArray(w)) {
      // [c [w1 w2 …]] gives consecutive codes; [cFirst cLast w] a run of one width.
      for (let i = 0; i < w.length && table.size < 70000; ) {
        const first = file.get(w[i]);
        const next = file.get(w[i + 1]);
        if (typeof first !== 'number') break;
        if (Array.isArray(next)) {
          next.forEach((v, k) => {
            const n = file.get(v);
            if (typeof n === 'number') table.set(first + k, n);
          });
          i += 2;
        } else {
          const last = next;
          const width = file.get(w[i + 2]);
          if (typeof last !== 'number' || typeof width !== 'number') break;
          for (let c = first; c <= last && c - first < 70000; c++) table.set(c, width);
          i += 3;
        }
      }
    }
    return (code) => table.get(code) ?? fallback;
  }
  const first = file.get(dict.get('FirstChar'));
  const widths = file.get(dict.get('Widths'));
  if (typeof first === 'number' && Array.isArray(widths)) {
    return (code) => {
      const v = file.get(widths[code - first]);
      return typeof v === 'number' ? v : 500;
    };
  }
  return defaultWidth;
}

// Windows-1252 differs from Latin-1 only in 0x80–0x9F (€, „, “, –, …). Node's
// TextDecoder decodes the label as plain Latin-1 there, so the table is ours.
const CP1252_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ';

/** One Windows-1252 byte as text (control characters dropped). */
export function cp1252Char(code: number): string {
  if (code < 0x20 || code === 0x7f) return '';
  if (code >= 0x80 && code <= 0x9f) return /[\u0080-\u009f]/.test(CP1252_HIGH[code - 0x80]!) ? '' : CP1252_HIGH[code - 0x80]!;
  return String.fromCharCode(code);
}

export function decodeCp1252(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b === 0x0a || b === 0x0d || b === 0x09 ? String.fromCharCode(b) : cp1252Char(b);
  return out;
}

const cp1252 = cp1252Char;

/** Adobe glyph names for the characters German and English text uses. */
const GLYPHS: Record<string, string> = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&',
  quotesingle: "'", quoteright: '’', quoteleft: '‘', parenleft: '(', parenright: ')', asterisk: '*', plus: '+',
  comma: ',', hyphen: '-', minus: '−', period: '.', slash: '/', colon: ':', semicolon: ';', less: '<',
  equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[', backslash: '\\', bracketright: ']',
  underscore: '_', braceleft: '{', bar: '|', braceright: '}', endash: '–', emdash: '—', bullet: '•',
  quotedblleft: '“', quotedblright: '”', quotedblbase: '„', quotesinglbase: '‚', ellipsis: '…', section: '§',
  degree: '°', Euro: '€', euro: '€', adieresis: 'ä', odieresis: 'ö', udieresis: 'ü', Adieresis: 'Ä',
  Odieresis: 'Ö', Udieresis: 'Ü', germandbls: 'ß', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á',
  ccedilla: 'ç', fi: 'fi', fl: 'fl', zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9',
};

function glyphChar(name: string): string | null {
  if (name in GLYPHS) return GLYPHS[name]!;
  if (/^[A-Za-z]$/.test(name)) return name;
  const uni = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (uni) return String.fromCharCode(parseInt(uni[1]!, 16));
  return null;
}

function utf16be(buf: Buffer): string {
  let s = '';
  for (let i = 0; i + 1 < buf.length; i += 2) s += String.fromCharCode(buf.readUInt16BE(i));
  return s;
}

const codeOf = (buf: Buffer): number => buf.reduce((n, b) => n * 256 + b, 0);

/** A ToUnicode CMap: the code space and the code → text mappings. */
function parseCMap(text: string): Pick<Font, 'lengths' | 'map'> {
  const lengths = new Set<number>();
  const map = new Map<number, string>();
  for (const block of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) {
    for (const lo of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<[0-9a-fA-F]+>/g)) lengths.add(Math.ceil(lo[1]!.length / 2));
  }
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) {
      const src = Buffer.from(pair[1]!, 'hex');
      lengths.add(src.length);
      map.set(codeOf(src), utf16be(Buffer.from(pair[2]!, 'hex')));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const r of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]*>|\[[^\]]*\])/g)) {
      const lo = Buffer.from(r[1]!, 'hex');
      const from = codeOf(lo);
      const to = codeOf(Buffer.from(r[2]!, 'hex'));
      lengths.add(lo.length);
      if (to < from || to - from > 0xffff) continue;
      const dst = r[3]!;
      if (dst.startsWith('[')) {
        [...dst.matchAll(/<([0-9a-fA-F]*)>/g)].forEach((d, i) => {
          if (from + i <= to) map.set(from + i, utf16be(Buffer.from(d[1]!, 'hex')));
        });
      } else {
        const base = Buffer.from(dst.slice(1, -1), 'hex');
        for (let code = from; code <= to; code++) {
          const out = Buffer.from(base);
          // The last byte counts up across the range.
          if (out.length >= 2) out.writeUInt16BE((out.readUInt16BE(out.length - 2) + (code - from)) & 0xffff, out.length - 2);
          map.set(code, utf16be(out));
        }
      }
    }
  }
  return { lengths: [...lengths].sort((a, b) => b - a), map };
}

function loadFont(file: PdfFile, ref: Val | undefined): Font {
  const dict = file.dict(ref);
  if (!dict) return { lengths: [1], map: new Map(), fallback: null, width: defaultWidth };
  const width = widthsOf(file, dict);
  const toUnicode = file.streamOf(dict.get('ToUnicode'));
  if (toUnicode) {
    const cmap = parseCMap(toUnicode.toString('latin1'));
    const composite = dict.get('Subtype') === '/Type0';
    return { lengths: cmap.lengths.length ? cmap.lengths : [composite ? 2 : 1], map: cmap.map, fallback: composite ? null : cp1252, width };
  }
  // A composite font without ToUnicode writes glyph ids: nothing to map them to.
  if (dict.get('Subtype') === '/Type0') return { lengths: [2], map: new Map(), fallback: null, width };
  const map = new Map<number, string>();
  const encoding = file.get(dict.get('Encoding'));
  if (isDict(encoding)) {
    const diffs = file.get(encoding.get('Differences'));
    if (Array.isArray(diffs)) {
      let code = 0;
      for (const d of diffs) {
        if (typeof d === 'number') code = d;
        else if (typeof d === 'string' && d.startsWith('/')) {
          const ch = glyphChar(d.slice(1));
          if (ch !== null) map.set(code, ch);
          code++;
        }
      }
    }
  }
  return { lengths: [1], map, fallback: cp1252, width };
}

/** The text of a string in a font, and how far it advances (in em/1000). */
function decodeWith(font: Font, bytes: Buffer): { text: string; advance: number } {
  let text = '';
  let advance = 0;
  let i = 0;
  while (i < bytes.length) {
    let matched = false;
    for (const len of font.lengths) {
      if (i + len > bytes.length) continue;
      const code = codeOf(bytes.subarray(i, i + len));
      const ch = font.map.get(code);
      if (ch !== undefined || font.lengths.length === 1) {
        text += ch ?? (len === 1 && font.fallback ? font.fallback(code) : '');
        advance += font.width(code);
        i += len;
        matched = true;
        break;
      }
    }
    if (!matched) i += font.lengths[font.lengths.length - 1] ?? 1;
  }
  return { text, advance };
}

// ── Content streams ───────────────────────────────────────────────────

class TextSink {
  private parts: string[] = [];
  private line = '';

  text(s: string): void {
    this.line += s.replace(/[\u0000-\u0008\u000b-\u001f]/g, '');
  }

  space(): void {
    if (this.line !== '' && !this.line.endsWith(' ')) this.line += ' ';
  }

  newline(): void {
    if (this.line.trim() !== '') this.parts.push(this.line.replace(/\s+/g, ' ').trim());
    this.line = '';
  }

  result(): string {
    this.newline();
    return this.parts.join('\n');
  }
}

/**
 * Where the pen is, in user space. A gap wider than a fifth of the font size
 * between where the last glyph ended and where the next one starts is a word
 * gap; a different baseline is a new line. Writers differ — LibreOffice
 * kerns with TJ adjustments, Chromium moves with Td inside a word — and the
 * position is what they agree on.
 */
interface Pen {
  font: Font;
  size: number;
  /** Start of the current line (set by Tm, moved by Td/TD/T*). */
  lineX: number;
  lineY: number;
  /** End of the last glyph drawn on this line, or null before any. */
  x: number | null;
  y: number | null;
  /** Horizontal and vertical scale of the text matrix. */
  sx: number;
  sy: number;
  leading: number;
}

function runContent(file: PdfFile, content: Buffer, resources: Map<string, Val> | null, sink: TextSink, depth: number, budget: { chars: number }, pen: Pen): void {
  const fontsDict = file.dict(resources?.get('Font'));
  const xobjects = file.dict(resources?.get('XObject'));
  const fonts = new Map<string, Font>();
  const fontFor = (name: string): Font => {
    let f = fonts.get(name);
    if (!f) {
      f = loadFont(file, fontsDict?.get(name.slice(1)));
      fonts.set(name, f);
    }
    return f;
  };

  const lexer = new Lexer(content.toString('latin1'));
  const operands: Val[] = [];
  const em = (): number => Math.abs(pen.size * pen.sx) || 1;

  /** Move the pen to the start of a run; a new baseline or a gap shows as such. */
  const moveTo = (x: number, y: number): void => {
    if (pen.y !== null && Math.abs(y - pen.y) > 0.4 * (Math.abs(pen.size * pen.sy) || 1)) sink.newline();
    else if (pen.x !== null && x - pen.x > 0.2 * em()) sink.space();
    pen.x = x;
    pen.y = y;
  };

  const show = (v: Val | undefined): void => {
    if (!Buffer.isBuffer(v)) return;
    const { text, advance } = decodeWith(pen.font, v);
    if (pen.x === null) moveTo(pen.lineX, pen.lineY);
    budget.chars -= text.length;
    sink.text(text);
    pen.x = (pen.x ?? pen.lineX) + (advance / 1000) * pen.size * pen.sx;
  };

  const newLine = (tx: number, ty: number): void => {
    pen.lineX += tx * pen.sx;
    pen.lineY += ty * pen.sy;
    moveTo(pen.lineX, pen.lineY);
  };

  for (let tok = lexer.next(); tok !== undefined && budget.chars > 0; tok = lexer.next()) {
    if (!isOp(tok)) {
      operands.push(tok);
      continue;
    }
    const num = (i: number): number => (typeof operands[i] === 'number' ? (operands[i] as number) : 0);
    switch (tok.op) {
      case 'BT':
        pen.lineX = 0;
        pen.lineY = 0;
        pen.sx = 1;
        pen.sy = 1;
        break;
      case 'Tf':
        if (typeof operands[0] === 'string') pen.font = fontFor(operands[0]);
        pen.size = num(1) || pen.size;
        break;
      case 'TL':
        pen.leading = num(0);
        break;
      case 'Tm':
        pen.sx = Math.hypot(num(0), num(1)) || 1;
        pen.sy = (num(3) < 0 ? -1 : 1) * (Math.hypot(num(2), num(3)) || 1);
        pen.lineX = num(4);
        pen.lineY = num(5);
        moveTo(pen.lineX, pen.lineY);
        break;
      case 'Td':
        newLine(num(0), num(1));
        break;
      case 'TD':
        pen.leading = -num(1);
        newLine(num(0), num(1));
        break;
      case 'T*':
        newLine(0, -pen.leading || -pen.size);
        break;
      case 'Tj':
        show(operands[0]);
        break;
      case "'":
        newLine(0, -pen.leading || -pen.size);
        show(operands[0]);
        break;
      case '"':
        newLine(0, -pen.leading || -pen.size);
        show(operands[2]);
        break;
      case 'TJ': {
        const arr = operands[0];
        if (Array.isArray(arr)) {
          for (const part of arr) {
            if (typeof part === 'number') {
              const shift = (-part / 1000) * pen.size * pen.sx;
              // A large negative adjustment is how many writers draw a word gap.
              if (shift > 0.2 * em()) sink.space();
              if (pen.x !== null) pen.x += shift;
            } else show(part);
          }
        }
        break;
      }
      case 'ID':
        lexer.skipInlineImage();
        break;
      case 'Do': {
        const name = operands[0];
        if (typeof name === 'string' && depth < 4) {
          const ref = xobjects?.get(name.slice(1));
          const xo = isRef(ref) ? file.objects.get(ref.ref) : undefined;
          if (xo && isDict(xo.value) && xo.value.get('Subtype') === '/Form') {
            const data = file.decode(xo);
            if (data) runContent(file, data, file.dict(xo.value.get('Resources')) ?? resources, sink, depth + 1, budget, pen);
          }
        }
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
}

function pageList(file: PdfFile): { page: Map<string, Val>; resources: Map<string, Val> | null }[] {
  const out: { page: Map<string, Val>; resources: Map<string, Val> | null }[] = [];
  const seen = new Set<Val>();
  const walk = (node: Map<string, Val> | null, inherited: Map<string, Val> | null, depth: number): void => {
    if (!node || seen.has(node) || depth > 64 || out.length > 5000) return;
    seen.add(node);
    const resources = file.dict(node.get('Resources')) ?? inherited;
    const kids = file.get(node.get('Kids'));
    if (node.get('Type') === '/Pages' || Array.isArray(kids)) {
      if (Array.isArray(kids)) for (const k of kids) walk(file.dict(k), resources, depth + 1);
    } else out.push({ page: node, resources });
  };
  const catalog = file.dict(file.trailer?.get('Root'));
  walk(file.dict(catalog?.get('Pages')), null, 0);
  if (out.length === 0) {
    // No usable page tree: take the page objects in file order.
    for (const obj of file.objects.values()) {
      if (isDict(obj.value) && obj.value.get('Type') === '/Page') out.push({ page: obj.value, resources: file.dict(obj.value.get('Resources')) });
    }
  }
  return out;
}

export function pdfToText(pdf: Buffer, maxChars = 1_000_000): PdfTextResult {
  const file = new PdfFile(pdf);
  if (file.trailer?.has('Encrypt')) return { status: 'encrypted', text: '' };
  const pages = pageList(file);
  if (pages.length === 0) return { status: 'unreadable', text: '' };
  const texts: string[] = [];
  const budget = { chars: maxChars };
  for (const { page, resources } of pages) {
    const contents = file.get(page.get('Contents'));
    const refs = Array.isArray(contents) ? contents : [page.get('Contents')];
    const data = Buffer.concat(refs.map((r) => file.streamOf(r)).filter((b): b is Buffer => b !== null).flatMap((b) => [b, Buffer.from('\n')]));
    const sink = new TextSink();
    const pen: Pen = { font: { lengths: [1], map: new Map(), fallback: cp1252, width: defaultWidth }, size: 12, lineX: 0, lineY: 0, x: null, y: null, sx: 1, sy: 1, leading: 0 };
    runContent(file, data, resources, sink, 0, budget, pen);
    texts.push(sink.result());
    if (budget.chars <= 0) break;
  }
  const text = texts.join('\n\n').normalize('NFKC').trim().slice(0, maxChars);
  return { status: text === '' ? 'empty' : 'text', text };
}
