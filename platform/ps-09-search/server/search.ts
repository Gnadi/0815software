import type Database from 'better-sqlite3';
import { DomainError } from './errors.js';
import type { FacetCount, IndexDocInput, SearchHit, SearchResult } from '../shared/types.js';

const norm = (t: string | null | undefined): string => (t ?? '').trim();

/** Turn a user query into a safe FTS5 MATCH expression (prefix match per term). */
function ftsQuery(q: string): string | null {
  const terms = q.match(/[\p{L}\p{N}]+/gu);
  if (!terms || terms.length === 0) return null;
  return terms.map((t) => `${t}*`).join(' ');
}

/** Upsert a document into the index (delete-then-insert; FTS5 has no ON CONFLICT). */
export function indexDoc(db: Database.Database, input: IndexDocInput): void {
  const collection = norm(input.collection);
  const docId = norm(input.id);
  const tenant = norm(input.tenant);
  if (!collection || !docId) {
    throw new DomainError(422, 'Validation failed', [{ field: 'collection/id', message: 'are required' }]);
  }

  db.transaction(() => {
    const existing = db
      .prepare('SELECT rowid FROM search WHERE collection = ? AND doc_id = ? AND tenant = ?')
      .all(collection, docId, tenant) as { rowid: number }[];
    for (const row of existing) {
      db.prepare('DELETE FROM search WHERE rowid = ?').run(row.rowid);
      db.prepare('DELETE FROM facets WHERE rowid_ref = ?').run(row.rowid);
    }
    const info = db
      .prepare('INSERT INTO search (collection, doc_id, tenant, title, body) VALUES (?, ?, ?, ?, ?)')
      .run(collection, docId, tenant, norm(input.title), input.body ?? '');
    const rowid = Number(info.lastInsertRowid);
    for (const [key, value] of Object.entries(input.facets ?? {})) {
      db.prepare('INSERT INTO facets (rowid_ref, key, value) VALUES (?, ?, ?)').run(rowid, key, String(value));
    }
  })();
}

export function deleteDoc(db: Database.Database, collection: string, id: string, tenant?: string | null): boolean {
  const rows = db
    .prepare('SELECT rowid FROM search WHERE collection = ? AND doc_id = ? AND tenant = ?')
    .all(norm(collection), norm(id), norm(tenant)) as { rowid: number }[];
  for (const row of rows) {
    db.prepare('DELETE FROM search WHERE rowid = ?').run(row.rowid);
    db.prepare('DELETE FROM facets WHERE rowid_ref = ?').run(row.rowid);
  }
  return rows.length > 0;
}

export interface SearchOptions {
  collection: string;
  q: string;
  tenant?: string | null;
  filters?: { key: string; value: string }[];
  limit?: number;
  offset?: number;
}

export function search(db: Database.Database, opts: SearchOptions): SearchResult {
  const match = ftsQuery(opts.q);
  if (match === null) return { total: 0, hits: [], facets: [] };

  const params: Record<string, unknown> = {
    q: match,
    collection: norm(opts.collection),
    tenant: norm(opts.tenant),
  };
  const clauses = ['search MATCH @q', 'collection = @collection', 'tenant = @tenant'];
  (opts.filters ?? []).forEach((f, i) => {
    params[`fk${i}`] = f.key;
    params[`fv${i}`] = f.value;
    clauses.push(`search.rowid IN (SELECT rowid_ref FROM facets WHERE key = @fk${i} AND value = @fv${i})`);
  });
  const where = clauses.join(' AND ');

  const total = (db.prepare(`SELECT COUNT(*) AS n FROM search WHERE ${where}`).get(params) as { n: number }).n;

  // Clamp defensively: a caller inside the process may pass a value the route
  // validator never saw, and NaN slips through `Math.min`/`Math.max` unchanged
  // to reach SQLite as an unbindable parameter.
  const limit = Number.isInteger(opts.limit) ? Math.min(Math.max(1, opts.limit as number), 100) : 20;
  const offset = Number.isInteger(opts.offset) ? Math.max(0, opts.offset as number) : 0;
  const rows = db
    .prepare(
      `SELECT rowid, collection, doc_id, title,
              snippet(search, 4, '[', ']', '…', 12) AS snippet,
              bm25(search) AS score
       FROM search WHERE ${where}
       ORDER BY score LIMIT @limit OFFSET @offset`,
    )
    .all({ ...params, limit, offset }) as {
    rowid: number;
    collection: string;
    doc_id: string;
    title: string;
    snippet: string;
    score: number;
  }[];

  const hits: SearchHit[] = rows.map((r) => {
    const facetRows = db.prepare('SELECT key, value FROM facets WHERE rowid_ref = ?').all(r.rowid) as {
      key: string;
      value: string;
    }[];
    const facets: Record<string, string> = {};
    for (const f of facetRows) facets[f.key] = f.value;
    return {
      collection: r.collection,
      id: r.doc_id,
      title: r.title,
      // bm25 returns lower = better; expose a positive "higher is better" score.
      score: -r.score,
      snippet: r.snippet,
      facets,
    };
  });

  const facetRows = db
    .prepare(
      `SELECT key, value, COUNT(*) AS count FROM facets
       WHERE rowid_ref IN (SELECT rowid FROM search WHERE ${where})
       GROUP BY key, value ORDER BY count DESC, key, value LIMIT 50`,
    )
    .all(params) as FacetCount[];

  return { total, hits, facets: facetRows };
}
