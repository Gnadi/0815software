import type { AuthConfig } from './auth.js';

export interface ServerConfig {
  port: number;
  databasePath: string;
  auth: AuthConfig;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT) || 4009,
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
  };
}
