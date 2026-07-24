import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { nowIso } from './auth.js';
import { mockEmbed, MOCK_EMBED_DIMS } from './providers/mock.js';
import type { FetchLike } from './providers/index.js';

/** The default embedding model: deterministic, produced locally (mock). */
export const EMBED_MODEL = 'mock-embed-001';
export const EMBED_DIMS = MOCK_EMBED_DIMS;

function inputHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * An optional real embedding vendor. RAG and the default embeddings path stay
 * on the deterministic local mock; a vendor is used only when configured and
 * requested by name on `POST /api/embeddings`.
 */
export interface EmbedProvider {
  model: string;
  dims: number;
  embed(text: string): Promise<number[]>;
}

/** OpenAI embeddings adapter — a single `fetch`, no SDK. */
export function openaiEmbedProvider(apiKey: string, model: string, fetchImpl: FetchLike): EmbedProvider {
  return {
    model,
    dims: 0, // reported per-response by the vendor
    async embed(text: string): Promise<number[]> {
      const res = await fetchImpl('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, input: text }),
      });
      if (!res.ok) throw new Error(`embeddings failed (${res.status})`);
      const data = (await res.json()) as { data?: { embedding: number[] }[] };
      return data.data?.[0]?.embedding ?? [];
    },
  };
}

/** Embed via a real vendor, caching by (model, input_hash) like the mock path. */
export async function embedVendor(
  db: Database.Database,
  provider: EmbedProvider,
  text: string,
  now = Date.now(),
): Promise<number[]> {
  const hash = inputHash(text);
  const cached = db
    .prepare('SELECT vector FROM embeddings WHERE model = ? AND input_hash = ?')
    .get(provider.model, hash) as { vector: string } | undefined;
  if (cached) return JSON.parse(cached.vector) as number[];

  const vector = await provider.embed(text);
  db.prepare(
    'INSERT OR IGNORE INTO embeddings (model, input_hash, input, dims, vector, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(provider.model, hash, text, vector.length, JSON.stringify(vector), nowIso(now));
  return vector;
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
