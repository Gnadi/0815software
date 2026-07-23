import type { ChatMessage } from '../../shared/types.js';
import { approxTokens, type ChatProvider, type ChatResult, type FetchLike } from './index.js';

/**
 * Ollama adapter — the open-source option. Ollama is MIT-licensed software
 * that runs open-weight models (Llama, Mistral, Gemma, Qwen, …) locally, so
 * this needs no API key: it is selected when OLLAMA_BASE_URL is configured
 * (e.g. http://localhost:11434) and the request asks for "ollama".
 * Otherwise the resolver falls back to the mock provider.
 */
export function ollamaProvider(baseUrl: string, fetchImpl: FetchLike): ChatProvider {
  return {
    name: 'ollama',
    async chat(messages: ChatMessage[], model: string): Promise<ChatResult> {
      const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: messages.map((m) => ({ role: m.role, content: m.content })),
          stream: false,
        }),
      });
      if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);

      const data = (await res.json()) as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      const text = data.message?.content ?? '';
      return {
        text,
        usage: {
          prompt_tokens: data.prompt_eval_count ?? approxTokens(JSON.stringify(messages)),
          completion_tokens: data.eval_count ?? approxTokens(text),
        },
      };
    },
  };
}
