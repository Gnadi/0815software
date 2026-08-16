import type { SessionConfig } from './auth.js';
import type { PlatformConfig } from './platform.js';

export interface ServerConfig {
  port: number;
  databasePath: string;
  storageDir: string;
  maxUploadBytes: number;
  session: SessionConfig;
  platform: PlatformConfig;
}

const DEFAULT_MAX_UPLOAD = 25 * 1024 * 1024; // 25 MiB

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

/** Read configuration from the environment, with local-dev defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: numberFromEnv('PORT', env.PORT, 3009, 1, 65535),
    databasePath: env.DATABASE_PATH ?? './data.db',
    storageDir: env.STORAGE_DIR ?? './storage',
    maxUploadBytes: numberFromEnv('MAX_UPLOAD_BYTES', env.MAX_UPLOAD_BYTES, DEFAULT_MAX_UPLOAD, 1, 2147483647),
    session: {
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: numberFromEnv('SESSION_TTL_HOURS', env.SESSION_TTL_HOURS, 12, 1, 8760),
      secureCookie: env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
    },
    platform: {
      filesUrl: env.FILES_URL || undefined,
      auditUrl: env.AUDIT_URL || undefined,
      searchUrl: env.SEARCH_URL || undefined,
      serviceToken: env.PLATFORM_SERVICE_TOKEN || undefined,
    },
  };
}
