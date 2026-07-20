import type { AuthConfig } from './auth.js';

export interface ServerConfig {
  port: number;
  databasePath: string;
  auth: AuthConfig;
}

/**
 * Read runtime configuration from the environment, with local-dev
 * defaults. The status workflow and the SLA policy are deliberately NOT
 * environment variables — they are declarative code config, in exactly
 * one file each: see ./status-config.ts and ./sla-config.ts.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT) || 3012,
    databasePath: env.DATABASE_PATH ?? './data.db',
    auth: {
      username: env.ADMIN_USERNAME ?? 'agent',
      password: env.ADMIN_PASSWORD ?? 'agent',
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: Number(env.SESSION_TTL_HOURS) || 12,
      secureCookie: env.COOKIE_SECURE === 'true',
      intakeSecret: env.INTAKE_SECRET ?? 'dev-intake-secret',
    },
  };
}
