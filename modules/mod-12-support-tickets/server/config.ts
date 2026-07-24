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
      secureCookie: env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
      intakeSecret: env.INTAKE_SECRET ?? 'dev-intake-secret',
    },
    // Platform Services — all optional; unset means standalone (no calls out).
    sso: {
      identityUrl: env.IDENTITY_URL || undefined,
      identityOrg: env.IDENTITY_ORG || undefined,
      identityPermission: env.IDENTITY_PERMISSION || undefined,
    },
    platform: {
      notificationUrl: env.NOTIFICATION_URL || undefined,
      auditUrl: env.AUDIT_URL || undefined,
      aiUrl: env.AI_URL || undefined,
      serviceToken: env.PLATFORM_SERVICE_TOKEN || undefined,
      ackChannel: env.NOTIFICATION_ACK_CHANNEL || undefined,
    },
  };
}
