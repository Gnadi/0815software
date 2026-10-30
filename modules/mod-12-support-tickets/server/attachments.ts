import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type { AttachmentInfo, CommentVisibility, FieldError } from '../shared/types.js';
import { DomainError } from './tickets.js';

/**
 * Files on tickets. They arrive base64 in the JSON of the request that
 * carries them (the web form, a follow-up, a reply, a mail) and are stored in
 * this module's own database next to the event they came with — so the
 * module needs no file service, and a backup of its database carries them.
 * With FILES_URL set, PS-06 receives a copy (server/platform.ts); the local
 * row stays the one that is served.
 *
 * Who may download one follows the event: the opening request and public
 * replies are the requester's to see; a file on an internal note is not, and
 * the public route answers 404 for it exactly as for a file that does not
 * exist.
 */

export interface AttachmentLimits {
  /** Per file, in bytes. */
  maxBytes: number;
  /** Files on one message. */
  perMessage: number;
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = { maxBytes: 10 * 1024 * 1024, perMessage: 5 };

export interface NewAttachment {
  filename: string;
  contentType: string;
  bytes: Buffer;
}

/** A name a download can carry: no path, no control characters. */
export function safeFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(0, 255);
  return clean === '' || clean === '.' || clean === '..' ? 'attachment' : clean;
}

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

function mediaType(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase().split(';')[0]!.trim() : '';
  return MEDIA_TYPE.test(value) ? value : 'application/octet-stream';
}

function megabytes(bytes: number): string {
  return `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
}

/** Validate the `attachments` of a request; absent means none. */
export function parseUploads(raw: unknown, limits: AttachmentLimits): NewAttachment[] {
  if (raw === undefined || raw === null) return [];
  const errors: FieldError[] = [];
  if (!Array.isArray(raw)) throw new DomainError(422, 'Validation failed', [{ field: 'attachments', message: 'must be a list of { filename, content_type, content_base64 }' }]);
  if (raw.length > limits.perMessage) throw new DomainError(422, 'Validation failed', [{ field: 'attachments', message: `at most ${limits.perMessage} files per message` }]);
  const files = raw.map((item, i): NewAttachment => {
    const f = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    const field = `attachments.${i}`;
    const name = typeof f.filename === 'string' ? f.filename : '';
    if (name.trim() === '') errors.push({ field: `${field}.filename`, message: 'is required' });
    const data = typeof f.content_base64 === 'string' ? f.content_base64.replace(/\s/g, '') : '';
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data) || data.length % 4 === 1) errors.push({ field: `${field}.content_base64`, message: 'must be base64' });
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length === 0) errors.push({ field: `${field}.content_base64`, message: `${name || 'the file'} is empty` });
    else if (bytes.length > limits.maxBytes) errors.push({ field: `${field}.content_base64`, message: `${name || 'the file'} is ${megabytes(bytes.length)} — at most ${megabytes(limits.maxBytes)} per file` });
    return { filename: safeFilename(name), contentType: mediaType(f.content_type), bytes };
  });
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return files;
}

interface AttachmentRow extends AttachmentInfo {
  ticket_id: number;
  event_id: number;
}

const INFO_COLUMNS = 'id, ticket_id, event_id, filename, content_type, size, sha256, created_at';

const toInfo = (r: AttachmentRow): AttachmentInfo => ({ id: r.id, filename: r.filename, content_type: r.content_type, size: r.size, sha256: r.sha256, created_at: r.created_at });

/** Store the files of one event. Call inside the transaction that wrote the event. */
export function storeAttachments(db: Database.Database, ticketId: number, eventId: number, files: readonly NewAttachment[], at: string): AttachmentInfo[] {
  const insert = db.prepare('INSERT INTO attachments (ticket_id, event_id, filename, content_type, size, sha256, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  return files.map((f) => {
    const sha256 = createHash('sha256').update(f.bytes).digest('hex');
    const info = insert.run(ticketId, eventId, f.filename, f.contentType, f.bytes.length, sha256, f.bytes, at);
    return { id: Number(info.lastInsertRowid), filename: f.filename, content_type: f.contentType, size: f.bytes.length, sha256, created_at: at };
  });
}

/** A ticket's files, by the event they came with — metadata only, never the bytes. */
export function attachmentsByEvent(db: Database.Database, ticketId: number): Map<number, AttachmentInfo[]> {
  const rows = db.prepare(`SELECT ${INFO_COLUMNS} FROM attachments WHERE ticket_id = ? ORDER BY id`).all(ticketId) as AttachmentRow[];
  const byEvent = new Map<number, AttachmentInfo[]>();
  for (const r of rows) {
    const list = byEvent.get(r.event_id) ?? [];
    list.push(toInfo(r));
    byEvent.set(r.event_id, list);
  }
  return byEvent;
}

export interface AttachmentFile {
  info: AttachmentInfo;
  content: Buffer;
  /** Who may see it, from the event it came with. */
  visibility: CommentVisibility;
}

/** One file of one ticket — 404 for another ticket's file, as for none. */
export function readAttachment(db: Database.Database, ref: string, id: number): AttachmentFile {
  const row = db
    .prepare(
      `SELECT a.${INFO_COLUMNS.split(', ').join(', a.')}, a.content, e.type AS event_type, e.visibility AS event_visibility
         FROM attachments a JOIN tickets t ON t.id = a.ticket_id JOIN ticket_events e ON e.id = a.event_id
        WHERE t.ref = ? AND a.id = ?`,
    )
    .get(ref, id) as (AttachmentRow & { content: Buffer; event_type: string; event_visibility: CommentVisibility | null }) | undefined;
  if (!row) throw new DomainError(404, 'Attachment not found');
  const visibility: CommentVisibility = row.event_type === 'comment' ? (row.event_visibility ?? 'internal') : 'public';
  return { info: toInfo(row), content: row.content, visibility };
}
