import { createHash } from 'node:crypto';

/**
 * ZUGFeRD / Factur-X — putting the EN 16931 XML inside the PDF.
 *
 * A hybrid invoice is one file that a human opens as a page and a machine
 * reads as data: the CII document from `cii.ts`, embedded in the PDF the
 * module already rendered. Nothing about the visible page changes.
 *
 * ## Why an incremental update rather than a rewrite
 *
 * PS-12 has no PDF renderer and is never going to have one — MOD-04 and MOD-13
 * each own theirs, and every module in this catalogue installs and runs on its
 * own. So this appends to the caller's bytes instead of reinterpreting them:
 * new objects, then a new cross-reference section whose `/Prev` points at the
 * original. That is the mechanism PDF defines for exactly this, it leaves every
 * original byte untouched, and it means a change to MOD-04's layout can never
 * break the attachment.
 *
 * ## What ZUGFeRD requires of the container
 *
 *  - the XML as an **embedded file stream**, named exactly `factur-x.xml`;
 *  - a **file specification** carrying `/AFRelationship /Alternative` — the
 *    declaration that this attachment IS the invoice, not an extra;
 *  - an **`/EmbeddedFiles` name tree** on the catalog, which is where every
 *    reader looks first;
 *  - **`/AF`** on the catalog, the associated-files array PDF 2.0 and PDF/A-3
 *    use;
 *  - **XMP metadata** declaring the ZUGFeRD conformance level, so a reader
 *    knows the profile before it parses the XML.
 *
 * All five are done here.
 *
 * ## What full PDF/A-3 additionally requires, and does not get here
 *
 * PDF/A-3 (ISO 19005-3) demands that every font used for rendering be
 * EMBEDDED, that the file carry an ICC output intent, and that its XMP declare
 * `pdfaid:part=3`. The modules' PDF writers deliberately use the base-14 fonts
 * without embedding — that is what makes them ~270 dependency-free lines — so
 * a document produced from one cannot be PDF/A-3 conformant no matter what is
 * appended to it.
 *
 * `attachFacturX` therefore produces a **ZUGFeRD-structured hybrid**: every
 * reader that extracts the XML by name or by `/AFRelationship` finds it, which
 * is the half that carries the invoice data. It does NOT claim PDF/A-3, the
 * README says so in those words, and `pdfaid` is deliberately absent from the
 * XMP rather than asserted falsely — a document that claims a conformance it
 * does not have is worse than one that claims nothing, because a validator
 * downstream will test the claim.
 */

/** ZUGFeRD/Factur-X fixes the attachment name; readers look it up by it. */
export const FACTUR_X_FILENAME = 'factur-x.xml';

/** ZUGFeRD profile names, as they appear in the XMP. */
export type FacturXProfile = 'EN 16931' | 'XRECHNUNG';

export class PdfAttachError extends Error {}

/** Escape a PDF string literal (used inside parentheses). */
function pdfString(value: string): string {
  return value.replace(/[\\()]/g, (ch) => `\\${ch}`);
}

/**
 * The highest object number in use, and the offset of the last xref section.
 *
 * Read from the file's own trailer rather than by counting `obj` occurrences:
 * a PDF that has already been incrementally updated has several generations of
 * the same object, and counting would collide with one of them.
 */
function readTail(pdf: Buffer): { size: number; prev: number; rootRef: string } {
  const text = pdf.toString('latin1');

  const startxref = text.lastIndexOf('startxref');
  if (startxref === -1) throw new PdfAttachError('not a PDF: no startxref');
  const prevMatch = /startxref\s+(\d+)/.exec(text.slice(startxref));
  if (!prevMatch) throw new PdfAttachError('not a PDF: malformed startxref');

  // The LAST trailer wins — that is the current state of an updated file.
  const sizeMatch = [...text.matchAll(/\/Size\s+(\d+)/g)].pop();
  if (!sizeMatch) throw new PdfAttachError('not a PDF: no /Size in the trailer');

  const rootMatch = [...text.matchAll(/\/Root\s+(\d+\s+\d+\s+R)/g)].pop();
  if (!rootMatch) throw new PdfAttachError('not a PDF: no /Root in the trailer');

  return { size: Number(sizeMatch[1]), prev: Number(prevMatch[1]), rootRef: rootMatch[1]!.replace(/\s+/g, ' ') };
}

