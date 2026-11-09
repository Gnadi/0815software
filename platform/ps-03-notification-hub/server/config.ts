import type { AuthConfig } from './auth.js';
import { egressPolicyFromEnv, type EgressPolicy } from './egress.js';
import type { TwilioConfig } from './providers/twilio-sms.js';
import { DEFAULT_PUSH_HOSTS, vapidPublicKey } from './webpush.js';

export interface ServerConfig {
  /** Which chat-webhook targets a channel may post to. */
  egress: EgressPolicy;
  port: number;
  databasePath: string;
  auth: AuthConfig;
  /** When set, email channels use the real Resend provider; otherwise console. */
  resendApiKey: string | null;
  /** When set, sms channels use the real Twilio provider; otherwise console. */
  twilio: TwilioConfig | null;
  /** When > 0, run the delivery queue on an internal timer (ms). */
  tickIntervalMs: number;
  /** Days to keep terminal (sent/dead) messages; pruned on tick. 0 = keep. */
  retentionDays: number;
  /**
   * The stack's VAPID key pair (RFC 8292), private half. Unset = no push:
   * events still reach people by mail and digest.
   */
  vapid: { privateKey: string; subject: string } | null;
  /** Push services a browser subscription may point at. */
  pushAllowedHosts: string[];
}

/**
 * The VAPID private key: a 32-byte P-256 scalar, base64url — or 64 hex
 * characters, which is what `deploy/provision.mjs` mints for every secret.
 * Anything else stops the start, since a key that cannot sign would let every
 * push fail one by one in the logs instead of once, here.
 */
function vapidKeyFromEnv(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  const value = raw.trim();
  const bytes = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : Buffer.from(value, 'base64url');
  if (bytes.length !== 32) throw new Error('VAPID_PRIVATE_KEY must be 32 bytes, as base64url or 64 hex characters');
  const key = bytes.toString('base64url');
  try {
    vapidPublicKey(key);
  } catch {
    throw new Error('VAPID_PRIVATE_KEY is not a valid P-256 private key');
  }
  return key;
}

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

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const twilio: TwilioConfig | null =
    env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN
      ? { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, from: env.TWILIO_FROM }
      : null;
  return {
    port: numberFromEnv('PORT', env.PORT, 4003, 1, 65535),
    egress: egressPolicyFromEnv(env),
    databasePath: env.DATABASE_PATH ?? './data.db',
    auth: {
      username: env.ADMIN_USERNAME ?? 'admin',
      password: env.ADMIN_PASSWORD ?? 'change-me',
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: numberFromEnv('SESSION_TTL_HOURS', env.SESSION_TTL_HOURS, 12, 1, 8760),
      secureCookie: env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
      serviceToken: env.SERVICE_TOKEN ?? 'dev-service-token',
      identityUrl: env.IDENTITY_URL || undefined,
    },
    resendApiKey: env.RESEND_API_KEY ?? null,
    twilio,
    tickIntervalMs: numberFromEnv('TICK_INTERVAL_MS', env.TICK_INTERVAL_MS, 0, 0, 86400000),
    retentionDays: numberFromEnv('RETENTION_DAYS', env.RETENTION_DAYS, 0, 0, 3650),
    vapid: (() => {
      const privateKey = vapidKeyFromEnv(env.VAPID_PRIVATE_KEY);
      if (!privateKey) return null;
      const subject = env.VAPID_SUBJECT?.trim() || 'mailto:notifications@localhost';
      if (!/^(mailto:|https:)/.test(subject)) throw new Error('VAPID_SUBJECT must be a mailto: or https: URL');
      return { privateKey, subject };
    })(),
    pushAllowedHosts: [
      ...DEFAULT_PUSH_HOSTS,
      ...(env.PUSH_ALLOWED_HOSTS ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean),
    ],
  };
}
