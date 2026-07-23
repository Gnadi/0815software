import type { ChatMessage } from '../../shared/types.js';
import { approxTokens, type ChatProvider, type ChatResult, type FetchLike } from './index.js';

/**
 * Google Gemini adapter — a single `fetch` to the Generative Language API,
 * no SDK. Gemini uses `model` roles and a separate systemInstruction, so
 * the adapter maps the neutral ChatMessage[] into that shape. Selected only
 * when GEMINI_API_KEY is set and the request asks for the "gemini" provider.
 */
export function geminiProvider(apiKey: string, fetchImpl: FetchLike): ChatProvider {
  return {
    name: 'gemini',
    async chat(messages: ChatMessage[], model: string): Promise<ChatResult> {
      const system = messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const contents = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      const body = {
        contents,
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      };

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);

      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      return {
        text,
        usage: {
          prompt_tokens: data.usageMetadata?.promptTokenCount ?? approxTokens(JSON.stringify(messages)),
          completion_tokens: data.usageMetadata?.candidatesTokenCount ?? approxTokens(text),
        },
      };
    },
  };
}
