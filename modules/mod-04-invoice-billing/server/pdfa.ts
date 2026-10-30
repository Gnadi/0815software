/**
 * PDF/A-3b with an embedded e-invoice — the container ZUGFeRD 2.x and
 * Factur-X are defined as.
 *
 * The invoice layout is the same `layoutInvoice` the plain PDF uses; what
 * changes is everything PDF/A demands of the file around it:
 *
 *   - Every font EMBEDDED. The plain PDF names Helvetica and Courier and lets
 *     the viewer supply them; PDF/A forbids that. Liberation Sans and Mono
 *     (SIL OFL, metric-compatible with Helvetica and Courier, shipped in
 *     assets/fonts) are embedded as subsets — see server/ttf.ts — so
 *     right-aligned Courier columns line up exactly as before.
 *   - An OUTPUT INTENT with an ICC profile, because the page uses DeviceGray.
 *     The profile is a small sRGB description generated below, not a binary
 *     blob checked into the repository.
 *   - XMP METADATA declaring PDF/A-3 conformance B and, through the Factur-X
 *     extension schema, which file is the invoice and in which profile.
 *   - The XML as an ASSOCIATED FILE: `factur-x.xml` in the EmbeddedFiles name
 *     tree and in the catalog's /AF array, with /AFRelationship /Alternative —
 *     the PDF is a rendering of the XML, and the XML is the invoice.
 *   - A trailer /ID, and nothing PDF/A excludes (no encryption, no
 *     transparency, no JavaScript, no LZW).
 *
 * Deterministic like the rest of this module's files: the same invoice
 * yields the same bytes, because every date written is the issue date and
 * the subset tags and file id are hashes of the content.
 */

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { FACTURX_CONFORMANCE, FACTURX_FILENAME, xmlText } from '../shared/einvoice.js';
import { fonts, unicodeOf } from './fonts.js';
import { A4, FONTS, type FontKey, type Page } from './pdf.js';

// ── sRGB ICC profile (v2, matrix/TRC), generated ───────────────────────

function s15(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(Math.round(value * 65536));
  return b;
}

function xyz(x: number, y: number, z: number): Buffer {
  return Buffer.concat([Buffer.from('XYZ \0\0\0\0', 'latin1'), s15(x), s15(y), s15(z)]);
}

/**
 * A minimal sRGB display profile: D50-adapted sRGB primaries and a 2.2 gamma
 * curve. Enough for an output intent — the page is black and grey text — and
 * small enough (≈ 500 bytes) to build here instead of shipping a binary.
 */
export function srgbProfile(): Buffer {
  const desc = (() => {
    const text = Buffer.from('sRGB (0815software)\0', 'latin1');
    const head = Buffer.alloc(12);
    head.write('desc', 0, 'latin1');
    head.writeUInt32BE(text.length, 8);
    // Unicode language + count (0), ScriptCode code + count (0) + 67 bytes.
    return Buffer.concat([head, text, Buffer.alloc(8), Buffer.alloc(3 + 67)]);
  })();
  const cprt = Buffer.concat([Buffer.from('text\0\0\0\0', 'latin1'), Buffer.from('No copyright, use freely\0', 'latin1')]);
  const curve = Buffer.concat([Buffer.from('curv\0\0\0\0', 'latin1'), Buffer.from([0, 0, 0, 1, 0x02, 0x33, 0, 0])]);
  const tags: [string, Buffer][] = [
    ['desc', desc],
    ['cprt', cprt],
    ['wtpt', xyz(0.9642, 1.0, 0.8249)],
    ['rXYZ', xyz(0.4361, 0.2225, 0.0139)],
    ['gXYZ', xyz(0.3851, 0.7169, 0.0971)],
    ['bXYZ', xyz(0.1431, 0.0606, 0.7141)],
    ['rTRC', curve],
    ['gTRC', curve],
    ['bTRC', curve],
  ];
  const table = Buffer.alloc(4 + tags.length * 12);
  table.writeUInt32BE(tags.length, 0);
  const bodies: Buffer[] = [];
  let offset = 128 + table.length;
  const seen = new Map<Buffer, number>();
  tags.forEach(([sig, data], i) => {
    let at = seen.get(data);
    if (at === undefined) {
      at = offset;
      seen.set(data, at);
      const padded = Buffer.alloc((data.length + 3) & ~3);
      data.copy(padded);
      bodies.push(padded);
      offset += padded.length;
    }
    table.write(sig, 4 + i * 12, 'latin1');
    table.writeUInt32BE(at, 8 + i * 12);
    table.writeUInt32BE(data.length, 12 + i * 12);
  });
  const header = Buffer.alloc(128);
  header.writeUInt32BE(offset, 0);
  header.writeUInt32BE(0x02100000, 8); // version 2.1
  header.write('mntr', 12, 'latin1');
  header.write('RGB ', 16, 'latin1');
  header.write('XYZ ', 20, 'latin1');
  [2026, 1, 1, 0, 0, 0].forEach((v, i) => header.writeUInt16BE(v, 24 + i * 2));
  header.write('acsp', 36, 'latin1');
  s15(0.9642).copy(header, 68);
  s15(1.0).copy(header, 72);
  s15(0.8249).copy(header, 76);
  return Buffer.concat([header, table, ...bodies]);
}

