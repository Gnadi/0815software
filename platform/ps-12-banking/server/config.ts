import type { AuthConfig } from './auth.js';
import { egressPolicyFromEnv, type EgressPolicy } from './egress.js';

/**
 * Configuration, read once at boot and refused if it does not parse.
 *
 * One setting here is unlike anything in the other eleven services:
 * `EBICS_KEY_SECRET` is the key that encrypts the RSA private keys that sign
 * payments. Losing it does not mean "log everyone out" — it means every bank
 * connection is dead and has to be re-initialised on paper, which takes days.
 * It is therefore the one value an operator must back up, and the one the
 * shipped runbook names explicitly.
 */
export interface ServerConfig {
  port: number;
  databasePath: string;
  auth: AuthConfig;
  /** 64 hex characters. Encrypts the key store — back this up. */
  keySecret: string;
  /**
   * How often the tick loop runs on its own (ms). 0 disables it, leaving
   * `POST /api/tick` as the only driver — which is what tests use.
   */
  tickIntervalMs: number;
  /** Outbound policy: a bank is external, so internal targets are refused. */
  egress: EgressPolicy;
}

/**
 * Read a numeric setting, refusing a value that is not one.
 *
 * The old shape was `Number(raw) || fallback`, and it is silent in the two
 * ways that cost you a deployment. `PORT=401O` — a letter O — is NaN and
 * became the DEFAULT port: the service starts, reports itself healthy, and is
 * unreachable, because the compose port mapping, the reverse proxy and the
 * healthcheck all point at a port nobody is listening on. Nothing in the logs
 * mentions the typo.
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
  return {
    port: numberFromEnv('PORT', env.PORT, 4012, 1, 65535),
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
    keySecret: env.EBICS_KEY_SECRET ?? '0'.repeat(64),
    tickIntervalMs: numberFromEnv('TICK_INTERVAL_MS', env.TICK_INTERVAL_MS, 0, 0, 86400000),
    egress: egressPolicyFromEnv(env),
  };
}
