import { BaseClient } from './http.js';
import type { ChatInput, ChatResult, RagSearchInput } from './types.js';

/** Client for PS-04 AI Platform (default port 4004). */
export class AiClient extends BaseClient {
  chat(input: ChatInput): Promise<ChatResult> {
    return this.apiPost<ChatResult>('/api/chat/completions', input);
  }

  embed(input: { model?: string; input: string | string[] }): Promise<{ embeddings: number[][] }> {
    return this.apiPost('/api/embeddings', input);
  }

  ragSearch(input: RagSearchInput): Promise<{ matches: { text: string; score: number }[] }> {
    return this.apiPost('/api/rag/search', input);
  }

  ragIngest(collection: string, documents: { id?: string; text: string }[]): Promise<{ ingested: number }> {
    return this.apiPost('/api/rag/documents', { collection, documents });
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
