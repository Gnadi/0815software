import { unlinkSync } from 'node:fs';
import type Database from 'better-sqlite3';
import type { Disposal, DocumentEvent, DueDocument, RetentionClass, RetentionInfo } from '../shared/types.js';
import { DomainError, nowIso, requireDocumentAccess, requireMatterAccess, type AuthUser } from './docs.js';
import type { PlatformHooks } from './platform.js';
import { blobPath } from './storage.js';

/**
 * Retention: how long a document must be kept, and — once that has passed —
 * destroying it on purpose, by hand, with a record of having done so.
 *
 * The period is the law's arithmetic, derived and never stored. In Austria
 * and Germany alike it starts at the END of the calendar year the document
 * belongs to and runs whole years from there:
 *
 *   BAO § 132 Abs. 1  — 7 years, "vom Schluß des Kalenderjahres, auf das sie
 *                       sich beziehen"
 *   UGB § 212         — 7 years, from the end of the calendar year (Abs. 2)
 *   HGB § 257 Abs. 4–5, AO § 147 Abs. 3–4
 *                     — 10 years (books, financial statements), 8 years
 *                       (accounting vouchers, since 2025), 6 years (business
 *                       letters), "mit dem Schluss des Kalenderjahrs"
 *
 * So a voucher dated 5 March 2026 under the Austrian 7 years is kept to
 * 31 December 2033 and may go from 1 January 2034. The texts are pinned in
 * test/retention.test.ts. Every one of those laws also extends the period
 * while the document matters to a pending proceeding — that is the legal
 * hold, which blocks disposal whatever the date says.
 */

export const RETENTION_PRESETS: { name: string; years: number; basis: string }[] = [
  { name: 'AT — books, records and vouchers', years: 7, basis: 'BAO § 132 Abs. 1; UGB § 212 Abs. 1–2' },
  { name: 'DE — books, inventories, financial statements', years: 10, basis: 'HGB § 257 Abs. 1 Nr. 1, Abs. 4–5; AO § 147 Abs. 1 Nr. 1, Abs. 3–4' },
  {
    name: 'DE — accounting vouchers',
    years: 8,
    basis: 'HGB § 257 Abs. 1 Nr. 4, Abs. 4–5; AO § 147 Abs. 1 Nr. 4, Abs. 3–4 (credit and insurance institutions: 10 years)',
  },
  { name: 'DE — business letters', years: 6, basis: 'HGB § 257 Abs. 1 Nr. 2–3, Abs. 4–5; AO § 147 Abs. 1 Nr. 2–3, Abs. 3–4' },
];

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function validDate(value: string): boolean {
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/** The last day a document must be kept: 31 December, `years` after its year. */
export function retentionEnd(documentDate: string, years: number): string {
  return `${Number(documentDate.slice(0, 4)) + years}-12-31`;
}

/** The first day it may be disposed of. */
export function dueFrom(documentDate: string, years: number): string {
  return `${Number(documentDate.slice(0, 4)) + years + 1}-01-01`;
}

/**
 * Today, as the last place on Earth to reach a new day sees it (UTC−12): a
 * document becomes due only once its first free day has begun everywhere —
 * never a few hours early because of where the server stands.
 */
export function todayFor(now: number): string {
  return new Date(now - 12 * 3600_000).toISOString().slice(0, 10);
}

interface DocRetentionRow {
  id: number;
  created_at: string;
  document_date: string | null;
  retention_class_id: number | null;
  legal_hold_reason: string | null;
  legal_hold_at: string | null;
  hold_by_name: string | null;
  class_name: string | null;
  years: number | null;
  basis: string | null;
}

function docRetentionRow(db: Database.Database, documentId: number): DocRetentionRow | undefined {
  return db
    .prepare(
      `SELECT d.id, d.created_at, d.document_date, d.retention_class_id, d.legal_hold_reason, d.legal_hold_at,
              hu.name AS hold_by_name, rc.name AS class_name, rc.years, rc.basis
       FROM documents d
       LEFT JOIN retention_classes rc ON rc.id = d.retention_class_id
       LEFT JOIN users hu ON hu.id = d.legal_hold_by
       WHERE d.id = ?`,
    )
    .get(documentId) as DocRetentionRow | undefined;
}

function infoOf(row: DocRetentionRow, now: number): RetentionInfo {
  const documentDate = row.document_date ?? row.created_at.slice(0, 10);
  const end = row.years !== null ? retentionEnd(documentDate, row.years) : null;
  const from = row.years !== null ? dueFrom(documentDate, row.years) : null;
  const hold = row.legal_hold_reason !== null ? { reason: row.legal_hold_reason, by_name: row.hold_by_name ?? '', at: row.legal_hold_at ?? '' } : null;
  return {
    class_id: row.retention_class_id,
    class_name: row.class_name,
    years: row.years,
    basis: row.basis,
    document_date: documentDate,
    document_date_set: row.document_date !== null,
    retention_end: end,
    due_from: from,
    due: from !== null && hold === null && todayFor(now) >= from,
    legal_hold: hold,
  };
}

/** A document's retention as its detail page shows it (access already checked). */
export function retentionInfo(db: Database.Database, documentId: number, now: number): RetentionInfo {
  return infoOf(docRetentionRow(db, documentId)!, now);
}

export function documentEvents(db: Database.Database, documentId: number): DocumentEvent[] {
  return db
    .prepare(
      `SELECT e.kind, e.detail, u.name AS actor_name, e.at FROM document_events e JOIN users u ON u.id = e.actor_id
       WHERE e.document_id = ? ORDER BY e.at DESC, e.id DESC`,
    )
    .all(documentId) as DocumentEvent[];
}

export function recordEvent(db: Database.Database, documentId: number, kind: DocumentEvent['kind'], detail: string, actor: AuthUser): void {
  db.prepare('INSERT INTO document_events (document_id, kind, detail, actor_id, at) VALUES (?, ?, ?, ?, ?)').run(documentId, kind, detail, actor.id, nowIso());
}

// ── Classes (administrators) ─────────────────────────────────────────────

export function listClasses(db: Database.Database): RetentionClass[] {
  return db
    .prepare(
      `SELECT rc.id, rc.name, rc.years, rc.basis, rc.created_at, rc.updated_at,
              (SELECT COUNT(*) FROM documents d WHERE d.retention_class_id = rc.id) AS document_count
       FROM retention_classes rc ORDER BY rc.name`,
    )
    .all() as RetentionClass[];
}

function classInput(raw: Record<string, unknown>): { name: string; years: number; basis: string } {
  const errors: { field: string; message: string }[] = [];
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name === '' || name.length > 120) errors.push({ field: 'name', message: 'name is required (max 120 characters)' });
  const years = Number(raw.years);
  if (!Number.isInteger(years) || years < 1 || years > 100) errors.push({ field: 'years', message: 'years must be a whole number from 1 to 100' });
  const basis = typeof raw.basis === 'string' ? raw.basis.trim() : '';
  if (basis.length > 500) errors.push({ field: 'basis', message: 'basis must be at most 500 characters' });
  if (errors.length > 0) throw new DomainError(422, 'Validation failed', errors);
  return { name, years, basis };
}

