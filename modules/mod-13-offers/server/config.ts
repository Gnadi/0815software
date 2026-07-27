import type { AuthConfig } from './auth.js';
import type { PlatformConfig } from './platform.js';
import type { SsoConfig } from './sso.js';

/** Seller identity printed on offer PDFs (letterhead + footer). */
export interface SellerConfig {
  name: string;
  addressLines: string[];
  vatId: string;
  email: string;
}

export interface ServerConfig {
  port: number;
  databasePath: string;
  /**
   * How often the seller letterhead is re-read from PS-11 (ms). Lower it to make
   * a change visible sooner; it only matters when CUSTOMERS_URL is set.
   */
  sellerRefreshMs: number;
  publicBaseUrl: string;
  auth: AuthConfig;
  seller: SellerConfig;
  platform: PlatformConfig;
  sso: SsoConfig;
}

/** Read configuration from the environment, with local-dev defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const port = Number(env.PORT) || 3013;
  return {
    port,
    databasePath: env.DATABASE_PATH ?? './data.db',
    sellerRefreshMs: Number(env.SELLER_REFRESH_MS) || 300_000,
    publicBaseUrl: env.PUBLIC_BASE_URL ?? `http://localhost:${port}`,
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
      email: env.SELLER_EMAIL ?? 'offers@0815software.example.at',
    },
    sso: {
      identityUrl: env.IDENTITY_URL || undefined,
      identityOrg: env.IDENTITY_ORG || undefined,
      identityPermission: env.IDENTITY_PERMISSION || undefined,
    },
    platform: {
      auditUrl: env.AUDIT_URL || undefined,
      notificationUrl: env.NOTIFICATION_URL || undefined,
      // PS-11 Customers — when set, a customer created here is resolved
      // against the stack's party master data so MOD-04 bills the same party.
      customersUrl: env.CUSTOMERS_URL || undefined,
      serviceToken: env.PLATFORM_SERVICE_TOKEN || undefined,
    },
  };
}