/** The catalog object's body, so the appended one can carry its keys forward. */
function readCatalog(pdf: Buffer, rootRef: string): { number: number; body: string } {
  const objectNumber = Number(rootRef.split(' ')[0]);
  const text = pdf.toString('latin1');
  const re = new RegExp(`(?:^|[^0-9])${objectNumber}\\s+0\\s+obj([\\s\\S]*?)endobj`);
  const match = re.exec(text);
  if (!match) throw new PdfAttachError(`not a PDF: catalog object ${objectNumber} not found`);
  return { number: objectNumber, body: match[1]!.trim() };
}

/** XMP packet declaring the Factur-X/ZUGFeRD profile. */
function xmp(profile: FacturXProfile): string {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Invoice</rdf:li></rdf:Alt></dc:title>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:fx="urn:factur-x:pdfa:CrossIndustryDocument:invoice:1p0#">
   <fx:DocumentType>INVOICE</fx:DocumentType>
   <fx:DocumentFileName>${FACTUR_X_FILENAME}</fx:DocumentFileName>
   <fx:Version>1.0</fx:Version>
   <fx:ConformanceLevel>${profile}</fx:ConformanceLevel>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;
}

export interface AttachOptions {
  /** Shown to a human in the reader's attachment pane. */
  description?: string;
  /** ISO-8601 instant used for the attachment's timestamps. */
  at?: string;
}

/**
 * Return `pdf` with `xml` embedded as the Factur-X attachment.
 *
 * The original bytes are the prefix of the result — byte-identical, which the
 * tests assert, because "we did not touch your document" is the whole basis on
 * which a module hands its rendered invoice to another service.
 */
