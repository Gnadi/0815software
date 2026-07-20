import type { AuthConfig } from './auth.js';

export interface ServerConfig {
  port: number;
  databasePath: string;
  auth: AuthConfig;
}

/**
 * Read runtime configuration from the environment, with local-dev
 * defaults. Approval tiers and ERP export profiles are deliberately NOT
 * environment variables — they are declarative code config, in exactly
 * one file each: see ./approval-config.ts and ./export-profiles.ts.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT) || 3006,
    databasePath: env.DATABASE_PATH ?? './data.db',
    auth: {
      username: env.ADMIN_USERNAME ?? 'admin',
      password: env.ADMIN_PASSWORD ?? 'admin',
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: Number(env.SESSION_TTL_HOURS) || 12,
      secureCookie: env.COOKIE_SECURE === 'true',
    },
  };
}