// ── XMP ────────────────────────────────────────────────────────────────

const FX_NS = 'urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#';

function xmp(options: { title: string; author: string; date: string; conformance: string }): string {
  const property = (name: string, description: string): string =>
    `<rdf:li rdf:parseType="Resource"><pdfaProperty:name>${name}</pdfaProperty:name>` +
    `<pdfaProperty:valueType>Text</pdfaProperty:valueType><pdfaProperty:category>external</pdfaProperty:category>` +
    `<pdfaProperty:description>${description}</pdfaProperty:description></rdf:li>`;
  return [
    '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>',
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">',
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">',
    '<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">',
    '<pdfaid:part>3</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>',
    '</rdf:Description>',
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">',
    `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlText(options.title)}</rdf:li></rdf:Alt></dc:title>`,
    `<dc:creator><rdf:Seq><rdf:li>${xmlText(options.author)}</rdf:li></rdf:Seq></dc:creator>`,
    '</rdf:Description>',
    '<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">',
    `<xmp:CreatorTool>0815software MOD-04 Invoice &amp; Billing</xmp:CreatorTool>`,
    `<xmp:CreateDate>${options.date}</xmp:CreateDate><xmp:ModifyDate>${options.date}</xmp:ModifyDate>`,
    '</rdf:Description>',
    '<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">',
    '<pdf:Producer>0815software MOD-04</pdf:Producer>',
    '</rdf:Description>',
    `<rdf:Description rdf:about="" xmlns:fx="${FX_NS}">`,
    `<fx:DocumentType>INVOICE</fx:DocumentType><fx:DocumentFileName>${FACTURX_FILENAME}</fx:DocumentFileName>`,
    `<fx:Version>1.0</fx:Version><fx:ConformanceLevel>${options.conformance}</fx:ConformanceLevel>`,
    '</rdf:Description>',
    '<rdf:Description rdf:about="" xmlns:pdfaExtension="http://www.aiim.org/pdfa/ns/extension/"' +
      ' xmlns:pdfaSchema="http://www.aiim.org/pdfa/ns/schema#" xmlns:pdfaProperty="http://www.aiim.org/pdfa/ns/property#">',
    '<pdfaExtension:schemas><rdf:Bag><rdf:li rdf:parseType="Resource">',
    '<pdfaSchema:schema>Factur-X PDFA Extension Schema</pdfaSchema:schema>',
    `<pdfaSchema:namespaceURI>${FX_NS}</pdfaSchema:namespaceURI>`,
    '<pdfaSchema:prefix>fx</pdfaSchema:prefix>',
    '<pdfaSchema:property><rdf:Seq>',
    property('DocumentFileName', 'name of the embedded XML invoice file'),
    property('DocumentType', 'INVOICE'),
    property('Version', 'The actual version of the Factur-X XML schema'),
    property('ConformanceLevel', 'The conformance level of the embedded Factur-X data'),
    '</rdf:Seq></pdfaSchema:property>',
    '</rdf:li></rdf:Bag></pdfaExtension:schemas>',
    '</rdf:Description>',
    '</rdf:RDF>',
    '</x:xmpmeta>',
    '<?xpacket end="w"?>',
  ].join('\n');
}

// ── Assembly ───────────────────────────────────────────────────────────

/** A PDF text string: ASCII as-is, anything else as UTF-16BE with a BOM. */
function pdfString(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return `(${text.replace(/[\\()]/g, (c) => `\\${c}`)})`;
  return `<FEFF${Buffer.from(text, 'utf16le').swap16().toString('hex').toUpperCase()}>`;
}

const num = (value: number): string => String(Math.round(value * 100) / 100);

export interface PdfAOptions {
  /** The CII XML, embedded as factur-x.xml. */
  xml: string;
  /** "EN 16931" (ZUGFeRD EN16931 profile) or "XRECHNUNG". */
  conformance?: string;
  title: string;
  author: string;
  /** "YYYY-MM-DD" — written as every date in the file, so the bytes are reproducible. */
  date: string;
}

