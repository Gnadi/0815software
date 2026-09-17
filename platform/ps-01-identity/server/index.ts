import { createApp } from './app.js';
import { assertProductionConfig } from './guard.js';
import { hardeningFromEnv } from './hardening.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';

const config = configFromEnv();
assertProductionConfig([{ name: 'SESSION_SECRET', value: config.session.secret }]);
const db = openDb(config.databasePath);

// First start on an empty database: load the demo tenants so the service
// is usable immediately. A database with existing organizations is never
// touched.
await seed(db);

const app = createApp({
  db,
  session: config.session,
  oauth: config.oauth,
  selfBaseUrl: config.selfBaseUrl,
  allowMockIdp: config.allowMockIdp,
  throttle: config.throttle,
  redirectAllowlist: config.redirectAllowlist,
  hardening: hardeningFromEnv(), logRequests: true,
});

app.listen(config.port, () => {
  console.log(`[ps-01] identity API on http://localhost:${config.port}`);
  // Provider names are discovered by scanning OAUTH_<NAME>_CLIENT_ID, so a
  // misspelled variable declares nothing and fails silently at login time.
  // Printing what was actually recognised turns that into a boot-time check
  // a human can read.
  const providers = Object.keys(config.oauth).sort();
  console.log(
    providers.length > 0
      ? `[ps-01] OAuth/OIDC providers configured: ${providers.join(', ')}`
      : '[ps-01] no OAuth/OIDC provider configured (SCIM and password login still work)',
  );
  if (config.session.secret === 'dev-secret-change-me') {
    console.warn('[ps-01] WARNING: using the default SESSION_SECRET — set a real one in production');
  }
  if (config.allowMockIdp) {
    console.warn(
      '[ps-01] WARNING: the offline mock IdP is enabled — an unconfigured OAuth provider issues sessions ' +
        'without any credential. Configure a provider (or set OAUTH_ALLOW_MOCK=false) before exposing this.',
    );
  }
});
