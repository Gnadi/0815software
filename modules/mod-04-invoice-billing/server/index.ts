import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { hardeningFromEnv } from './hardening.js';
import { applySeller, startSellerRefresh } from './seller.js';
import { assertProductionConfig } from './guard.js';
import { buildPlatform } from './platform.js';
import { buildLoginVerifier } from './sso.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';

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

// The seller letterhead: PS-11's `self` party is the authority when configured,
// the SELLER_* env is the fallback. Applied before the first request so no
// invoice is rendered with a stale letterhead, then refreshed periodically so
// changing it in PS-11 does not need a restart. config.seller is mutated in
// place — createApp captures it and the PDF reads its fields at render time.
const usingPlatformSeller = await applySeller(config.seller, () => platform.fetchSelf());
startSellerRefresh(config.seller, () => platform.fetchSelf(), config.sellerRefreshMs);

const app = createApp({
  db,
  hardening: hardeningFromEnv(),
  auth: config.auth,
  seller: config.seller,
  staticDir,
  platform,
  verifyLogin: buildLoginVerifier(config.sso),
});

app.listen(config.port, () => {
  console.log(`[mod-04] invoice & billing API on http://localhost:${config.port}`);
  if (staticDir) console.log(`[mod-04] serving client from ${staticDir}`);
  console.log(
    usingPlatformSeller
      ? `[mod-04] seller letterhead from PS-11 Customers: ${config.seller.name}`
      : `[mod-04] seller letterhead from SELLER_* env: ${config.seller.name}`,
  );
  if (config.auth.password === 'admin') {
    console.warn('[mod-04] WARNING: using default credentials (admin/admin) — set ADMIN_USERNAME/ADMIN_PASSWORD');
  }
});
