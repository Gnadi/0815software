import type Database from 'better-sqlite3';
import type { ChatMessage, ChatResponse, ProviderName } from '../shared/types.js';
import { nowIso } from './auth.js';
import { DomainError } from './errors.js';
import { anthropicProvider } from './providers/anthropic.js';
import { openaiProvider } from './providers/openai.js';
import { geminiProvider } from './providers/gemini.js';
import { ollamaProvider } from './providers/ollama.js';
import { kimiProvider } from './providers/kimi.js';
import { mockProvider } from './providers/mock.js';
import { defaultFetch, type ChatProvider, type FetchLike } from './providers/index.js';
import { withRetry } from './retry-fetch.js';
import { activeTemplate, renderMessages } from './prompts.js';

export interface ChatConfig {
  anthropicApiKey: string | null;
  anthropicModel: string;
  openaiApiKey: string | null;
  openaiModel: string;
  geminiApiKey: string | null;
  geminiModel: string;
  ollamaBaseUrl: string | null;
  ollamaModel: string;
  kimiApiKey: string | null;
  kimiModel: string;
  kimiBaseUrl: string;
  fetchImpl?: FetchLike;
}

/**
 * Provider selection: a real vendor adapter is used only when the request
 * asks for it AND that vendor is configured (an API key, or a base URL for
 * the keyless open-source Ollama). Anything else — including an unconfigured
 * vendor — falls back to the deterministic mock provider.
 */
export function resolveChatProvider(
  requested: ProviderName | undefined,
  config: ChatConfig,
): { provider: ChatProvider; model: string } {
  const fetchImpl = config.fetchImpl ?? withRetry(defaultFetch);
  switch (requested) {
    case 'anthropic':
      if (config.anthropicApiKey) return { provider: anthropicProvider(config.anthropicApiKey, fetchImpl), model: config.anthropicModel };
      break;
    case 'openai':
      if (config.openaiApiKey) return { provider: openaiProvider(config.openaiApiKey, fetchImpl), model: config.openaiModel };
      break;
    case 'gemini':
      if (config.geminiApiKey) return { provider: geminiProvider(config.geminiApiKey, fetchImpl), model: config.geminiModel };
      break;
    case 'ollama':
      if (config.ollamaBaseUrl) return { provider: ollamaProvider(config.ollamaBaseUrl, fetchImpl), model: config.ollamaModel };
      break;
    case 'kimi':
      if (config.kimiApiKey) return { provider: kimiProvider(config.kimiApiKey, config.kimiBaseUrl, fetchImpl), model: config.kimiModel };
      break;
    default:
      break;
  }
  return { provider: mockProvider, model: 'mock-chat-001' };
}

export interface RunChatOptions {
  messages?: ChatMessage[];
  promptKey?: string;
  variables?: Record<string, unknown>;
  provider?: ProviderName;
  model?: string;
  idempotencyKey?: string | null;
  now?: number;
}

interface CompletionRow {
  id: number;
  provider: string;
  model: string;
  response: string;
  prompt_tokens: number;
  completion_tokens: number;
}

/** Resolve messages, call the provider, and log the completion. */
export async function runChat(db: Database.Database, config: ChatConfig, opts: RunChatOptions): Promise<ChatResponse> {
  const now = opts.now ?? Date.now();
  const idempotencyKey = opts.idempotencyKey ?? null;

  if (idempotencyKey !== null) {
    const existing = db
      .prepare('SELECT * FROM completions WHERE idempotency_key = ?')
      .get(idempotencyKey) as CompletionRow | undefined;
    if (existing) {
      return {
        id: existing.id,
        provider: existing.provider as ProviderName,
        model: existing.model,
        text: existing.response,
        usage: { prompt_tokens: existing.prompt_tokens, completion_tokens: existing.completion_tokens },
      };
    }
  }

  let messages: ChatMessage[];
  if (opts.promptKey) {
    messages = renderMessages(activeTemplate(db, opts.promptKey), opts.variables ?? {});
  } else if (Array.isArray(opts.messages) && opts.messages.length > 0) {
    messages = opts.messages;
  } else {
    throw new DomainError(422, 'Either messages or prompt_key is required');
  }

  const { provider, model } = resolveChatProvider(opts.provider, config);
  // A caller-supplied model overrides the default for any real vendor; the
  // mock provider always reports its own fixed model id.
  const usedModel = opts.model && provider.name !== 'mock' ? opts.model : model;

  const started = Date.now();
  const result = await provider.chat(messages, usedModel);
  const latency = Date.now() - started;

  const info = db
    .prepare(
      `INSERT INTO completions
         (provider, model, prompt_key, request, response, prompt_tokens, completion_tokens, latency_ms, idempotency_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      provider.name,
      usedModel,
      opts.promptKey ?? null,
      JSON.stringify(messages),
      result.text,
      result.usage.prompt_tokens,
      result.usage.completion_tokens,
      latency,
      idempotencyKey,
      nowIso(now),
    );

  return {
    id: Number(info.lastInsertRowid),
    provider: provider.name,
    model: usedModel,
    text: result.text,
    usage: result.usage,
  };
}
