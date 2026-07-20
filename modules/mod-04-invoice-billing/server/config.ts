import type { AuthConfig } from './auth.js';

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
  auth: AuthConfig;
  seller: SellerConfig;
}

/** Read configuration from the environment, with local-dev defaults. */
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    port: Number(env.PORT) || 3004,
    databasePath: env.DATABASE_PATH ?? './data.db',
    auth: {
      username: env.ADMIN_USERNAME ?? 'admin',
      password: env.ADMIN_PASSWORD ?? 'admin',
      secret: env.SESSION_SECRET ?? 'dev-secret-change-me',
      ttlHours: Number(env.SESSION_TTL_HOURS) || 12,
      secureCookie: env.COOKIE_SECURE === 'true',
    },
    seller: {
      name: env.SELLER_NAME ?? '0815software GmbH',
      addressLines: (env.SELLER_ADDRESS ?? 'Beispielgasse 8/15|1010 Wien|Austria').split('|'),
      vatId: env.SELLER_VAT_ID ?? 'ATU00000000',
      iban: env.SELLER_IBAN ?? 'AT00 0000 0000 0000 0000',
      bic: env.SELLER_BIC ?? 'EXAMPLEX',
    },
  };
}
