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

/**
 * Read a numeric setting, refusing a value that is not one.
 *
 * The old shape was `Number(raw) || fallback`, and it is silent in the two
 * ways that cost you a deployment. `PORT=808O` — a letter O — is NaN and
 * became the DEFAULT port: the service starts, reports itself healthy, and is
 * unreachable, because the compose port mapping, the reverse proxy and the
 * healthcheck all point at the 8080 nobody is listening on. Nothing in the
 * logs mentions the typo. `SESSION_TTL_HOURS=-1` is a perfectly good number
 * and minted sessions that had already expired, so every login succeeded and
 * every request after it returned 401.
 *
 * A blank value still means "unset" — that is what an uninterpolated compose
 * variable yields, and falling back is the right answer for it. Anything else
 * must parse and be in range, or the process refuses to start while a human is
 * still watching the logs. Same posture as `guard.ts` takes on secrets.
 */
function numberFromEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max} — got ${JSON.stringify(raw)}`);
  }
  return value;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: numberFromEnv('PORT', env.PORT, 4004, 1, 65535),
    databasePath: env.DATABASE_PATH ?? './data.db',
    auth: {
      username: env.ADMIN_USERNAME ?? 'admin',
      password: env.ADMIN_PASSWORD ?? 'change-me',
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: numberFromEnv('SESSION_TTL_HOURS', env.SESSION_TTL_HOURS, 12, 1, 8760),
      secureCookie: env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
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
