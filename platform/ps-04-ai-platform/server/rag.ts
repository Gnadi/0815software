import type Database from 'better-sqlite3';
import type { RagResult } from '../shared/types.js';
import { nowIso } from './auth.js';
import { cosine, embed } from './embeddings.js';

/** Ingest a document into a collection, embedding it for later search. */
export function ingestDocument(db: Database.Database, collection: string, text: string, now = Date.now()): number {
  const vector = embed(db, text, now);
  const info = db
    .prepare('INSERT INTO rag_documents (collection, text, embedding, created_at) VALUES (?, ?, ?, ?)')
    .run(collection, text, JSON.stringify(vector), nowIso(now));
  return Number(info.lastInsertRowid);
}

interface DocRow {
  id: number;
  text: string;
  embedding: string;
}

/** Top-k documents in a collection by cosine similarity to the query. */
export function search(db: Database.Database, collection: string, query: string, k: number, now = Date.now()): RagResult[] {
  const queryVec = embed(db, query, now);
  const docs = db.prepare('SELECT id, text, embedding FROM rag_documents WHERE collection = ?').all(collection) as DocRow[];
  return docs
    .map((d) => ({ id: d.id, text: d.text, score: cosine(queryVec, JSON.parse(d.embedding) as number[]) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, k));
}
