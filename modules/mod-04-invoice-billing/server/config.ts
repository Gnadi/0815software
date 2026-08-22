import type { AuthConfig } from './auth.js';
import { shellOriginsFromEnv } from './hardening.js';
import type { PlatformConfig } from './platform.js';
import type { SsoConfig } from './sso.js';

/** Seller identity printed on invoice PDFs (letterhead + footer). */
export interface SellerConfig {
  name: string;
  addressLines: string[];
  vatId: string;
  iban: string;
  bic: string;
}

export interface ServerConfig {
  port: number;
  databasePath: string;
  /**
   * How often the seller letterhead is re-read from PS-11 (ms). Lower it to make
   * a change visible sooner; it only matters when CUSTOMERS_URL is set.
   */
  sellerRefreshMs: number;
  /**
   * The MOD-15 Workspace origin allowed to embed this module and to sign users
   * into it. Unset — the default, and every standalone install — turns off
   * framing and the handoff routes alike. A comma-separated LIST, because a
   * stack may run more than one shell. Parsed by `shellOriginsFromEnv`, which
   * refuses a malformed value rather than dropping it.
   */
  shellOrigins: string[];
  auth: AuthConfig;
  seller: SellerConfig;
  /**
   * The remittance formats for the two Austrian special credit transfers.
   *
   * **Not shipped, and not guessable.** The Stuzza guideline defines the
   * `RmtInf/Ustrd` structure for a Finanzamtszahlung and a Postbarzahlung as
   * regular expressions published at `zv.psa.at`; inventing the format of a
   * tax payment is the one guess in this codebase that would cost somebody a
   * penalty notice rather than a refused file. Set them from your own bank's
   * Kunde-Bank documentation and they are enforced; leave them null and a
   * TAXS or CPPP run says on its face that its format was never checked.
   */
  austrianRemittance: { TAXS: RegExp | null; CPPP: RegExp | null };
  platform: PlatformConfig;
  sso: SsoConfig;
}

/**
 * Read a regular expression from the environment, refusing a malformed one.
 *
 * Anchored on both ends, because a remittance format that matched a substring
 * would accept a correct reference with anything at all appended — which is
 * precisely how a tax payment ends up unallocated.
 */
function patternFromEnv(name: string, raw: string | undefined): RegExp | null {
  if (raw === undefined || raw.trim() === '') return null;
  const source = raw.trim();
  try {
    return new RegExp(`^(?:${source})$`);
  } catch (err) {
    throw new Error(`${name} is not a valid regular expression: ${(err as Error).message}`);
  }
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

/** Read configuration from the environment, with local-dev defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: numberFromEnv('PORT', env.PORT, 3004, 1, 65535),
    databasePath: env.DATABASE_PATH ?? './data.db',
    sellerRefreshMs: numberFromEnv('SELLER_REFRESH_MS', env.SELLER_REFRESH_MS, 300_000, 0, 86400000),
    shellOrigins: shellOriginsFromEnv(env.SHELL_ORIGIN),
    auth: {
      username: env.ADMIN_USERNAME ?? 'admin',
      password: env.ADMIN_PASSWORD ?? 'admin',
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: numberFromEnv('SESSION_TTL_HOURS', env.SESSION_TTL_HOURS, 12, 1, 8760),
      secureCookie: env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
    },
    seller: {
      name: env.SELLER_NAME ?? '0815software GmbH',
      addressLines: (env.SELLER_ADDRESS ?? 'Beispielgasse 8/15|1010 Wien|Austria').split('|'),
      vatId: env.SELLER_VAT_ID ?? 'ATU00000000',
      iban: env.SELLER_IBAN ?? 'AT00 0000 0000 0000 0000',
      bic: env.SELLER_BIC ?? 'EXAMPLEX',
    },
    austrianRemittance: {
      TAXS: patternFromEnv('AT_TAXS_REMITTANCE_PATTERN', env.AT_TAXS_REMITTANCE_PATTERN),
      CPPP: patternFromEnv('AT_CPPP_REMITTANCE_PATTERN', env.AT_CPPP_REMITTANCE_PATTERN),
    },
    // Platform Services — all optional; unset means standalone (no calls out).
    sso: {
      identityUrl: env.IDENTITY_URL || undefined,
      identityOrg: env.IDENTITY_ORG || undefined,
      identityPermission: env.IDENTITY_PERMISSION || undefined,
    },
    platform: {
      notificationUrl: env.NOTIFICATION_URL || undefined,
      filesUrl: env.FILES_URL || undefined,
      auditUrl: env.AUDIT_URL || undefined,
      paymentsUrl: env.PAYMENTS_URL || undefined,
      numberUrl: env.NUMBER_URL || undefined,
      // PS-11 Customers — when set, an imported customer is resolved against
      // the stack's party master data instead of being copied blind.
      customersUrl: env.CUSTOMERS_URL || undefined,
      bankingUrl: env.BANKING_URL || undefined,
      bankConnection: env.BANK_CONNECTION || undefined,
      // MOD-13 Offers — when set, an accepted offer can be billed with one
      // action. Unset means this module behaves exactly as it did before.
      offersUrl: env.OFFERS_URL || undefined,
      serviceToken: env.PLATFORM_SERVICE_TOKEN || undefined,
      invoiceChannel: env.NOTIFICATION_INVOICE_CHANNEL || undefined,
    },
  };
}
