import type { AuthConfig } from './auth.js';
import type { PlatformConfig } from './platform.js';
import type { SsoConfig } from './sso.js';
import { CATALOGUE } from '../shared/catalogue.js';

/**
 * Where every peer module lives, as this process sees it.
 *
 * Keyed by registry id. A module absent from the map is simply not in this
 * customer's stack, which is the normal case — a two-module stack has two
 * entries — and the picker renders it as "not installed" rather than as an
 * error. `publicUrl` may be null while `url` is set: the operator wired the
 * internal address but not the browser-facing one, and the board can then show
 * that module's figures but cannot frame or link to it.
 */
export interface PeerConfig {
  url: string;
  publicUrl: string | null;
}
export type PeerMap = Record<string, PeerConfig>;

export interface ServerConfig {
  port: number;
  databasePath: string;
  /**
   * This module's own public origin. It is what the operator must ALSO name in
   * SHELL_ORIGIN on every module it tiles, and the two are checked against each
   * other at boot so a one-sided change fails loudly.
   */
  publicBaseUrl: string;
  /** How long a peer has to answer a handoff request before the pane gives up. */
  peerTimeoutMs: number;
  auth: AuthConfig;
  peers: PeerMap;
  platform: PlatformConfig;
  sso: SsoConfig;
}

/**
 * Read a numeric setting, refusing a value that is not one.
 *
 * Same posture as every other module in the catalogue: a blank value means
 * "unset" and falls back, anything else must parse and be in range or the
 * process refuses to start while a human is still watching the logs.
 * `PORT=301S` becoming the default port produces a service that reports itself
 * healthy and is unreachable, with nothing in the logs about the typo.
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
 * Read a peer URL, refusing a value that is not an absolute http(s) URL.
 *
 * Dropping a malformed one would be the silent failure: the board would render
 * that module as "not in this stack" — a perfectly ordinary state — when in
 * fact someone typed the address wrong. There is no way to tell those apart
 * from the outside, so a bad value has to stop the boot.
 */
function urlFromEnv(name: string, raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${name} must be an absolute URL — got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${name} must be http or https — got ${JSON.stringify(raw)}`);
  }
  // Trailing slashes are stripped so paths can be joined without doubling one.
  return url.origin + url.pathname.replace(/\/$/, '');
}

/**
 * Every peer's two env vars, read by name.
 *
 * Written out rather than looked up as `env[entry.urlEnv]`, for two reasons.
 * It is what the registry drift test reads — it derives a module's env surface
 * by matching each env-var read in this file, and a computed lookup is invisible
 * to that scan — the registry would appear to declare fourteen peers no code reads.
 * And it is greppable: "what sets CRM_URL" is answerable from this file alone.
 *
 * The obvious risk — adding a module to the catalogue and forgetting it here —
 * is covered by a test that compares the two lists, which is a better place for
 * that guarantee than a clever loop.
 */
function peerEnv(env: NodeJS.ProcessEnv): Record<string, { url?: string; publicUrl?: string }> {
  return {
    'mod-01-customer-portal': { url: env.PORTAL_URL, publicUrl: env.PORTAL_PUBLIC_URL },
    'mod-02-admin-dashboard': { url: env.ADMIN_URL, publicUrl: env.ADMIN_PUBLIC_URL },
    'mod-03-inventory-management': { url: env.INVENTORY_URL, publicUrl: env.INVENTORY_PUBLIC_URL },
    'mod-04-invoice-billing': { url: env.INVOICING_URL, publicUrl: env.INVOICING_PUBLIC_URL },
    'mod-05-employee-directory': { url: env.DIRECTORY_URL, publicUrl: env.DIRECTORY_PUBLIC_URL },
    'mod-06-procurement-tracker': { url: env.PROCUREMENT_URL, publicUrl: env.PROCUREMENT_PUBLIC_URL },
    'mod-07-storefront': { url: env.SHOP_URL, publicUrl: env.SHOP_PUBLIC_URL },
    'mod-08-reporting-suite': { url: env.REPORTING_URL, publicUrl: env.REPORTING_PUBLIC_URL },
    'mod-09-document-management': { url: env.DOCUMENTS_URL, publicUrl: env.DOCUMENTS_PUBLIC_URL },
    'mod-10-crm-lite': { url: env.CRM_URL, publicUrl: env.CRM_PUBLIC_URL },
    'mod-11-time-tracking': { url: env.TIME_URL, publicUrl: env.TIME_PUBLIC_URL },
    'mod-12-support-tickets': { url: env.SUPPORT_URL, publicUrl: env.SUPPORT_PUBLIC_URL },
    'mod-13-offers': { url: env.OFFERS_URL, publicUrl: env.OFFERS_PUBLIC_URL },
    'mod-14-subsidies-funds': { url: env.SUBSIDIES_URL, publicUrl: env.SUBSIDIES_PUBLIC_URL },
    'mod-15-workspace': { url: env.WORKSPACE_URL, publicUrl: env.WORKSPACE_PUBLIC_URL },
  };
}

/**
 * The peers this stack actually contains.
 *
 * A module counts as present when its internal URL is set. The public URL is
 * optional and independent: the generator sets both, but a hand-written .env
 * that sets only the internal one still gets working widgets, just no frames.
 */
export function peersFromEnv(env: NodeJS.ProcessEnv): PeerMap {
  const raw = peerEnv(env);
  const peers: PeerMap = {};
  for (const entry of CATALOGUE) {
    const pair = raw[entry.id] ?? {};
    const url = urlFromEnv(entry.urlEnv, pair.url);
    if (url === undefined) continue;
    peers[entry.id] = { url, publicUrl: urlFromEnv(entry.publicUrlEnv, pair.publicUrl) ?? null };
  }
  return peers;
}

/** Ids `peerEnv` reads, so a test can hold it against the catalogue. */
export function peerEnvIds(): string[] {
  return Object.keys(peerEnv({}));
}

/** Read configuration from the environment, with local-dev defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = numberFromEnv('PORT', env.PORT, 3016, 1, 65535);
  return {
    port,
    databasePath: env.DATABASE_PATH ?? './data.db',
    publicBaseUrl: env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
    // Five seconds: long enough for a cold SQLite read on a loaded box, short
    // enough that one sick peer cannot make the whole board feel broken. Every
    // peer is fetched concurrently, so this is the board's worst case, not its
    // sum.
    peerTimeoutMs: numberFromEnv('PEER_TIMEOUT_MS', env.PEER_TIMEOUT_MS, 5_000, 100, 60_000),
    auth: {
      username: env.ADMIN_USERNAME ?? 'admin',
      password: env.ADMIN_PASSWORD ?? 'admin',
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: numberFromEnv('SESSION_TTL_HOURS', env.SESSION_TTL_HOURS, 12, 1, 8760),
      secureCookie: env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
    },
    peers: peersFromEnv(env),
    sso: {
      identityUrl: env.IDENTITY_URL || undefined,
      identityOrg: env.IDENTITY_ORG || undefined,
      identityPermission: env.IDENTITY_PERMISSION || undefined,
    },
    platform: {
      // PS-07 only. This module shows no figures, so there is nothing to
      // narrow by a customer and no feed to read — it writes what a person did
      // to their own screen, and reads nothing back.
      auditUrl: env.AUDIT_URL || undefined,
      serviceToken: env.PLATFORM_SERVICE_TOKEN || undefined,
    },
  };
}

/** Peer env vars, for `.env.example` and the catalogue-agreement test. */
export const PEER_ENV_VARS: readonly string[] = CATALOGUE.flatMap((e) => [e.urlEnv, e.publicUrlEnv]);
