import type { AuthConfig } from './auth.js';
import { loadKey } from './crypto.js';
import { oauthConfigFromEnv, type OAuthConfig } from './oauth.js';
import { REGISTRY } from './provider-registry.js';

export interface ServerConfig {
  port: number;
  databasePath: string;
  auth: AuthConfig;
  /** 32-byte AES key for credential encryption (validated at load). */
  encryptionKey: Buffer;
  webhookSecret: string;
  oauth: OAuthConfig;
  /** Public base URL used to build OAuth redirect URIs. */
  selfBaseUrl: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT) || 4005;
  return {
    port,
    databasePath: env.DATABASE_PATH ?? './data.db',
    auth: {
      username: env.ADMIN_USERNAME ?? 'admin',
      password: env.ADMIN_PASSWORD ?? 'change-me',
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: Number(env.SESSION_TTL_HOURS) || 12,
      secureCookie: env.COOKIE_SECURE === 'true',
      serviceToken: env.SERVICE_TOKEN ?? 'dev-service-token',
      identityUrl: env.IDENTITY_URL || undefined,
    },
    // Fail fast if the key is malformed.
    encryptionKey: loadKey(env.INTEGRATION_ENCRYPTION_KEY ?? '0'.repeat(64)),
    webhookSecret: env.WEBHOOK_SECRET ?? 'dev-webhook-secret',
    oauth: oauthConfigFromEnv(env, REGISTRY.map((p) => p.key)),
    selfBaseUrl: env.SELF_BASE_URL ?? `http://localhost:${port}`,
  };
}
