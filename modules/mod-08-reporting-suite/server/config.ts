import type { AuthConfig } from './auth.js';
import type { PlatformConfig } from './platform.js';
import type { SsoConfig } from './sso.js';

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
  /**
   * Restrict every report to the source's published `report_*` views — the
   * reporting contract (docs/REPORTING-CONTRACT.md). OFF by default: pointed
   * at an arbitrary customer database there is no contract to hold anyone to,
   * and the whole schema is exactly what an author wants. Turn it on when the
   * source is a module that publishes a set.
   */
  sourceViewsOnly: boolean;
  exportsDir: string;
  schedulerTickSeconds: number;
  auth: AuthConfig;
  platform: PlatformConfig;
  sso: SsoConfig;
}

const DEFAULT_SOURCE_DB = './source.db';

/**
 * Read a numeric setting, refusing a value that is not one.
 *
 * The old shape was `Number(raw) || fallback`, and it is silent in the two
 * ways that cost you a deployment. `PORT=808O` — a letter O — is NaN and
 * became the DEFAULT port: the service starts, reports itself healthy, and is
 * unreachable, because the compose port mapping, the reverse proxy and the
 * healthcheck all point at the 8080 nobody is listening on. Nothing in the
 * logs mentions the typo. `SESSION_TTL_HOURS=-1` is a perfectly good number
 * and minted sessions that had already expired, so every login succeeded and
 * every request after it returned 401.
 *
 * A blank value still means "unset" — that is what an uninterpolated compose
 * variable yields, and falling back is the right answer for it. Anything else
 * must parse and be in range, or the process refuses to start while a human is
 * still watching the logs. Same posture as `guard.ts` takes on secrets.
 */
function numberFromEnv(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number between ${min} and ${max} — got ${JSON.stringify(raw)}`);
  }
  return value;
}

/**
 * Read runtime configuration from the environment, with local-dev
 * defaults. The query row cap / time limit are NOT env vars — they are
 * declarative code config in ./query-policy.ts.
 */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const sourceDbExplicit = typeof env.SOURCE_DB_PATH === 'string' && env.SOURCE_DB_PATH !== '';
  return {
    port: numberFromEnv('PORT', env.PORT, 3008, 1, 65535),
    databasePath: env.DATABASE_PATH ?? './data.db',
    sourceDbPath: sourceDbExplicit ? env.SOURCE_DB_PATH! : DEFAULT_SOURCE_DB,
    sourceDbExplicit,
    sourceViewsOnly: env.SOURCE_VIEWS_ONLY === 'true',
    exportsDir: env.EXPORTS_DIR ?? './exports',
    schedulerTickSeconds: numberFromEnv('SCHEDULER_TICK_SECONDS', env.SCHEDULER_TICK_SECONDS, 60, 1, 86400),
    auth: {
      username: env.ADMIN_USERNAME ?? 'admin',
      password: env.ADMIN_PASSWORD ?? 'admin',
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: numberFromEnv('SESSION_TTL_HOURS', env.SESSION_TTL_HOURS, 12, 1, 8760),
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
