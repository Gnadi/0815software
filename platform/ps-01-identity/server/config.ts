import type { SessionConfig } from './auth.js';
import { oauthConfigFromEnv, type OAuthConfig } from './oauth.js';

export interface ServerConfig {
  port: number;
  databasePath: string;
  session: SessionConfig;
  oauth: OAuthConfig;
  /** Public base URL of this service, used to build OAuth redirect URIs. */
  selfBaseUrl: string;
}

/** Read configuration from the environment, with local-dev defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT) || 4001;
  return {
    port,
    databasePath: env.DATABASE_PATH ?? './data.db',
    session: {
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: Number(env.SESSION_TTL_HOURS) || 12,
      secureCookie: env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
    },
    oauth: oauthConfigFromEnv(env),
    selfBaseUrl: env.SELF_BASE_URL ?? `http://localhost:${port}`,
  };
}