function nameTaken(db: Database.Database, name: string, except = 0): void {
  if (db.prepare('SELECT 1 FROM retention_classes WHERE name = ? AND id <> ?').get(name, except)) {
    throw new DomainError(422, 'Validation failed', [{ field: 'name', message: `"${name}" already exists` }]);
  }
}

export function createClass(db: Database.Database, user: AuthUser, raw: Record<string, unknown>): RetentionClass {
  const input = classInput(raw);
  nameTaken(db, input.name);
  const id = db
    .prepare('INSERT INTO retention_classes (name, years, basis, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(input.name, input.years, input.basis, user.id, nowIso()).lastInsertRowid as number;
  return listClasses(db).find((c) => c.id === id)!;
}

/** A changed period moves every due date with it — they are derived. */
export function updateClass(db: Database.Database, user: AuthUser, id: number, raw: Record<string, unknown>): RetentionClass {
  if (!db.prepare('SELECT 1 FROM retention_classes WHERE id = ?').get(id)) throw new DomainError(404, 'Retention class not found');
  const input = classInput(raw);
  nameTaken(db, input.name, id);
  db.prepare('UPDATE retention_classes SET name = ?, years = ?, basis = ?, updated_by = ?, updated_at = ? WHERE id = ?').run(input.name, input.years, input.basis, user.id, nowIso(), id);
  return listClasses(db).find((c) => c.id === id)!;
}

export function deleteClass(db: Database.Database, id: number): void {
  const cls = listClasses(db).find((c) => c.id === id);
  if (!cls) throw new DomainError(404, 'Retention class not found');
  const matters = (db.prepare('SELECT COUNT(*) AS n FROM matters WHERE retention_class_id = ?').get(id) as { n: number }).n;
  if (cls.document_count > 0 || matters > 0) throw new DomainError(409, `"${cls.name}" is still in use (${cls.document_count} documents, ${matters} matters)`);
  db.prepare('DELETE FROM retention_classes WHERE id = ?').run(id);
}

// ── On documents and matters (owners) ────────────────────────────────────

function classOrNull(db: Database.Database, raw: unknown): { id: number; name: string; years: number } | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const cls = db.prepare('SELECT id, name, years FROM retention_classes WHERE id = ?').get(Number(raw)) as { id: number; name: string; years: number } | undefined;
  if (!cls) throw new DomainError(422, 'Validation failed', [{ field: 'retention_class_id', message: 'unknown retention class' }]);
  return cls;
}

