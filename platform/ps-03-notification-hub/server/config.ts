import type { AuthConfig } from './auth.js';
import type { TwilioConfig } from './providers/twilio-sms.js';

export interface ServerConfig {
  port: number;
  databasePath: string;
  auth: AuthConfig;
  /** When set, email channels use the real Resend provider; otherwise console. */
  resendApiKey: string | null;
  /** When set, sms channels use the real Twilio provider; otherwise console. */
  twilio: TwilioConfig | null;
  /** When > 0, run the delivery queue on an internal timer (ms). */
  tickIntervalMs: number;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const twilio: TwilioConfig | null =
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
      ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM }
      : null;
  return {
    port: Number(env.PORT) || 4003,
    databasePath: env.DATABASE_PATH ?? './data.db',
    auth: {
      username: env.ADMIN_USERNAME ?? 'admin',
      password: env.ADMIN_PASSWORD ?? 'change-me',
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: Number(env.SESSION_TTL_HOURS) || 12,
      secureCookie: env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
      serviceToken: env.SERVICE_TOKEN ?? 'dev-service-token',
      identityUrl: env.IDENTITY_URL || undefined,
    },
    resendApiKey: env.RESEND_API_KEY ?? null,
    twilio,
    tickIntervalMs: Number(env.TICK_INTERVAL_MS) || 0,
  };
}
