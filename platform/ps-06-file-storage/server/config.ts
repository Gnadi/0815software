import type { AuthConfig } from './auth.js';

export interface ServerConfig {
  port: number;
  databasePath: string;
  auth: AuthConfig;
  /** Secret used to sign time-limited download URLs. */
  signingSecret: string;
  /** Largest object accepted, in bytes (default 10 MiB). */
  maxObjectBytes: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT) || 4006,
    databasePath: env.DATABASE_PATH ?? './data.db',
    auth: {
      username: env.ADMIN_USERNAME ?? 'admin',
      password: env.ADMIN_PASSWORD ?? 'change-me',
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: Number(env.SESSION_TTL_HOURS) || 12,
      secureCookie: env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
      serviceToken: env.SERVICE_TOKEN ?? 'dev-service-token',
      identityUrl: env.IDENTITY_URL || undefined,
    },
    signingSecret: env.SIGNING_SECRET ?? env.SESSION_SECRET ?? 'dev-secret-change-me',
    maxObjectBytes: Number(env.MAX_OBJECT_BYTES) || 10 * 1024 * 1024,
  };
}
