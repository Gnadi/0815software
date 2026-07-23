import type { AuthConfig } from './auth.js';

export interface ServerConfig {
  port: number;
  databasePath: string;
  auth: AuthConfig;
  /** When set, email channels use the real Resend provider; otherwise console. */
  resendApiKey: string | null;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT) || 4003,
    databasePath: env.DATABASE_PATH ?? './data.db',
    auth: {
      username: env.ADMIN_USERNAME ?? 'admin',
      password: env.ADMIN_PASSWORD ?? 'change-me',
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: Number(env.SESSION_TTL_HOURS) || 12,
      secureCookie: env.COOKIE_SECURE === 'true',
      serviceToken: env.SERVICE_TOKEN ?? 'dev-service-token',
    },
    resendApiKey: env.RESEND_API_KEY ?? null,
  };
}
