import type Database from 'better-sqlite3';
import type { ChatMessage, ChatResponse, ProviderName } from '../shared/types.js';
import { nowIso } from './auth.js';
import { DomainError } from './errors.js';
import { anthropicProvider } from './providers/anthropic.js';
import { mockProvider } from './providers/mock.js';
import { defaultFetch, type ChatProvider, type FetchLike } from './providers/index.js';
import { activeTemplate, renderMessages } from './prompts.js';

export interface ChatConfig {
  anthropicApiKey: string | null;
  anthropicModel: string;
  fetchImpl?: FetchLike;
}

/**
 * Provider selection: the real Anthropic adapter is used only when the
 * request asks for it AND a key is configured; otherwise everything falls
 * back to the deterministic mock provider.
 */
export function resolveChatProvider(
  requested: ProviderName | undefined,
  config: ChatConfig,
): { provider: ChatProvider; model: string } {
  if (requested === 'anthropic' && config.anthropicApiKey) {
    return {
      provider: anthropicProvider(config.anthropicApiKey, config.fetchImpl ?? defaultFetch),
      model: config.anthropicModel,
    };
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
  const usedModel = opts.model && provider.name === 'anthropic' ? opts.model : model;

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
