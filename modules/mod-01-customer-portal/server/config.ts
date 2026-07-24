import type { SessionConfig } from './auth.js';
import type { PlatformConfig } from './platform.js';

export interface ServerConfig {
  port: number;
  databasePath: string;
  documentsDir: string;
  session: SessionConfig;
  platform: PlatformConfig;
}

/** Read configuration from the environment, with local-dev defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT) || 3001,
    databasePath: env.DATABASE_PATH ?? './data.db',
    documentsDir: env.DOCUMENTS_DIR ?? './documents',
    session: {
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: Number(env.SESSION_TTL_HOURS) || 12,
      secureCookie: env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
    },
    platform: {
      auditUrl: env.AUDIT_URL || undefined,
      serviceToken: env.PLATFORM_SERVICE_TOKEN || undefined,
    },
  };
}