export function attachFacturX(
  pdf: Buffer,
  xml: string,
  profile: FacturXProfile,
  options: AttachOptions = {},
): Buffer {
  if (!pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
    throw new PdfAttachError('not a PDF: missing the %PDF- header');
  }

  const { size, prev, rootRef } = readTail(pdf);
  const catalog = readCatalog(pdf, rootRef);

  const xmlBytes = Buffer.from(xml, 'utf8');
  // PDF wants D:YYYYMMDDHHmmSS'00' — the reader shows it in the attachment pane.
  const stamp = (options.at ? new Date(options.at) : new Date()).toISOString();
  const pdfDate = `D:${stamp.slice(0, 4)}${stamp.slice(5, 7)}${stamp.slice(8, 10)}${stamp.slice(11, 13)}${stamp.slice(14, 16)}${stamp.slice(17, 19)}Z`;

  // Object numbers continue from the original file's /Size.
  const fileStreamNo = size;
  const filespecNo = size + 1;
  const namesNo = size + 2;
  const metadataNo = size + 3;
  const catalogNo = catalog.number;

  const xmpPacket = Buffer.from(xmp(profile), 'utf8');

  // The catalog is REWRITTEN, not replaced: an incremental update supersedes
  // the object, so anything the original carried (/Pages, /Version, …) has to
  // come along or the document loses it.
  const catalogBody = catalog.body
    .replace(/^<<\s*/, '')
    .replace(/\s*>>\s*$/, '')
    .replace(/\/Names\s*<<[^>]*>>/g, '')
    .replace(/\/AF\s*\[[^\]]*\]/g, '')
    .replace(/\/Metadata\s+\d+\s+\d+\s+R/g, '')
    .trim();

  interface Appended {
    number: number;
    body: Buffer;
  }
  const appended: Appended[] = [
    {
      number: fileStreamNo,
      body: Buffer.concat([
        Buffer.from(
          `<< /Type /EmbeddedFile /Subtype /text#2Fxml /Length ${xmlBytes.length} /Params << /Size ${xmlBytes.length} /ModDate (${pdfDate}) /CheckSum <${createHash('md5').update(xmlBytes).digest('hex')}> >> >>\nstream\n`,
          'latin1',
        ),
        xmlBytes,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    },
    {
      number: filespecNo,
      // /AFRelationship /Alternative is the load-bearing key: it says this
      // attachment IS the invoice in another form, not a supplementary file.
      body: Buffer.from(
        `<< /Type /Filespec /F (${FACTUR_X_FILENAME}) /UF (${FACTUR_X_FILENAME}) ` +
          `/Desc (${pdfString(options.description ?? 'Invoice data in EN 16931 CII format')}) ` +
          `/AFRelationship /Alternative /EF << /F ${fileStreamNo} 0 R /UF ${fileStreamNo} 0 R >> >>`,
        'latin1',
      ),
    },
    {
      number: namesNo,
      body: Buffer.from(`<< /Names [(${FACTUR_X_FILENAME}) ${filespecNo} 0 R] >>`, 'latin1'),
    },
    {
      number: metadataNo,
      body: Buffer.concat([
        Buffer.from(`<< /Type /Metadata /Subtype /XML /Length ${xmpPacket.length} >>\nstream\n`, 'latin1'),
        xmpPacket,
        Buffer.from('\nendstream', 'latin1'),
      ]),
    },
    {
      number: catalogNo,
      body: Buffer.from(
        `<< ${catalogBody} /Names << /EmbeddedFiles ${namesNo} 0 R >> /AF [${filespecNo} 0 R] /Metadata ${metadataNo} 0 R >>`,
        'latin1',
      ),
    },
  ];

  const chunks: Buffer[] = [pdf];
  let offset = pdf.length;
  // A file that does not end in a newline would run its last line into the
  // first appended object.
  if (pdf[pdf.length - 1] !== 0x0a) {
    chunks.push(Buffer.from('\n', 'latin1'));
    offset += 1;
  }

  const offsets = new Map<number, number>();
  for (const object of appended) {
    offsets.set(object.number, offset);
    const header = Buffer.from(`${object.number} 0 obj\n`, 'latin1');
    const footer = Buffer.from('\nendobj\n', 'latin1');
    chunks.push(header, object.body, footer);
    offset += header.length + object.body.length + footer.length;
  }

  // The xref for an incremental update lists only what changed, in subsections
  // of consecutive object numbers.
  const numbers = [...offsets.keys()].sort((a, b) => a - b);
  const sections: number[][] = [];
  for (const n of numbers) {
    const last = sections[sections.length - 1];
    if (last && n === last[last.length - 1]! + 1) last.push(n);
    else sections.push([n]);
  }

  let xref = 'xref\n';
  for (const section of sections) {
    xref += `${section[0]} ${section.length}\n`;
    for (const n of section) xref += `${String(offsets.get(n)).padStart(10, '0')} 00000 n \n`;
  }
  const startxref = offset;
  xref += `trailer\n<< /Size ${size + 4} /Root ${rootRef} /Prev ${prev} >>\nstartxref\n${startxref}\n%%EOF\n`;
  chunks.push(Buffer.from(xref, 'latin1'));

  return Buffer.concat(chunks);
}

/**
 * Read the Factur-X attachment back out — the check that matters, because it
 * is what every consuming reader does.
 */
export function extractFacturX(pdf: Buffer): string | null {
  const text = pdf.toString('latin1');
  const nameAt = text.lastIndexOf(`(${FACTUR_X_FILENAME})`);
  if (nameAt === -1) return null;

  // Follow the name tree to the filespec, then to the embedded file stream.
  const filespecRef = /\)\s*(\d+)\s+0\s+R/.exec(text.slice(nameAt));
  if (!filespecRef) return null;
  const filespec = new RegExp(`(?:^|[^0-9])${filespecRef[1]}\\s+0\\s+obj([\\s\\S]*?)endobj`).exec(text);
  if (!filespec) return null;
  const streamRef = /\/EF\s*<<\s*\/F\s+(\d+)\s+0\s+R/.exec(filespec[1]!);
  if (!streamRef) return null;

  const streamObj = new RegExp(`(?:^|[^0-9])${streamRef[1]}\\s+0\\s+obj([\\s\\S]*?)endobj`).exec(text);
  if (!streamObj) return null;
  const body = streamObj[1]!;
  const lengthMatch = /\/Length\s+(\d+)/.exec(body);
  const start = body.indexOf('stream\n');
  if (!lengthMatch || start === -1) return null;

  const absolute = streamObj.index + (streamObj[0]!.length - body.length - 'endobj'.length) + start + 'stream\n'.length;
  return pdf.subarray(absolute, absolute + Number(lengthMatch[1])).toString('utf8');
}