export function setDocumentRetention(db: Database.Database, user: AuthUser, documentId: number, raw: Record<string, unknown>, now: number): RetentionInfo {
  requireDocumentAccess(db, user, documentId, 'owner');
  const cls = classOrNull(db, raw.retention_class_id);
  const date = raw.document_date === null || raw.document_date === undefined || raw.document_date === '' ? null : String(raw.document_date);
  if (date !== null && !validDate(date)) throw new DomainError(422, 'Validation failed', [{ field: 'document_date', message: 'must be a date (YYYY-MM-DD)' }]);
  db.prepare('UPDATE documents SET retention_class_id = ?, document_date = ? WHERE id = ?').run(cls?.id ?? null, date, documentId);
  recordEvent(db, documentId, 'retention_set', cls ? `${cls.name} (${cls.years} years)${date ? `, dated ${date}` : ''}` : `No retention class${date ? `, dated ${date}` : ''}`, user);
  return retentionInfo(db, documentId, now);
}

export function setLegalHold(db: Database.Database, user: AuthUser, documentId: number, reasonRaw: unknown, now: number): RetentionInfo {
  const { document } = requireDocumentAccess(db, user, documentId, 'owner');
  const reason = typeof reasonRaw === 'string' ? reasonRaw.trim() : '';
  if (reason === '' || reason.length > 300) throw new DomainError(422, 'Validation failed', [{ field: 'reason', message: 'a reason is required (max 300 characters)' }]);
  if (docRetentionRow(db, document.id)!.legal_hold_reason !== null) throw new DomainError(409, 'The document is already on legal hold');
  db.prepare('UPDATE documents SET legal_hold_reason = ?, legal_hold_by = ?, legal_hold_at = ? WHERE id = ?').run(reason, user.id, nowIso(), documentId);
  recordEvent(db, documentId, 'hold_set', reason, user);
  return retentionInfo(db, documentId, now);
}

export function releaseLegalHold(db: Database.Database, user: AuthUser, documentId: number, now: number): RetentionInfo {
  requireDocumentAccess(db, user, documentId, 'owner');
  const row = docRetentionRow(db, documentId)!;
  if (row.legal_hold_reason === null) throw new DomainError(409, 'The document is not on legal hold');
  db.prepare('UPDATE documents SET legal_hold_reason = NULL, legal_hold_by = NULL, legal_hold_at = NULL WHERE id = ?').run(documentId);
  recordEvent(db, documentId, 'hold_released', row.legal_hold_reason, user);
  return retentionInfo(db, documentId, now);
}

/** The class a matter's NEW documents get; existing documents keep theirs. */
export function setMatterRetention(db: Database.Database, user: AuthUser, matterId: number, raw: unknown): void {
  requireMatterAccess(db, user, matterId, 'owner');
  const cls = classOrNull(db, raw);
  db.prepare('UPDATE matters SET retention_class_id = ? WHERE id = ?').run(cls?.id ?? null, matterId);
}

// ── Disposal (administrators) ────────────────────────────────────────────

interface DueRow extends DocRetentionRow {
  matter_id: number;
  matter_key: string;
  title: string;
  deleted_at: string | null;
  version_count: number;
  size_bytes: number;
}

/** Documents past their period and not on hold — soft-deleted ones included, their bytes are still here. */
export function listDue(db: Database.Database, now: number): DueDocument[] {
  const rows = db
    .prepare(
      `SELECT d.id, d.created_at, d.document_date, d.retention_class_id, d.legal_hold_reason, d.legal_hold_at,
              NULL AS hold_by_name, rc.name AS class_name, rc.years, rc.basis,
              d.matter_id, m.key AS matter_key, d.title, d.deleted_at,
              (SELECT COUNT(*) FROM document_versions v WHERE v.document_id = d.id) AS version_count,
              (SELECT COALESCE(SUM(size_bytes), 0) FROM document_versions v WHERE v.document_id = d.id) AS size_bytes
       FROM documents d JOIN retention_classes rc ON rc.id = d.retention_class_id JOIN matters m ON m.id = d.matter_id
       WHERE d.legal_hold_reason IS NULL
       ORDER BY d.id`,
    )
    .all() as DueRow[];
  return rows
    .map((r) => ({ r, info: infoOf(r, now) }))
    .filter(({ info }) => info.due)
    .map(({ r, info }) => ({
      id: r.id,
      matter_id: r.matter_id,
      matter_key: r.matter_key,
      title: r.title,
      deleted: r.deleted_at !== null,
      class_name: r.class_name!,
      years: r.years!,
      basis: r.basis ?? '',
      document_date: info.document_date,
      retention_end: info.retention_end!,
      due_from: info.due_from!,
      version_count: r.version_count,
      size_bytes: r.size_bytes,
    }));
}