/** Assemble pages into a PDF/A-3b carrying `options.xml` as its invoice. */
export function buildPdfA(pages: Page[], options: PdfAOptions): Buffer {
  const font = fonts();
  const keys = Object.keys(FONTS) as FontKey[];

  // Which codes each font shows, over the whole document.
  const usedCodes = new Map<FontKey, Set<number>>(keys.map((k) => [k, new Set<number>()]));
  for (const page of pages) {
    for (const [key, codes] of page.used) for (const code of codes) usedCodes.get(key)!.add(code);
  }

  const objects: string[] = [];
  /** Reserve an object number now, fill its body later. */
  const reserve = (): number => objects.push('') ;
  const set = (id: number, body: string): void => {
    objects[id - 1] = body;
  };
  const stream = (dict: string, data: string): string => `<< ${dict} /Length ${data.length} >>\nstream\n${data}\nendstream`;
  // Font programs are binary and compress well; Flate is permitted by PDF/A.
  const flate = (dict: string, data: Buffer): string =>
    stream(`${dict} /Filter /FlateDecode`, deflateSync(data, { level: 9 }).toString('latin1'));

  const catalogId = reserve();
  const pagesId = reserve();

  const fontIds = new Map<FontKey, number>();
  for (const key of keys) {
    const ttf = font[key];
    const glyphs = [...usedCodes.get(key)!]
      .map((code) => unicodeOf(code))
      .filter((u): u is number => u !== null)
      .map((u) => ttf.glyphOf(u));
    const subset = ttf.subset(glyphs);
    const tag = createHash('sha256')
      .update(subset)
      .digest()
      .subarray(0, 6)
      .reduce((s, b) => s + String.fromCharCode(65 + (b % 26)), '');
    const name = `${tag}+${ttf.postscriptName}`;

    const fileId = objects.push(flate(`/Length1 ${subset.length}`, subset));
    const flags = 32 | (ttf.fixedPitch ? 1 : 0); // Nonsymbolic, FixedPitch for the mono faces
    const descriptorId = objects.push(
      `<< /Type /FontDescriptor /FontName /${name} /Flags ${flags} ` +
        `/FontBBox [${ttf.bbox.map((v) => ttf.scale(v)).join(' ')}] /ItalicAngle ${ttf.italicAngle} ` +
        `/Ascent ${ttf.scale(ttf.ascent)} /Descent ${ttf.scale(ttf.descent)} /CapHeight ${ttf.scale(ttf.capHeight)} ` +
        `/StemV ${ttf.bold ? 120 : 80} /FontFile2 ${fileId} 0 R >>`,
    );
    const widths: number[] = [];
    for (let code = 32; code <= 255; code++) {
      const u = unicodeOf(code);
      widths.push(u === null ? 0 : ttf.width(ttf.glyphOf(u)));
    }
    fontIds.set(
      key,
      objects.push(
        `<< /Type /Font /Subtype /TrueType /BaseFont /${name} /FirstChar 32 /LastChar 255 ` +
          `/Widths [${widths.join(' ')}] /FontDescriptor ${descriptorId} 0 R /Encoding /WinAnsiEncoding >>`,
      ),
    );
  }

  const resources = `<< /Font << ${keys.map((k) => `/${k} ${fontIds.get(k)} 0 R`).join(' ')} >> >>`;
  const pageIds: number[] = [];
  for (const page of pages) {
    const pageId = reserve();
    const contentId = objects.push(stream('', page.content()));
    set(
      pageId,
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${num(A4.width)} ${num(A4.height)}] ` +
        `/Resources ${resources} /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }
  set(pagesId, `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`);

  const pdfDate = `D:${options.date.replace(/-/g, '')}000000Z`;
  const xmlBytes = Buffer.from(options.xml, 'utf8');
  const embeddedId = objects.push(
    stream(
      `/Type /EmbeddedFile /Subtype /text#2Fxml /Params << /ModDate (${pdfDate}) /Size ${xmlBytes.length} >>`,
      xmlBytes.toString('latin1'),
    ),
  );
  const filespecId = objects.push(
    `<< /Type /Filespec /F (${FACTURX_FILENAME}) /UF (${FACTURX_FILENAME}) /Desc (Factur-X/ZUGFeRD invoice) ` +
      `/AFRelationship /Alternative /EF << /F ${embeddedId} 0 R /UF ${embeddedId} 0 R >> >>`,
  );

  const icc = srgbProfile();
  const iccId = objects.push(stream('/N 3', icc.toString('latin1')));
  const intentId = objects.push(
    `<< /Type /OutputIntent /S /GTS_PDFA1 /OutputConditionIdentifier (sRGB) /Info (sRGB) /DestOutputProfile ${iccId} 0 R >>`,
  );

  const metadata = Buffer.from(
    xmp({
      title: options.title,
      author: options.author,
      date: `${options.date}T00:00:00Z`,
      conformance: options.conformance ?? FACTURX_CONFORMANCE,
    }),
    'utf8',
  );
  const metadataId = objects.push(stream('/Type /Metadata /Subtype /XML', metadata.toString('latin1')));

  set(
    catalogId,
    `<< /Type /Catalog /Pages ${pagesId} 0 R /Metadata ${metadataId} 0 R /OutputIntents [${intentId} 0 R] ` +
      `/Names << /EmbeddedFiles << /Names [${pdfString(FACTURX_FILENAME)} ${filespecId} 0 R] >> >> ` +
      `/AF [${filespecId} 0 R] /Lang (de) /ViewerPreferences << /DisplayDocTitle true >> >>`,
  );

  let out = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const id = createHash('md5').update(out, 'latin1').digest('hex').toUpperCase();
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R /ID [<${id}> <${id}>] >>\n` +
    `startxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
