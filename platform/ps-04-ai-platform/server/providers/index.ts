import type { ChatMessage, ProviderName, Usage } from '../../shared/types.js';

export interface ChatResult {
  text: string;
  usage: Usage;
}

export interface ChatProvider {
  name: ProviderName;
  chat(messages: ChatMessage[], model: string): Promise<ChatResult>;
}

/** Injectable HTTP client (returns the parsed JSON body) so tests stay offline. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export const defaultFetch: FetchLike = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, json: () => res.json() };
};

/** Rough token estimate — deterministic, provider-agnostic (~4 chars/token). */
export function approxTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
