import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { hardeningFromEnv } from './hardening.js';
import { assertProductionConfig } from './guard.js';
import { buildPlatform } from './platform.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';
import { buildPeople } from './people.js';
import { startWatch } from './watch.js';
import { watchShop } from './inbox-rules.js';

const config = configFromEnv();
assertProductionConfig([
  { name: 'SESSION_SECRET', value: config.auth.secret },
  { name: 'ADMIN_PASSWORD', value: config.auth.password },
]);
const db = openDb(config.databasePath);

// First start on an empty database: load the example data so the shop is
// browsable immediately. A database with existing data is never touched.
seed(db);

// When running the compiled server (dist/server/server/index.js), the built
// client lives at dist/client. In dev (tsx) it usually doesn't exist yet —
// then only the API is served and the UI comes from `npm run dev:web`.
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [resolve(here, '../../client'), resolve(here, '../../dist/client')];
const staticDir = candidates.find((dir) => existsSync(resolve(dir, 'index.html')));

const app = createApp({ orderNotifyRecipients: config.orderNotifyRecipients, db, hardening: hardeningFromEnv(), auth: config.auth, staticDir, platform: buildPlatform(config.platform), serviceToken: config.platform.serviceToken });


// Notifications to people and the clock checks behind them
// (server/inbox-rules.ts) — only with PS-03 wired; otherwise nothing runs.
const people = buildPeople({
  module: 'storefront',
  notificationUrl: config.platform.notificationUrl,
  serviceToken: config.platform.serviceToken,
});
startWatch(db, people, (database, who) => watchShop(database, who, config.orderNotifyRecipients));

app.listen(config.port, () => {
  console.log(`[mod-07] storefront API on http://localhost:${config.port}`);
  if (staticDir) console.log(`[mod-07] serving client from ${staticDir}`);
  if (config.auth.password === 'admin') {
    console.warn('[mod-07] WARNING: using default credentials (admin/admin) — set ADMIN_USERNAME/ADMIN_PASSWORD');
  }
});
