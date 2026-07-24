import type { AuthConfig } from './auth.js';

export interface ServerConfig {
  port: number;
  databasePath: string;
  auth: AuthConfig;
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
  /** Optional real vendor for images / speech / embeddings (OpenAI). */
  imageModel: string;
  speechModel: string;
  embedModel: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT) || 4004,
    databasePath: env.DATABASE_PATH ?? './data.db',
    auth: {
      username: env.ADMIN_USERNAME ?? 'admin',
      password: env.ADMIN_PASSWORD ?? 'change-me',
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: Number(env.SESSION_TTL_HOURS) || 12,
      secureCookie: env.COOKIE_SECURE === 'true',
      serviceToken: env.SERVICE_TOKEN ?? 'dev-service-token',
      identityUrl: env.IDENTITY_URL || undefined,
    },
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? null,
    anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-sonnet-5',
    openaiApiKey: env.OPENAI_API_KEY ?? null,
    openaiModel: env.OPENAI_MODEL ?? 'gpt-4o-mini',
    geminiApiKey: env.GEMINI_API_KEY ?? null,
    geminiModel: env.GEMINI_MODEL ?? 'gemini-1.5-flash',
    // Ollama needs no key — a configured base URL is the "enabled" signal.
    ollamaBaseUrl: env.OLLAMA_BASE_URL ?? null,
    ollamaModel: env.OLLAMA_MODEL ?? 'llama3.1',
    // Kimi (Moonshot AI) — OpenAI-compatible, base URL configurable.
    kimiApiKey: env.KIMI_API_KEY ?? null,
    kimiModel: env.KIMI_MODEL ?? 'moonshot-v1-8k',
    kimiBaseUrl: env.KIMI_BASE_URL ?? 'https://api.moonshot.ai/v1',
    imageModel: env.OPENAI_IMAGE_MODEL ?? 'gpt-image-1',
    speechModel: env.OPENAI_SPEECH_MODEL ?? 'whisper-1',
    embedModel: env.OPENAI_EMBED_MODEL ?? 'text-embedding-3-small',
  };
}
