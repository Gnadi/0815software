import { decodeCp1252, pdfToText } from './pdf-text.js';
import { openZip } from './unzip.js';

/**
 * What a file is, how it may be previewed, and the text in it — read from
 * the bytes, never from what the uploader claimed.
 *
 * The stored Content-Type is whatever the uploading browser said; a file
 * named `invoice.pdf` sent as `text/plain` is still a PDF, and an HTML page
 * sent as `image/png` must never be served inline as anything a browser
 * would run. So the format comes from the content (magic bytes, the ZIP
 * container's own part names), and only the formats in INLINE_TYPES are ever
 * shown inline (see app.ts).
 *
 * The text feeds the search index and the text preview. A scan has no text
 * layer: its status says "empty" rather than anything being guessed.
 */

/** Bumped when the readers change, so existing versions are read again. */
export const EXTRACTOR_VERSION = 1;

export const MAX_TEXT_CHARS = 1_000_000;

export type FileFormat =
  | 'pdf'
  | 'png'
  | 'jpeg'
  | 'gif'
  | 'webp'
  | 'docx'
  | 'xlsx'
  | 'pptx'
  | 'odt'
  | 'ods'
  | 'odp'
  | 'html'
  | 'svg'
  | 'text'
  | 'binary';

export type TextStatus = 'text' | 'empty' | 'encrypted' | 'unsupported' | 'failed';

/** How the UI may show a version: the bytes themselves, or its text. */
export type PreviewKind = 'pdf' | 'image' | 'text' | 'none';

export interface Extracted {
  format: FileFormat;
  preview: PreviewKind;
  status: TextStatus;
  text: string;
}

/** The only content types ever served inline, keyed by sniffed format. */
export const INLINE_TYPES: Partial<Record<FileFormat, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

function decodeText(bytes: Buffer): string | null {
  // A byte-order mark says which Unicode encoding; otherwise UTF-8 or nothing.
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes);
    // NUL and most control characters do not occur in text files.
    const controls = text.slice(0, 8192).match(/[\u0000-\u0008\u000e-\u001f]/g)?.length ?? 0;
    return controls > 0 ? null : text;
  } catch {
    // Not UTF-8: Windows-1252 text is still common from older Windows tools.
    const sample = bytes.subarray(0, 8192);
    if (sample.some((b) => b < 0x09 || (b > 0x0d && b < 0x20) || b === 0x7f)) return null;
    return decodeCp1252(bytes);
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', euro: '€', sect: '§', ndash: '–', mdash: '—', hellip: '…' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z]+);/g, (whole, e: string) => {
    if (e.startsWith('#x')) return safeCodePoint(parseInt(e.slice(2), 16)) ?? whole;
    if (e.startsWith('#')) return safeCodePoint(parseInt(e.slice(1), 10)) ?? whole;
    return ENTITIES[e] ?? whole;
  });
}

function safeCodePoint(n: number): string | null {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : null;
}

/** Markup to its words: elements that end a block end a line. */
function markupText(xml: string, opts: { breaks: RegExp; tabs?: RegExp; spaces?: RegExp; drop?: RegExp }): string {
  let s = xml;
  if (opts.drop) s = s.replace(opts.drop, ' ');
  s = s.replace(opts.breaks, '\n');
  if (opts.tabs) s = s.replace(opts.tabs, '\t');
  if (opts.spaces) s = s.replace(opts.spaces, ' ');
  s = s.replace(/<[^>]*>/g, '');
  return tidy(decodeEntities(s));
}

