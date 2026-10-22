import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { hardeningFromEnv } from './hardening.js';
import { assertProductionConfig } from './guard.js';
import { buildPlatform } from './platform.js';
import { buildLoginVerifier, loginModeOf } from './sso.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';
import { PlatformSeller } from './seller.js';

const config = configFromEnv();
assertProductionConfig([
  { name: 'SESSION_SECRET', value: config.auth.secret },
  { name: 'ADMIN_PASSWORD', value: config.auth.password },
]);
const db = openDb(config.databasePath);

// First start on an empty database: load the example data so the app is
// usable immediately. A database with existing data is never touched.
seed(db);

// When running the compiled server (dist/server/server/index.js), the built
// client lives at dist/client. In dev (tsx) it usually doesn't exist yet —
// then only the API is served and the UI comes from `npm run dev:web`.
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [resolve(here, '../../client'), resolve(here, '../../dist/client')];
const staticDir = candidates.find((dir) => existsSync(resolve(dir, 'index.html')));

const platform = buildPlatform(config.platform);

// The letterhead's PS-11 layer, read before the first request and then kept
// current. Standalone (no CUSTOMERS_URL) fetchSelf answers null without a call.
const platformSeller = new PlatformSeller();
const usingPlatformSeller = await platformSeller.refresh(() => platform.fetchSelf());
platformSeller.start(() => platform.fetchSelf(), config.sellerRefreshMs);

const app = createApp({ db, hardening: hardeningFromEnv(), auth: config.auth, staticDir, platform, seller: config.seller, platformSeller, verifyLogin: buildLoginVerifier(config.sso), loginMode: loginModeOf(config.sso), serviceToken: config.platform.serviceToken, shellOrigins: config.shellOrigins });

app.listen(config.port, () => {
  console.log(`[mod-17] orders & delivery notes API on http://localhost:${config.port}`);
  if (staticDir) console.log(`[mod-17] serving client from ${staticDir}`);
  console.log(usingPlatformSeller ? '[mod-17] letterhead from PS-11 Customers (Settings override it)' : '[mod-17] letterhead from SELLER_* env (Settings override it)');
  if (config.auth.password === 'admin') {
    console.warn('[mod-17] WARNING: using default credentials (admin/admin) — set ADMIN_USERNAME/ADMIN_PASSWORD');
  }
});
