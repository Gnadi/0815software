import type { AuthConfig } from './auth.js';
import type { PlatformConfig } from './platform.js';

export interface ServerConfig {
  port: number;
  /** The module's OWN metadata db (reports, charts, schedules, runs). */
  databasePath: string;
  /**
   * The database to report ON. Opened read-only. When unset, the seed
   * generates a demo source db at ./source.db so the app works out of
   * the box; when set to a missing file the server refuses to start.
   */
  sourceDbPath: string;
  /** True when sourceDbPath came from the environment (must exist). */
  sourceDbExplicit: boolean;
  exportsDir: string;
  schedulerTickSeconds: number;
  auth: AuthConfig;
  platform: PlatformConfig;
}

const DEFAULT_SOURCE_DB = './source.db';

/**
 * Read runtime configuration from the environment, with local-dev
 * defaults. The query row cap / time limit are NOT env vars — they are
 * declarative code config in ./query-policy.ts.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const sourceDbExplicit = typeof env.SOURCE_DB_PATH === 'string' && env.SOURCE_DB_PATH !== '';
  return {
    port: Number(env.PORT) || 3008,
    databasePath: env.DATABASE_PATH ?? './data.db',
    sourceDbPath: sourceDbExplicit ? env.SOURCE_DB_PATH! : DEFAULT_SOURCE_DB,
    sourceDbExplicit,
    exportsDir: env.EXPORTS_DIR ?? './exports',
    schedulerTickSeconds: Number(env.SCHEDULER_TICK_SECONDS) || 60,
    auth: {
      username: env.ADMIN_USERNAME ?? 'admin',
      password: env.ADMIN_PASSWORD ?? 'admin',
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
