import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extract, sniff } from '../server/extract.js';
import { pdfToText } from '../server/pdf-text.js';
import { ftsQuery } from '../server/search.js';
import { buildPdf, buildZip } from './helpers/files.js';

/**
 * Reading text out of what people upload — checked against files real
 * writers produced (test/fixtures, with their provenance), and against
 * hand-built files for the cases no office suite writes on request.
 */

const fixture = (name: string): Buffer => readFileSync(join(import.meta.dirname, 'fixtures', name));

const LEASE = [
  'Mietvertrag Wohnung Graz',
  'Die Kaution beträgt 2.400 € und wird auf das Treuhandkonto überwiesen.',
  'Übergabe am 1. März 2026 — Schlüssel: 3 Stück, Straße & Hausnummer: Herrengasse 16.',
  'Kündigungsfrist drei Monate; die Wohnung ist möbliert (Küche, Bad, Schlafzimmer).',
].join('\n');

const OFFER = ['Position\tMenge\tPreis', 'Schreibtisch Eiche\t2\t450,00', 'Bürostuhl ergonomisch\t4\t289,90', 'Überspannungsschutz\t6\t19,99'].join('\n');

describe('files from real writers', () => {
  it.each([
    ['mietvertrag-libreoffice.pdf', 'pdf', 'pdf'],
    ['mietvertrag-chromium.pdf', 'pdf', 'pdf'],
    ['mietvertrag.docx', 'docx', 'text'],
    ['mietvertrag.odt', 'odt', 'text'],
  ])('%s reads as the text that was written', (name, format, preview) => {
    // Sent as octet-stream on purpose: the bytes decide, not the label.
    const result = extract(fixture(name), 'application/octet-stream', 'upload.bin');
    expect(result).toMatchObject({ format, preview, status: 'text' });
    expect(result.text).toBe(LEASE);
  });

  it.each([
    ['angebot.xlsx', 'xlsx'],
    ['angebot.ods', 'ods'],
  ])('%s reads row by row, cell by cell', (name, format) => {
    const result = extract(fixture(name));
    expect(result).toMatchObject({ format, preview: 'text', status: 'text' });
    expect(result.text).toBe(OFFER);
  });
});

