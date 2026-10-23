import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EInvoiceFormat } from '../shared/ebinterface.js';
import type { EInvoiceDocument } from './einvoice-data.js';
import { nowIso } from './invoices.js';

/**
 * Issued e-invoices as the bytes that left this module.
 *
 * Every download used to render the file again from the frozen data. That
 * kept it byte-identical only while the renderer, the fonts and the code
 * lists stayed exactly as they were: a bug fix, a layout change or the switch
 * to XRechnung 4.0 would have quietly rewritten invoices sent years earlier.
 * § 14b UStG asks the issuer to keep the document it issued (the "Doppel"),
 * for eight years, and the BMF wants an e-invoice kept in the format it was
 * sent in. A reproducible renderer cannot prove that; stored bytes can.
 *
 * So the first time a format of a document is produced, it is stored with
 * its SHA-256, the renderer version and the person who fetched it, and from
 * then on that row IS the file. Until that first delivery nothing has left the
 * module, so rendering with the code of that day is right: a 2026 invoice
 * first downloaded after an upgrade is issued in the format valid then.
 *
 * Append-only twice over: no code path updates or deletes a row, and the
 * schema's triggers refuse it (server/db.ts).
 */

/**
 * Which renderer produced a stored file. Bump it whenever the output of any
 * renderer changes (shared/einvoice.ts, shared/ebinterface.ts, the PDF/A
 * writer); test/issued-documents.test.ts pins it to the golden files, so
 * regenerating them without a bump fails.
 */
export const RENDERER_VERSION = 'mod-04-einvoice-9';

/** A freshly rendered file, before it is stored. */
export interface RenderedFile {
  /** The document's own number (BT-1): the invoice's, `-ST` or `-GS<n>`. */
  number: string;
  filename: string;
  contentType: string;
  content: Buffer;
}

/** A stored file, without its bytes — what the invoice screen lists. */
export interface IssuedDocumentInfo {
  document: string;
  format: EInvoiceFormat;
  number: string;
  filename: string;
  sha256: string;
  renderer: string;
  created_at: string;
  created_by: string;
}

export interface IssuedDocument extends IssuedDocumentInfo {
  content_type: string;
  content: Buffer;
}

/** The stored key of a document: `invoice`, `cancellation` or `credit_note:<id>`. */
export function documentKey(document: EInvoiceDocument): string {
  return typeof document === 'object' ? `credit_note:${document.creditNoteId}` : document;
}

const INFO_COLUMNS = 'document, format, number, filename, sha256, renderer, created_at, created_by';

function stored(db: Database.Database, invoiceId: number, key: string, format: EInvoiceFormat): IssuedDocument | undefined {
  return db
    .prepare(
      `SELECT ${INFO_COLUMNS}, content_type, content FROM issued_documents
       WHERE invoice_id = ? AND document = ? AND format = ?`,
    )
    .get(invoiceId, key, format) as IssuedDocument | undefined;
}

/**
 * The stored file of this document and format, or — the first time — the one
 * `render` produces, stored before it is returned. `render` is where every
 * refusal happens (409 for a draft, 422 for missing fields), so a file that
 * would not validate is never stored, and one that was delivered is never
 * rendered again.
 */
export function issuedDocument(
  db: Database.Database,
  invoiceId: number,
  document: EInvoiceDocument,
  format: EInvoiceFormat,
  actor: string,
  render: () => RenderedFile,
): IssuedDocument {
  const key = documentKey(document);
  return db.transaction(() => {
    const existing = stored(db, invoiceId, key, format);
    if (existing) return existing;
    const file = render();
    db.prepare(
      `INSERT INTO issued_documents
         (invoice_id, document, format, number, filename, content_type, content, sha256, renderer, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      invoiceId,
      key,
      format,
      file.number,
      file.filename,
      file.contentType,
      file.content,
      createHash('sha256').update(file.content).digest('hex'),
      RENDERER_VERSION,
      nowIso(),
      actor,
    );
    return stored(db, invoiceId, key, format)!;
  })();
}

/** Every file of an invoice that has been delivered, oldest first, without the bytes. */
export function issuedDocumentsOf(db: Database.Database, invoiceId: number): IssuedDocumentInfo[] {
  return db
    .prepare(`SELECT ${INFO_COLUMNS} FROM issued_documents WHERE invoice_id = ? ORDER BY id`)
    .all(invoiceId) as IssuedDocumentInfo[];
}
