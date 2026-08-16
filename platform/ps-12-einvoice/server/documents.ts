import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { buildCii } from './cii.js';
import { validateInvoice } from './validate.js';
import { DomainError, fail } from './errors.js';
import { parseCii } from './inbound.js';
import type {
  EInvoiceInput,
  InboundInvoice,
  IssuedDocument,
  Profile,
  ValidationResult,
} from '../shared/types.js';

/** ISO-8601 without milliseconds, matching every other service. */
export function nowIso(ms: number = Date.now()): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

interface DocumentRow {
  id: number;
  source: string;
  number: string;
  profile: Profile;
  syntax: 'cii';
  xml: string;
  sha256: string;
  size_bytes: number;
  issued_at: string;
}

function toIssued(row: DocumentRow): IssuedDocument {
  const { xml: _xml, ...rest } = row;
  return rest;
}

export interface IssueResult {
  document: IssuedDocument;
  xml: string;
  /** True when this call returned a document a previous call had issued. */
  replayed: boolean;
}

/**
 * Issue a structured invoice.
 *
 * Validation is a GATE, not a report. A document that breaks a rule is not
 * written, not stored and not returned — the caller gets a 422 carrying the
 * rule identifiers. That is the whole point of the service: an invalid
 * e-invoice does not fail at the sender, it fails days later at the recipient,
 * with an error message the sender never sees. Refusing here is the only moment
 * anyone can act on it.
 *
 * Issuing is idempotent per `(source, number)`. An invoice number is legally
 * unique and gapless for the business that issued it, so two different
 * documents under one number is not a state worth being able to reach — a
 * module that retries after a timeout gets back exactly what it issued the
 * first time, byte for byte.
 */
export function issueDocument(
  db: Database.Database,
  source: string,
  input: EInvoiceInput,
  profile: Profile,
  at = nowIso(),
): IssueResult {
  const existing = db
    .prepare('SELECT * FROM documents WHERE source = ? AND number = ?')
    .get(source, input.number) as DocumentRow | undefined;
  if (existing) {
    if (existing.profile !== profile) {
      fail(
        409,
        `invoice ${input.number} was already issued as ${existing.profile}; re-issuing it as ${profile} would give one invoice number two documents`,
      );
    }
    return { document: toIssued(existing), xml: existing.xml, replayed: true };
  }

  const result = validateInvoice(input, profile);
  if (!result.valid) {
    throw new DomainError(
      422,
      `invoice ${input.number || '(unnumbered)'} does not satisfy ${profile}`,
      result.violations.map((v) => ({
        field: v.term ?? v.rule,
        message: `${v.rule}: ${v.message}`,
      })),
    );
  }

  const xml = buildCii(input, profile);
  const digest = sha256(xml);
  const size = Buffer.byteLength(xml, 'utf8');
  const info = db
    .prepare(
      `INSERT INTO documents (source, number, profile, syntax, xml, sha256, size_bytes, issued_at)
       VALUES (?, ?, ?, 'cii', ?, ?, ?, ?)`,
    )
    .run(source, input.number, profile, xml, digest, size, at);

  const row = db.prepare('SELECT * FROM documents WHERE id = ?').get(Number(info.lastInsertRowid)) as DocumentRow;
  return { document: toIssued(row), xml, replayed: false };
}

/** Validate without issuing — a dry run a module can call before it commits. */
export function checkInvoice(input: EInvoiceInput, profile: Profile): ValidationResult {
  return validateInvoice(input, profile);
}

export function getDocument(db: Database.Database, source: string, number: string): { document: IssuedDocument; xml: string } {
  const row = db.prepare('SELECT * FROM documents WHERE source = ? AND number = ?').get(source, number) as
    | DocumentRow
    | undefined;
  if (!row) fail(404, `no document issued for ${source}/${number}`);
  return { document: toIssued(row), xml: row.xml };
}

export function listDocuments(db: Database.Database, filter: { source?: string; limit?: number } = {}): IssuedDocument[] {
  const limit = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const rows = filter.source
    ? (db
        .prepare('SELECT * FROM documents WHERE source = ? ORDER BY id DESC LIMIT ?')
        .all(filter.source, limit) as DocumentRow[])
    : (db.prepare('SELECT * FROM documents ORDER BY id DESC LIMIT ?').all(limit) as DocumentRow[]);
  return rows.map(toIssued);
}

export interface ReceiveResult {
  id: number;
  invoice: InboundInvoice;
  /** True when this exact document had already been received. */
  duplicate: boolean;
}

/**
 * Record a structured invoice somebody sent us.
 *
 * Deduplicated by the hash of the bytes, because the same invoice arriving
 * twice — a resent mail, a retried webhook, an operator uploading the
 * attachment a second time — is one invoice, and booking it twice is the
 * expensive mistake in that direction.
 *
 * The parsed fields are best-effort by design: this is a document from someone
 * else's system, and refusing to store one because a field is missing would
 * lose the only copy of it. Storage always succeeds; `parseCii` reports what it
 * could read, and the raw XML is kept so nothing is lost to a parser that did
 * not anticipate a sender.
 */
export function receiveDocument(db: Database.Database, xml: string, at = nowIso()): ReceiveResult {
  const digest = sha256(xml);
  const existing = db.prepare('SELECT id FROM inbound WHERE sha256 = ?').get(digest) as { id: number } | undefined;
  const invoice = parseCii(xml);
  if (existing) return { id: existing.id, invoice, duplicate: true };

  const info = db
    .prepare(
      `INSERT INTO inbound (number, issue_date, seller_name, seller_vat_id, buyer_name, currency,
                            net_cents, vat_cents, gross_cents, guideline_id, syntax, sha256, xml, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cii', ?, ?, ?)`,
    )
    .run(
      invoice.number,
      invoice.issue_date,
      invoice.seller_name,
      invoice.seller_vat_id,
      invoice.buyer_name,
      invoice.currency,
      invoice.net_cents,
      invoice.vat_total_cents,
      invoice.gross_cents,
      invoice.guideline_id,
      digest,
      xml,
      at,
    );
  return { id: Number(info.lastInsertRowid), invoice, duplicate: false };
}

export function listInbound(db: Database.Database, limit = 100): (InboundInvoice & { id: number; received_at: string })[] {
  const capped = Math.min(Math.max(limit, 1), 500);
  const rows = db
    .prepare(
      `SELECT id, number, issue_date, seller_name, seller_vat_id, buyer_name, currency,
              net_cents, vat_cents AS vat_total_cents, gross_cents, guideline_id, syntax, received_at
         FROM inbound ORDER BY id DESC LIMIT ?`,
    )
    .all(capped);
  return rows as (InboundInvoice & { id: number; received_at: string })[];
}
