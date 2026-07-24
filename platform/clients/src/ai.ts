import { BaseClient } from './http.js';
import type { ChatInput, ChatResult, EmbedResult, RagResult, RagSearchInput } from './types.js';

/** Client for PS-04 AI Platform (default port 4004). */
export class AiClient extends BaseClient {
  chat(input: ChatInput): Promise<ChatResult> {
    return this.apiPost<ChatResult>('/api/chat/completions', input);
  }

  embed(input: { provider?: string; input: string | string[] }): Promise<EmbedResult> {
    return this.apiPost<EmbedResult>('/api/embeddings', input);
  }

  ragSearch(input: RagSearchInput): Promise<{ results: RagResult[] }> {
    return this.apiPost('/api/rag/search', input);
  }

  /** Ingest a single document into a collection; returns its assigned id. */
  ragIngest(collection: string, text: string): Promise<{ id: number }> {
    return this.apiPost('/api/rag/documents', { collection, text });
  }

  /** Run a bounded agent loop over a prompt template. */
  runAgent(input: { prompt_key?: string; goal: string; variables?: Record<string, unknown>; max_steps?: number }): Promise<{
    id: string;
    output: string;
    steps: number;
  }> {
    return this.apiPost('/api/agents/run', input);
  }
}
