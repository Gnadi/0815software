import type { ChatMessage } from '../../shared/types.js';
import { approxTokens, type ChatProvider, type ChatResult, type FetchLike } from './index.js';

/**
 * Real Anthropic adapter — a single `fetch` to the Messages API, no SDK,
 * modelled on the marketing site's Resend integration. It is only ever
 * selected when ANTHROPIC_API_KEY is set and the request asks for the
 * "anthropic" provider; otherwise the resolver returns the mock provider.
 */
export function anthropicProvider(apiKey: string, fetchImpl: FetchLike): ChatProvider {
  return {
    name: 'anthropic',
    async chat(messages: ChatMessage[], model: string): Promise<ChatResult> {
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const turns = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: 1024, system: system || undefined, messages: turns }),
      });
      if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}`);

      const data = (await res.json()) as {
        content?: { type: string; text?: string }[];
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (data.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      return {
        text,
        usage: {
          prompt_tokens: data.usage?.input_tokens ?? approxTokens(JSON.stringify(messages)),
          completion_tokens: data.usage?.output_tokens ?? approxTokens(text),
        },
      };
    },
  };
}
