import type { ChatMessage } from '../../shared/types.js';
import { approxTokens, type ChatProvider, type ChatResult, type FetchLike } from './index.js';

/**
 * Kimi (Moonshot AI) adapter. Moonshot's API is OpenAI-compatible, so this
 * is a single `fetch` to its `/chat/completions` endpoint at a configurable
 * base URL. Selected only when KIMI_API_KEY is set and the request asks for
 * the "kimi" provider; otherwise the resolver returns the mock provider.
 */
export function kimiProvider(apiKey: string, baseUrl: string, fetchImpl: FetchLike): ChatProvider {
  return {
    name: 'kimi',
    async chat(messages: ChatMessage[], model: string): Promise<ChatResult> {
      const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages: messages.map((m) => ({ role: m.role, content: m.content })) }),
      });
      if (!res.ok) throw new Error(`Kimi HTTP ${res.status}`);

      const data = (await res.json()) as {
        choices?: { message?: { content?: string } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = data.choices?.[0]?.message?.content ?? '';
      return {
        text,
        usage: {
          prompt_tokens: data.usage?.prompt_tokens ?? approxTokens(JSON.stringify(messages)),
          completion_tokens: data.usage?.completion_tokens ?? approxTokens(text),
        },
      };
    },
  };
}
