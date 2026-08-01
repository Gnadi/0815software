import type { SessionConfig } from './auth.js';
import { throttleConfigFromEnv, type ThrottleConfig } from './throttle.js';
import { oauthConfigFromEnv, type OAuthConfig } from './oauth.js';

export interface ServerConfig {
  port: number;
  databasePath: string;
  session: SessionConfig;
  oauth: OAuthConfig;
  /** Public base URL of this service, used to build OAuth redirect URIs. */
  selfBaseUrl: string;
  /** Per-account login backoff — the brake on password spraying. */
  throttle: ThrottleConfig;
  /**
   * Whether an unconfigured provider may use the offline mock IdP, which
   * resolves an identity WITHOUT any credential. Development only: off in
   * production unless the operator sets OAUTH_ALLOW_MOCK=true deliberately.
   */
  allowMockIdp: boolean;
  /** Extra origins a post-login `redirect_uri` may point at. */
  redirectAllowlist: string[];
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
    throttle: throttleConfigFromEnv(env),
    selfBaseUrl: env.SELF_BASE_URL ?? `http://localhost:${port}`,
    allowMockIdp:
      env.OAUTH_ALLOW_MOCK !== undefined ? env.OAUTH_ALLOW_MOCK === 'true' : env.NODE_ENV !== 'production',
    redirectAllowlist: (env.OAUTH_REDIRECT_ALLOWLIST ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
