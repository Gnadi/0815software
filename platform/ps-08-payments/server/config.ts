import type { AuthConfig } from './auth.js';

export interface ServerConfig {
  port: number;
  databasePath: string;
  auth: AuthConfig;
  /** When set, intents may be confirmed against the real Stripe adapter. */
  stripeSecretKey: string | null;
  /** Shared secret used to verify inbound PSP webhook signatures. */
  webhookSecret: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT) || 4008,
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
    stripeSecretKey: env.STRIPE_SECRET_KEY ?? null,
    webhookSecret: env.WEBHOOK_SECRET ?? 'dev-webhook-secret',
  };
}