export function listDisposals(db: Database.Database): Disposal[] {
  return (
    db
      .prepare(
        `SELECT x.id, x.document_id, m.key AS matter_key, x.retention_class, x.years, x.basis, x.document_date, x.retention_end,
                x.versions, x.bytes, x.files_removed, x.mirrors, u.name AS disposed_by_name, x.disposed_at
         FROM disposals x JOIN matters m ON m.id = x.matter_id JOIN users u ON u.id = x.disposed_by
         ORDER BY x.disposed_at DESC, x.id DESC`,
      )
      .all() as (Omit<Disposal, 'mirrors'> & { mirrors: string })[]
  ).map((d) => ({ ...d, mirrors: JSON.parse(d.mirrors) as Record<string, string> }));
}

/**
 * Destroy a document whose period has ended: every version, its bytes (a
 * file only when no other version still uses the same content), its text,
 * its search entry, its tags, links and history — and the copies in PS-06
 * and PS-09. What remains is the disposal record. Administrators only, and
 * only by hand: nothing here runs on a timer.
 */
export async function disposeDocument(db: Database.Database, storageDir: string, platform: PlatformHooks, user: AuthUser, documentId: number, now: number): Promise<Disposal> {
  const row = db.prepare('SELECT d.*, m.key AS matter_key FROM documents d JOIN matters m ON m.id = d.matter_id WHERE d.id = ?').get(documentId) as
    | { id: number; matter_id: number; matter_key: string }
    | undefined;
  if (!row) throw new DomainError(404, 'Document not found');
  const retention = docRetentionRow(db, documentId)!;
  const info = infoOf(retention, now);
  if (info.class_id === null) throw new DomainError(409, 'The document has no retention class, so it is never due for disposal');
  if (info.legal_hold) throw new DomainError(409, 'The document is on legal hold');
  if (!info.due) throw new DomainError(409, `The document must be kept until ${info.retention_end}; it may be disposed of from ${info.due_from}`);

  const versions = db.prepare('SELECT id, version_no, sha256, size_bytes, storage_path FROM document_versions WHERE document_id = ? ORDER BY version_no').all(documentId) as {
    id: number;
    version_no: number;
    sha256: string;
    size_bytes: number;
    storage_path: string;
  }[];
  // The copies outside first: if one cannot be reached, the record says so.
  const mirrors = await platform.documentRemoved(documentId, versions.map((v) => v.version_no));

  const unused: string[] = [];
  const disposalId = db.transaction(() => {
    db.prepare('DELETE FROM share_events WHERE link_id IN (SELECT id FROM share_links WHERE document_id = ?)').run(documentId);
    db.prepare('DELETE FROM share_links WHERE document_id = ?').run(documentId);
    db.prepare('DELETE FROM document_events WHERE document_id = ?').run(documentId);
    db.prepare('DELETE FROM version_text WHERE version_id IN (SELECT id FROM document_versions WHERE document_id = ?)').run(documentId);
    db.prepare('DELETE FROM document_tags WHERE document_id = ?').run(documentId);
    db.prepare('DELETE FROM document_search WHERE rowid = ?').run(documentId);
    db.prepare('DELETE FROM document_versions WHERE document_id = ?').run(documentId);
    db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
    for (const path of new Set(versions.map((v) => v.storage_path))) {
      if (!db.prepare('SELECT 1 FROM document_versions WHERE storage_path = ?').get(path)) unused.push(path);
    }
    return db
      .prepare(
        `INSERT INTO disposals (document_id, matter_id, retention_class, years, basis, document_date, retention_end, versions, bytes, sha256,
                                files_removed, mirrors, disposed_by, disposed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        documentId,
        row.matter_id,
        info.class_name,
        info.years,
        info.basis ?? '',
        info.document_date,
        info.retention_end,
        versions.length,
        versions.reduce((n, v) => n + v.size_bytes, 0),
        JSON.stringify(versions.map((v) => v.sha256)),
        unused.length,
        JSON.stringify(mirrors),
        user.id,
        nowIso(),
      ).lastInsertRowid as number;
  })();
  for (const path of unused) {
    try {
      unlinkSync(blobPath(storageDir, path));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[mod-09] could not remove a disposed file:', err);
    }
  }
  void platform.audit({ actor: `user:${user.id}`, action: 'document.disposed', resource: `document:${documentId}`, metadata: { class: info.class_name, retention_end: info.retention_end, versions: versions.length } });
  return listDisposals(db).find((d) => d.id === disposalId)!;
}