describe('PDFs no office suite writes on request', () => {
  const page = (content: string, resources: string, extra: string[] = []): Buffer =>
    buildPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources ${resources} /Contents 4 0 R >>`,
      { dict: '', stream: content, deflate: true },
      ...extra,
    ]);

  it('a standard font: WinAnsi bytes, octal escapes and € (0x80, not Latin-1)', () => {
    const pdf = page(
      'BT /F1 12 Tf 72 720 Td (Gr\\374\\337e aus Wien: \\200 5,00) Tj 0 -14 Td (zweite Zeile) Tj ET',
      '<< /Font << /F1 5 0 R >> >>',
      ['<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'],
    );
    expect(pdfToText(pdf)).toEqual({ status: 'text', text: 'Grüße aus Wien: € 5,00\nzweite Zeile' });
  });

  it('an encoding with /Differences maps codes to glyph names', () => {
    const pdf = page('BT /F1 12 Tf 72 720 Td (AB) Tj ET', '<< /Font << /F1 5 0 R >> >>', [
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Differences [65 /udieresis /germandbls] >> >>',
    ]);
    expect(pdfToText(pdf).text).toBe('üß');
  });

  it('fonts inside a compressed object stream, text inside a form XObject', () => {
    // Object 7 — the font — exists only inside object stream 5 (PDF 1.5+).
    const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
    const header = '7 0 ';
    const pdf = buildPdf([
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> /XObject << /X1 6 0 R >> >> /Contents 4 0 R >>',
      { dict: '', stream: 'BT /F1 12 Tf 72 720 Td (Hauptseite) Tj ET /X1 Do', deflate: true },
      { dict: `/Type /ObjStm /N 1 /First ${header.length}`, stream: header + font, deflate: true },
      { dict: '/Type /XObject /Subtype /Form /BBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >>', stream: 'BT /F1 10 Tf 72 700 Td (aus dem Formular) Tj ET', deflate: true },
    ]);
    expect(pdfToText(pdf).text).toBe('Hauptseite\naus dem Formular');
  });

  it('an encrypted PDF is reported as such, not read as noise', () => {
    const pdf = buildPdf(['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [] /Count 0 >>', '<< /Filter /Standard /V 2 /R 3 >>'], '/Encrypt 3 0 R');
    expect(pdfToText(pdf).status).toBe('encrypted');
    expect(extract(pdf).status).toBe('encrypted');
  });

  it('a page that is only a picture — a scan — has no text, and says so', () => {
    const pdf = page('q 595 0 0 842 0 0 cm /Im1 Do Q', '<< /XObject << /Im1 5 0 R >> >>', [
      { dict: '/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode', stream: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) } as never,
    ]);
    expect(extract(pdf)).toMatchObject({ format: 'pdf', preview: 'pdf', status: 'empty', text: '' });
  });

  it('a truncated or broken PDF fails softly', () => {
    const pdf = fixture('mietvertrag-libreoffice.pdf');
    expect(['failed', 'empty', 'text']).toContain(extract(pdf.subarray(0, 3000)).status);
    expect(extract(Buffer.from('%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n')).status).toBe('failed');
  });
});

describe('what a file is decides how it may be shown', () => {
  it('HTML and SVG are text — never something to render — whatever they were sent as', () => {
    const html = Buffer.from('<!doctype html><html><head><script>alert(document.cookie)</script><style>p{}</style></head><body><p>Hallo &amp; willkommen</p><p>Zweiter&nbsp;Absatz</p></body></html>');
    const sent = extract(html, 'image/png', 'logo.png');
    expect(sent).toMatchObject({ format: 'html', preview: 'text', status: 'text' });
    expect(sent.text).toBe('Hallo & willkommen\n\nZweiter Absatz');
    expect(sent.text).not.toContain('alert');
    const svg = extract(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><text>Lageplan</text></svg>'), 'image/svg+xml', 'plan.svg');
    expect(svg).toMatchObject({ format: 'svg', preview: 'text', text: 'Lageplan' });
  });

  it('a PDF sent as text/plain is a PDF; a PNG is an image with no text', () => {
    expect(sniff(fixture('mietvertrag-chromium.pdf'), 'text/plain', 'x.txt')).toBe('pdf');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    expect(extract(png, 'text/plain')).toMatchObject({ format: 'png', preview: 'image', status: 'empty' });
    expect(sniff(Buffer.from('GIF89a......'))).toBe('gif');
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('jpeg');
  });

  it('text in UTF-16 with a byte-order mark, and Windows-1252 from older tools', () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Grüße\r\nWien', 'utf16le')]);
    expect(extract(utf16)).toMatchObject({ format: 'text', text: 'Grüße\nWien' });
    expect(extract(Buffer.from([0x50, 0x72, 0x65, 0x69, 0x73, 0x3a, 0x20, 0x35, 0x20, 0x80, 0x20, 0x66, 0xfc, 0x72]))).toMatchObject({ text: 'Preis: 5 € für' });
  });

  it('a CSV keeps its columns', () => {
    expect(extract(Buffer.from('a;b\n1;  2\n'), 'text/csv', 'x.csv').text).toBe('a;b\n1;  2');
  });

  it('binary that is none of the above has no preview and no text', () => {
    expect(extract(Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0x00]))).toMatchObject({ format: 'binary', preview: 'none', status: 'unsupported' });
    expect(extract(Buffer.alloc(0))).toMatchObject({ status: 'empty' });
    expect(extract(Buffer.from('x'))).toMatchObject({ format: 'text', text: 'x' });
  });

  it('a PowerPoint deck reads slide by slide, in slide order', () => {
    const slide = (t: string) => `<p:sld xmlns:a="a" xmlns:p="p"><p:txBody><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:txBody></p:sld>`;
    const pptx = buildZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'ppt/presentation.xml', data: '<p:presentation xmlns:p="p"/>' },
      { name: 'ppt/slides/slide10.xml', data: slide('Zehn') },
      { name: 'ppt/slides/slide2.xml', data: slide('Zwei') },
      { name: 'ppt/slides/slide1.xml', data: slide('Eins &amp; mehr') },
    ]);
    expect(extract(pptx)).toMatchObject({ format: 'pptx', preview: 'text', text: 'Eins & mehr\n\nZwei\n\nZehn' });
  });

  it('a ZIP that inflates to far more than it weighs fails one file, not the server', () => {
    // 64 MiB of zeros in a few kilobytes, as the document body of a .docx.
    const bomb = buildZip([
      { name: '[Content_Types].xml', data: '<Types/>' },
      { name: 'word/document.xml', data: Buffer.alloc(64 * 1024 * 1024) },
    ]);
    expect(bomb.length).toBeLessThan(200_000);
    const started = Date.now();
    const result = extract(bomb);
    expect(result.format).toBe('docx');
    expect(['failed', 'empty']).toContain(result.status);
    expect(Date.now() - started).toBeLessThan(5000);
  });

});

describe('what a search box sends to FTS5', () => {
  it('each word a prefix term, "quoted" a phrase, FTS5 syntax inert', () => {
    expect(ftsQuery('Kaution Treuhand')).toBe('"Kaution"* AND "Treuhand"*');
    expect(ftsQuery('"drei Monate" frist')).toBe('"drei Monate" AND "frist"*');
    expect(ftsQuery('NEAR(a b) -x * " OR ^')).toBe('"NEAR"* AND "a"* AND "b"* AND "x"* AND "OR"*');
    expect(ftsQuery('  *** ')).toBeNull();
  });
});
