import { PLACEHOLDER_BIC, PLACEHOLDER_IBAN } from '../shared/sepa.js';
import type { AuthConfig } from './auth.js';
import { DEFAULT_BUSINESS_TIMEZONE, timeZoneProblem } from './business-date.js';
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
  // ── E-invoice fields (XRechnung / ZUGFeRD). All optional: an empty one is
  // read from `addressLines` / `vatId` where it can be (shared/address.ts),
  // and reported as missing by the e-invoice check where it cannot. ──
  street?: string | undefined;
  postcode?: string | undefined;
  city?: string | undefined;
  /** ISO 3166-1 alpha-2 — DE or AT for the installations this is built for. */
  country?: string | undefined;
  /** German Steuernummer (BT-32), when there is no VAT id or as well as it. */
  taxNumber?: string | undefined;
  /** BT-30 — Handelsregister / Firmenbuch number. Needed when there is no VAT id. */
  registration?: string | undefined;
  /**
   * BT-29 — an identifier with its ISO 6523 scheme, e.g. `0088:4000001000005`
   * for a GLN. Identifies a seller that has neither VAT id nor register number.
   */
  identifier?: string | undefined;
  /** BG-6 — XRechnung makes name, phone and email of a contact mandatory. */
  contactName?: string | undefined;
  phone?: string | undefined;
  email?: string | undefined;
  /** BT-34 — the address e-invoice replies go to. Defaults to `email`. */
  einvoiceAddress?: string | undefined;
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
  /**
   * The IANA zone business dates are days in (server/business-date.ts): issue
   * and due dates, payments, cancellations, overdue days. BUSINESS_TIMEZONE,
   * Europe/Berlin when unset.
   */
  businessTimeZone: string;
  auth: AuthConfig;
  seller: SellerConfig;
  /**
   * An optional OVERRIDE for the Finanzamt remittance format.
   *
   * PSA's own pattern is published and shipped as `TAXS_REMITTANCE`, so
   * nothing needs configuring for a tax payment to be checked. This exists
   * because a bank may be *stricter* than PSA, and a customer told so should
   * be able to say it here rather than discover it from a rejected file.
   *
   * It replaces the format check only. The 140-character cap, the refusal of
   * an empty remittance and the tax account check digit stand either way.
   */
  austrianRemittance: { TAXS: RegExp | null };
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

/**
 * Read the business time zone, refusing one Intl does not know: a typo such as
 * "Europe/Berlinn" would otherwise date every invoice in UTC, and the day is
 * off only around midnight, where nobody looks.
 */
function timeZoneFromEnv(raw: string | undefined): string {
  if (raw === undefined || raw.trim() === '') return DEFAULT_BUSINESS_TIMEZONE;
  const problem = timeZoneProblem(raw.trim());
  if (problem !== null) throw new Error(`BUSINESS_TIMEZONE: ${problem}`);
  return raw.trim();
}

/** Read configuration from the environment, with local-dev defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: numberFromEnv('PORT', env.PORT, 3004, 1, 65535),
    databasePath: env.DATABASE_PATH ?? './data.db',
    sellerRefreshMs: numberFromEnv('SELLER_REFRESH_MS', env.SELLER_REFRESH_MS, 300_000, 0, 86400000),
    shellOrigins: shellOriginsFromEnv(env.SHELL_ORIGIN),
    businessTimeZone: timeZoneFromEnv(env.BUSINESS_TIMEZONE),
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
      // Placeholders every e-invoice refuses (shared/einvoice.ts) — a demo needs no bank account.
      iban: env.SELLER_IBAN ?? PLACEHOLDER_IBAN,
      bic: env.SELLER_BIC ?? PLACEHOLDER_BIC,
      street: env.SELLER_STREET || undefined,
      postcode: env.SELLER_POSTCODE || undefined,
      city: env.SELLER_CITY || undefined,
      country: env.SELLER_COUNTRY ? env.SELLER_COUNTRY.trim().toUpperCase() : undefined,
      taxNumber: env.SELLER_TAX_NUMBER || undefined,
      registration: env.SELLER_REGISTRATION || undefined,
      identifier: env.SELLER_IDENTIFIER || undefined,
      contactName: env.SELLER_CONTACT_NAME || undefined,
      phone: env.SELLER_PHONE || undefined,
      email: env.SELLER_EMAIL || undefined,
      einvoiceAddress: env.SELLER_EINVOICE_ADDRESS || undefined,
    },
    austrianRemittance: {
      TAXS: patternFromEnv('AT_TAXS_REMITTANCE_PATTERN', env.AT_TAXS_REMITTANCE_PATTERN),
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
      // MOD-17 Orders & Delivery Notes — when set, a delivery note can be
      // billed by its number, one invoice per delivery.
      ordersUrl: env.ORDERS_URL || undefined,
      serviceToken: env.PLATFORM_SERVICE_TOKEN || undefined,
      invoiceChannel: env.NOTIFICATION_INVOICE_CHANNEL || undefined,
    },
  };
}
