import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';
import { mockEmbed, MOCK_EMBED_DIMS } from './providers/mock.js';

/** Embeddings are always produced locally by the deterministic mock model. */
export const EMBED_MODEL = 'mock-embed-001';
export const EMBED_DIMS = MOCK_EMBED_DIMS;

function inputHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * Embed one string, caching by (model, input_hash) so repeat inputs never
 * recompute and always return the identical vector.
 */
export function embed(db: Database.Database, text: string, now = Date.now()): number[] {
  const hash = inputHash(text);
  const cached = db
    .prepare('SELECT vector FROM embeddings WHERE model = ? AND input_hash = ?')
    .get(EMBED_MODEL, hash) as { vector: string } | undefined;
  if (cached) return JSON.parse(cached.vector) as number[];

  const vector = mockEmbed(text);
  db.prepare(
    'INSERT OR IGNORE INTO embeddings (model, input_hash, input, dims, vector, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(EMBED_MODEL, hash, text, EMBED_DIMS, JSON.stringify(vector), nowIso(now));
  return vector;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
