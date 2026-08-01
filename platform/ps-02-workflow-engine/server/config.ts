import type { AuthConfig } from './auth.js';
import { egressPolicyFromEnv, type EgressPolicy } from './egress.js';

export interface ServerConfig {
  port: number;
  databasePath: string;
  auth: AuthConfig;
  /** When > 0, an internal timer drives the scheduler + dispatcher; 0 = off. */
  tickIntervalMs: number;
  /** Which outbound webhook targets this service is willing to call. */
  egress: EgressPolicy;
}

/** Read configuration from the environment, with local-dev defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT) || 4002,
    databasePath: env.DATABASE_PATH ?? './data.db',
    tickIntervalMs: Number(env.TICK_INTERVAL_MS) || 0,
    egress: egressPolicyFromEnv(env),
    auth: {
      username: env.ADMIN_USERNAME ?? 'admin',
      password: env.ADMIN_PASSWORD ?? 'change-me',
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: Number(env.SESSION_TTL_HOURS) || 12,
      secureCookie: env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
      serviceToken: env.SERVICE_TOKEN ?? 'dev-service-token',
      identityUrl: env.IDENTITY_URL || undefined,
    },
  };
}
