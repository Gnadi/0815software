/**
 * PS-04 AI Platform — wire contract shared between server and client.
 */

export const PROVIDERS = ['mock', 'anthropic'] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export const AI_CAPABILITIES = ['chat', 'embeddings', 'rag', 'agents', 'images', 'speech'] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];

export const CHAT_ROLES = ['system', 'user', 'assistant'] as const;
export type ChatRole = (typeof CHAT_ROLES)[number];

export function isProvider(v: string): v is ProviderName {
  return (PROVIDERS as readonly string[]).includes(v);
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

export interface ChatRequest {
  model?: string;
  provider?: ProviderName;
  messages?: ChatMessage[];
  prompt_key?: string;
  variables?: Record<string, unknown>;
}

export interface ChatResponse {
  id: number;
  provider: ProviderName;
  model: string;
  text: string;
  usage: Usage;
}

export interface EmbeddingResponse {
  model: string;
  dims: number;
  vectors: number[][];
  usage: Usage;
}

export interface Prompt {
  id: number;
  key: string;
  name: string;
  active_version: number;
  versions: number[];
}

export interface PromptVersion {
  version: number;
  template: ChatMessage[];
  notes: string | null;
  created_at: string;
}

export interface RagResult {
  id: number;
  text: string;
  score: number;
}

export interface FieldError {
  field: string;
  message: string;
}
