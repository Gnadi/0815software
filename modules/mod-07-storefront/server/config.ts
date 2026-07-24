import type { AuthConfig } from './auth.js';
import type { PlatformConfig } from './platform.js';

export interface ServerConfig {
  port: number;
  databasePath: string;
  auth: AuthConfig;
  platform: PlatformConfig;
}

/** Read configuration from the environment, with local-dev defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT) || 3007,
    databasePath: env.DATABASE_PATH ?? './data.db',
    auth: {
      username: env.ADMIN_USERNAME ?? 'admin',
      password: env.ADMIN_PASSWORD ?? 'admin',
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: Number(env.SESSION_TTL_HOURS) || 12,
      secureCookie: env.COOKIE_SECURE === 'true',
    },
    // PS-08 Payments — optional; unset means standalone (orders placed unpaid).
    platform: {
      paymentsUrl: env.PAYMENTS_URL || undefined,
      serviceToken: env.PLATFORM_SERVICE_TOKEN || undefined,
    },
  };
}
