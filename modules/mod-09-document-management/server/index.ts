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
import { refreshText } from './search.js';
import { buildPeople } from './people.js';
import { startWatch } from './watch.js';
import { watchDocuments } from './inbox-rules.js';

const config = configFromEnv();
assertProductionConfig([{ name: 'SESSION_SECRET', value: config.session.secret }]);
const db = openDb(config.databasePath);

// First start on an empty database: load the demo data set so the app is
// usable immediately. A database with existing users is never touched.
await seed(db, config.storageDir);

// An installation from before full-text search, or after the readers
// improved: read the versions that have no (current) text yet. Synchronous on
// purpose — search answers from the first request rather than filling in.
const indexed = refreshText(db, config.storageDir);
if (indexed.read > 0 || indexed.missing > 0) {
  console.log(`[mod-09] read text of ${indexed.read} versions${indexed.missing ? `, ${indexed.missing} files missing` : ''}`);
}

// When running the compiled server (dist/server/server/index.js), the built
// client lives at dist/client. In dev (tsx) it usually doesn't exist yet —
// then only the API is served and the UI comes from `npm run dev:web`.
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [resolve(here, '../../client'), resolve(here, '../../dist/client')];
const staticDir = candidates.find((dir) => existsSync(resolve(dir, 'index.html')));

const app = createApp({
  db,
  hardening: hardeningFromEnv(),
  session: config.session,
  storageDir: config.storageDir,
  maxUploadBytes: config.maxUploadBytes,
  staticDir,
  platform: buildPlatform(config.platform),
  serviceToken: config.platform.serviceToken,
});


// Notifications to people and the clock checks behind them
// (server/inbox-rules.ts) — only with PS-03 wired; otherwise nothing runs.
const people = buildPeople({
  module: 'document-management',
  notificationUrl: config.platform.notificationUrl,
  serviceToken: config.platform.serviceToken,
});
startWatch(db, people, watchDocuments);

app.listen(config.port, () => {
  console.log(`[mod-09] document management API on http://localhost:${config.port}`);
  if (staticDir) console.log(`[mod-09] serving client from ${staticDir}`);
  if (config.session.secret === 'dev-secret-change-me') {
    console.warn('[mod-09] WARNING: using the default SESSION_SECRET — set a real one in production');
  }
});
