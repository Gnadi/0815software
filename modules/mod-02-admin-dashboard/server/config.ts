import type { AuthConfig } from './auth.js';
import type { PlatformConfig } from './platform.js';
import type { SsoConfig } from './sso.js';

export interface ServerConfig {
  port: number;
  databasePath: string;
  auth: AuthConfig;
  platform: PlatformConfig;
  sso: SsoConfig;
}

/** Read configuration from the environment, with local-dev defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT) || 3002,
    databasePath: env.DATABASE_PATH ?? './data.db',
    auth: {
      username: env.ADMIN_USERNAME ?? 'admin',
      password: env.ADMIN_PASSWORD ?? 'admin',
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: Number(env.SESSION_TTL_HOURS) || 12,
      secureCookie: env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
    },
    sso: {
      identityUrl: env.IDENTITY_URL || undefined,
      identityOrg: env.IDENTITY_ORG || undefined,
      identityPermission: env.IDENTITY_PERMISSION || undefined,
    },
    platform: {
      auditUrl: env.AUDIT_URL || undefined,
      serviceToken: env.PLATFORM_SERVICE_TOKEN || undefined,
    },
  };
}
