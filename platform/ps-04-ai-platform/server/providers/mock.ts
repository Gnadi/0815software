import { createHash } from 'node:crypto';
import type { ChatMessage } from '../../shared/types.js';
import { approxTokens, type ChatProvider, type ChatResult } from './index.js';

/**
 * The default provider: fully deterministic, zero external calls. The same
 * input always yields byte-identical output, which makes chat, embeddings
 * and RAG testable offline and reproducible in CI.
 */

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function mockChat(messages: ChatMessage[], model: string): ChatResult {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const digest = sha(JSON.stringify(messages)).slice(0, 12);
  const prompt = lastUser ? lastUser.content.slice(0, 120) : '';
  const text = `[mock:${model}] Reply to "${prompt}" (${digest})`;
  const promptTokens = messages.reduce((n, m) => n + approxTokens(m.content), 0);
  return { text, usage: { prompt_tokens: promptTokens, completion_tokens: approxTokens(text) } };
}

export const MOCK_EMBED_DIMS = 16;

/**
 * A deterministic pseudo-embedding: each dimension is derived from a hash
 * of the input and the dimension index, then the vector is L2-normalized.
 * Identical text always produces the identical vector.
 */
export function mockEmbed(text: string): number[] {
  const raw: number[] = [];
  for (let i = 0; i < MOCK_EMBED_DIMS; i++) {
    const h = createHash('sha256').update(`${text}:${i}`).digest();
    // Map the first 4 bytes to a float in [-1, 1].
    const n = h.readUInt32BE(0) / 0xffffffff;
    raw.push(n * 2 - 1);
  }
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1;
  return raw.map((v) => v / norm);
}

export const mockProvider: ChatProvider = {
  name: 'mock',
  async chat(messages, model) {
    return mockChat(messages, model);
  },
};
