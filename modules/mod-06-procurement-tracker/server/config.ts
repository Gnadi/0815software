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
      secureCookie: env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
    },
    sso: {
      identityUrl: env.IDENTITY_URL || undefined,
      identityOrg: env.IDENTITY_ORG || undefined,
      identityPermission: env.IDENTITY_PERMISSION || undefined,
    },
    platform: {
      auditUrl: env.AUDIT_URL || undefined,
      notificationUrl: env.NOTIFICATION_URL || undefined,
      // PS-11 Customers — when set, a supplier created here is registered with
      // the stack's party master data as a `supplier` party.
      customersUrl: env.CUSTOMERS_URL || undefined,
      serviceToken: env.PLATFORM_SERVICE_TOKEN || undefined,
    },
  };
}
