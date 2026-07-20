import type { SessionConfig } from './auth.js';

export interface ServerConfig {
  port: number;
  databasePath: string;
  storageDir: string;
  maxUploadBytes: number;
  session: SessionConfig;
}

const DEFAULT_MAX_UPLOAD = 25 * 1024 * 1024; // 25 MiB

/** Read configuration from the environment, with local-dev defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT) || 3009,
    databasePath: env.DATABASE_PATH ?? './data.db',
    storageDir: env.STORAGE_DIR ?? './storage',
    maxUploadBytes: Number(env.MAX_UPLOAD_BYTES) || DEFAULT_MAX_UPLOAD,
    session: {
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: Number(env.SESSION_TTL_HOURS) || 12,
      secureCookie: env.COOKIE_SECURE === 'true',
    },
  };
}
