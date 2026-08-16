import type { AuthConfig } from './auth.js';
import { egressPolicyFromEnv, type EgressPolicy } from './egress.js';
import { loadKey } from './crypto.js';
import { oauthConfigFromEnv, type OAuthConfig } from './oauth.js';
import { REGISTRY } from './provider-registry.js';

export interface ServerConfig {
  /** Which outbound targets the proxy and OAuth exchange may call. */
  egress: EgressPolicy;
  port: number;
  databasePath: string;
  auth: AuthConfig;
  /** 32-byte AES key for credential encryption (validated at load). */
  encryptionKey: Buffer;
  webhookSecret: string;
  oauth: OAuthConfig;
  /** Public base URL used to build OAuth redirect URIs. */
  selfBaseUrl: string;
  /** When > 0, run due sync jobs on an internal timer (ms). */
  tickIntervalMs: number;
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
  const port = numberFromEnv('PORT', env.PORT, 4005, 1, 65535);
  return {
    port,
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
    // Fail fast if the key is malformed.
    encryptionKey: loadKey(env.INTEGRATION_ENCRYPTION_KEY ?? '0'.repeat(64)),
    webhookSecret: env.WEBHOOK_SECRET ?? 'dev-webhook-secret',
    oauth: oauthConfigFromEnv(env, REGISTRY.map((p) => p.key)),
    selfBaseUrl: env.SELF_BASE_URL ?? `http://localhost:${port}`,
    tickIntervalMs: numberFromEnv('TICK_INTERVAL_MS', env.TICK_INTERVAL_MS, 0, 0, 86400000),
  };
}
