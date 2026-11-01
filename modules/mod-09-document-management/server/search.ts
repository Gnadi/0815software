import { existsSync, readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { EXTRACTOR_VERSION, extract, type Extracted } from './extract.js';
import { blobPath } from './storage.js';

/**
 * The text behind full-text search and the text preview, kept in step with
 * the documents.
 *
 * `version_text` holds what was read out of each version's bytes;
 * `document_search` (FTS5) holds one row per live document — its title, the
 * CURRENT version's text and its tags — and is rebuilt from those rows
 * whenever one of them changes. Neither decides who may see what: the search
 * query lives in docs.ts, behind the same matter check as every other read.
 */

const nowIso = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Read a version's text and store it; returns what was read. */
export function storeVersionText(db: Database.Database, versionId: number, bytes: Buffer, contentType: string, filename: string): Extracted {
  const result = extract(bytes, contentType, filename);
  db.prepare(
    `INSERT INTO version_text (version_id, format, preview, status, text, extractor, extracted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (version_id) DO UPDATE SET format = excluded.format, preview = excluded.preview,
       status = excluded.status, text = excluded.text, extractor = excluded.extractor, extracted_at = excluded.extracted_at`,
  ).run(versionId, result.format, result.preview, result.status, result.text, EXTRACTOR_VERSION, nowIso());
  return result;
}

/** Bring one document's search row in line with its title, current text and tags. */
export function reindexDocument(db: Database.Database, documentId: number): void {
  db.prepare('DELETE FROM document_search WHERE rowid = ?').run(documentId);
  const doc = db.prepare('SELECT title FROM documents WHERE id = ? AND deleted_at IS NULL').get(documentId) as { title: string } | undefined;
  if (!doc) return;
  const body = db
    .prepare(
      `SELECT t.text FROM document_versions v JOIN version_text t ON t.version_id = v.id
       WHERE v.document_id = ? ORDER BY v.version_no DESC LIMIT 1`,
    )
    .get(documentId) as { text: string } | undefined;
  const tags = (db.prepare('SELECT tag FROM document_tags WHERE document_id = ? ORDER BY tag').all(documentId) as { tag: string }[]).map((t) => t.tag);
  db.prepare('INSERT INTO document_search (rowid, title, body, tags) VALUES (?, ?, ?, ?)').run(documentId, doc.title, body?.text ?? '', tags.join(' '));
}

/**
 * Read every version that has no text yet (or was read by an older reader),
 * then rebuild the search index. `all` re-reads everything — the admin's
 * "Re-index". Missing files are counted, not fatal: the index still covers
 * the rest.
 */
export function refreshText(db: Database.Database, storageDir: string, opts: { all?: boolean } = {}): { read: number; missing: number } {
  const versions = db
    .prepare(
      `SELECT v.id, v.storage_path, v.content_type, v.filename FROM document_versions v
       LEFT JOIN version_text t ON t.version_id = v.id
       ${opts.all ? '' : 'WHERE t.version_id IS NULL OR t.extractor < ?'}
       ORDER BY v.id`,
    )
    .all(...(opts.all ? [] : [EXTRACTOR_VERSION])) as { id: number; storage_path: string; content_type: string; filename: string }[];
  let read = 0;
  let missing = 0;
  for (const v of versions) {
    const path = blobPath(storageDir, v.storage_path);
    if (!existsSync(path)) {
      missing++;
      continue;
    }
    storeVersionText(db, v.id, readFileSync(path), v.content_type, v.filename);
    read++;
  }
  rebuildIndex(db);
  return { read, missing };
}

export function rebuildIndex(db: Database.Database): void {
  db.transaction(() => {
    db.exec('DELETE FROM document_search');
    for (const { id } of db.prepare('SELECT id FROM documents WHERE deleted_at IS NULL').all() as { id: number }[]) reindexDocument(db, id);
  })();
}

/**
 * A person's words as an FTS5 query: each word a prefix term, "quoted text"
 * a phrase, all of them required. Nothing they type reaches FTS5's own
 * syntax — `NEAR`, `-`, `*` and stray quotes are just characters.
 */
export function ftsQuery(input: string): string | null {
  const parts: string[] = [];
  const phrases = input.normalize('NFKC').replace(/"([^"]*)"/g, (_, phrase: string) => {
    const words = phrase.match(/[\p{L}\p{N}]+/gu);
    if (words) parts.push(`"${words.join(' ')}"`);
    return ' ';
  });
  for (const word of phrases.match(/[\p{L}\p{N}]+/gu) ?? []) parts.push(`"${word}"*`);
  return parts.length > 0 ? parts.slice(0, 16).join(' AND ') : null;
}

/** Marks around a match in a snippet: control characters no document text carries. */
export const MATCH_START = '\u0002';
export const MATCH_END = '\u0003';
