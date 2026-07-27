import type { AuthConfig } from './auth.js';
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
  auth: AuthConfig;
  seller: SellerConfig;
  platform: PlatformConfig;
  sso: SsoConfig;
}

/** Read configuration from the environment, with local-dev defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT) || 3004,
    databasePath: env.DATABASE_PATH ?? './data.db',
    sellerRefreshMs: Number(env.SELLER_REFRESH_MS) || 300_000,
    auth: {
      username: env.ADMIN_USERNAME ?? 'admin',
      password: env.ADMIN_PASSWORD ?? 'admin',
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: Number(env.SESSION_TTL_HOURS) || 12,
      secureCookie: env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : env.NODE_ENV === 'production',
    },
    seller: {
      name: env.SELLER_NAME ?? '0815software GmbH',
      addressLines: (env.SELLER_ADDRESS ?? 'Beispielgasse 8/15|1010 Wien|Austria').split('|'),
      vatId: env.SELLER_VAT_ID ?? 'ATU00000000',
      iban: env.SELLER_IBAN ?? 'AT00 0000 0000 0000 0000',
      bic: env.SELLER_BIC ?? 'EXAMPLEX',
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
      // MOD-13 Offers — when set, an accepted offer can be billed with one
      // action. Unset means this module behaves exactly as it did before.
      offersUrl: env.OFFERS_URL || undefined,
      serviceToken: env.PLATFORM_SERVICE_TOKEN || undefined,
      invoiceChannel: env.NOTIFICATION_INVOICE_CHANNEL || undefined,
    },
  };
}