function tidy(s: string): string {
  return s
    .split('\n')
    // Runs of spaces collapse; a tab — a cell boundary in a sheet — stays one tab.
    .map((line) => line.replace(/[ \u00a0]+/g, ' ').replace(/ ?\t[ \t]*/g, '\t').trim())
    .filter((line, i, all) => line !== '' || (i > 0 && all[i - 1] !== ''))
    .join('\n')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

const htmlText = (html: string): string =>
  markupText(html, {
    drop: /<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>|<!--[\s\S]*?-->/gi,
    breaks: /<\/?(p|div|br|li|tr|h[1-6]|section|article|header|footer|table|ul|ol|blockquote|pre)\b[^>]*>/gi,
    tabs: /<\/t[dh]\s*>/gi,
  });

// Word: a paragraph ends a line, <w:tab/> and <w:br/> are what they say.
const wordText = (xml: string): string => markupText(xml, { breaks: /<\/w:p>|<w:br\b[^>]*\/>/g, tabs: /<w:tab\b[^>]*\/>/g });

// OpenDocument: paragraphs and headings end a line; <text:s/> is a space.
const odfText = (xml: string): string =>
  markupText(xml, {
    drop: /<office:(font-face-decls|automatic-styles|scripts)\b[\s\S]*?<\/office:\1>/g,
    breaks: /<\/text:(p|h)>|<text:line-break\s*\/>|<\/table:table-row>/g,
    tabs: /<text:tab\s*\/>|<\/table:table-cell>/g,
    spaces: /<text:s\b[^>]*\/>/g,
  });

function zipFormat(bytes: Buffer): FileFormat | null {
  const zip = openZip(bytes);
  if (!zip) return null;
  const mimetype = zip.read('mimetype')?.toString('ascii').trim();
  if (mimetype === 'application/vnd.oasis.opendocument.text') return 'odt';
  if (mimetype === 'application/vnd.oasis.opendocument.spreadsheet') return 'ods';
  if (mimetype === 'application/vnd.oasis.opendocument.presentation') return 'odp';
  if (zip.names.includes('word/document.xml')) return 'docx';
  if (zip.names.includes('xl/workbook.xml')) return 'xlsx';
  if (zip.names.includes('ppt/presentation.xml')) return 'pptx';
  return null;
}

/** The format of a file, from its bytes (and, for text, its declared type). */
export function sniff(bytes: Buffer, contentType = '', filename = ''): FileFormat {
  const head = bytes.subarray(0, 16);
  if (head.subarray(0, 5).toString('latin1') === '%PDF-') return 'pdf';
  // Some writers put a few bytes before the header; readers accept 1 KiB.
  if (bytes.subarray(0, 1024).includes('%PDF-')) return 'pdf';
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpeg';
  if (/^GIF8[79]a/.test(head.subarray(0, 6).toString('latin1'))) return 'gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) return zipFormat(bytes) ?? 'binary';
  const text = decodeText(bytes.subarray(0, 64 * 1024));
  if (text === null) return 'binary';
  const start = text.trimStart().slice(0, 512).toLowerCase();
  const name = filename.toLowerCase();
  const type = contentType.toLowerCase();
  if (start.includes('<svg') || name.endsWith('.svg') || type.includes('svg')) return 'svg';
  if (start.startsWith('<!doctype html') || start.startsWith('<html') || /\.x?html?$/.test(name) || type.includes('html')) return 'html';
  return 'text';
}

function officeText(format: FileFormat, bytes: Buffer): string | null {
  const zip = openZip(bytes);
  if (!zip) return null;
  const xml = (name: string): string => zip.read(name)?.toString('utf8') ?? '';
  const ordered = (pattern: RegExp): string[] =>
    zip.names.filter((n) => pattern.test(n)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0));
  switch (format) {
    case 'docx':
      return tidy(['word/document.xml', ...ordered(/^word\/(header|footer)\d*\.xml$/), 'word/footnotes.xml'].map((n) => wordText(xml(n))).join('\n'));
    case 'xlsx': {
      // Text cells live in the shared-string table; inline strings and
      // numbers in the sheets themselves.
      const shared = [...xml('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => markupText(m[1]!, { breaks: /$^/ }));
      const sheets = ordered(/^xl\/worksheets\/sheet\d+\.xml$/).map((n) =>
        [...xml(n).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)]
          .map((row) =>
            [...row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
              .map((c) => {
                const attrs = c[1]!;
                const body = c[2] ?? '';
                if (/\bt="s"/.test(attrs)) return shared[Number(/<v>(\d+)<\/v>/.exec(body)?.[1] ?? -1)] ?? '';
                if (/\bt="inlineStr"/.test(attrs)) return markupText(body, { breaks: /$^/ });
                return decodeEntities(/<v>([^<]*)<\/v>/.exec(body)?.[1] ?? '');
              })
              .filter(Boolean)
              .join('\t'),
          )
          .join('\n'),
      );
      return tidy(sheets.join('\n\n'));
    }
    case 'pptx':
      return tidy(ordered(/^ppt\/slides\/slide\d+\.xml$/).map((n) => markupText(xml(n), { breaks: /<\/a:p>/g })).join('\n\n'));
    case 'ods': {
      // A cell's paragraphs are one value; cells are tab-separated like a sheet.
      const content = xml('content.xml');
      return tidy(
        [...content.matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/g)]
          .map((row) =>
            [...row[1]!.matchAll(/<table:table-cell\b[^>]*?(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g)]
              .map((c) => odfText(c[1] ?? '').replace(/\n/g, ' '))
              .filter(Boolean)
              .join('\t'),
          )
          .join('\n'),
      );
    }
    case 'odt':
    case 'odp':
      return odfText(xml('content.xml'));
    default:
      return null;
  }
}

export function extract(bytes: Buffer, contentType = '', filename = ''): Extracted {
  let format: FileFormat;
  try {
    format = sniff(bytes, contentType, filename);
  } catch {
    // A file the readers cannot even classify is still a stored file.
    return { format: 'binary', preview: 'none', status: 'failed', text: '' };
  }
  const result = (preview: PreviewKind, status: TextStatus, text = ''): Extracted => ({ format, preview, status, text });
  try {
    switch (format) {
      case 'pdf': {
        const r = pdfToText(bytes, MAX_TEXT_CHARS);
        return result('pdf', r.status === 'unreadable' ? 'failed' : r.status, r.text);
      }
      case 'png':
      case 'jpeg':
      case 'gif':
      case 'webp':
        // A picture has no text layer; reading text out of pixels is OCR.
        return result('image', 'empty');
      case 'docx':
      case 'xlsx':
      case 'pptx':
      case 'odt':
      case 'ods':
      case 'odp': {
        const text = officeText(format, bytes);
        return text === null ? result('none', 'failed') : result('text', text ? 'text' : 'empty', text);
      }
      case 'html':
      case 'svg': {
        // Shown as its words, never as markup a browser would run.
        const text = htmlText(decodeText(bytes) ?? '');
        return result('text', text ? 'text' : 'empty', text);
      }
      case 'text': {
        // Kept as written — columns in a CSV, indentation in code.
        const text = (decodeText(bytes) ?? '').replace(/\r\n?/g, '\n').trimEnd().slice(0, MAX_TEXT_CHARS);
        return result('text', text.trim() ? 'text' : 'empty', text);
      }
      default:
        return result('none', 'unsupported');
    }
  } catch {
    return result(format === 'pdf' ? 'pdf' : 'none', 'failed');
  }
}
