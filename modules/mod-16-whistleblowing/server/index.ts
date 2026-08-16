import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';
import { assertProductionConfig } from './guard.js';
import { hardeningFromEnv } from './hardening.js';
import { buildPlatform } from './platform.js';
import { configFromEnv } from './config.js';
import { openDb } from './db.js';
import { seed } from './seed.js';
import { buildLoginVerifier } from './sso.js';

const config = configFromEnv();
assertProductionConfig([
  { name: 'SESSION_SECRET', value: config.auth.secret },
  { name: 'ADMIN_PASSWORD', value: config.auth.password },
]);
const db = openDb(config.databasePath);

// First start on an empty database loads the demo data set. A database with
// cases in it is never touched.
seed(db);

// When running the compiled server (dist/server/server/index.js) the built
// client lives at dist/client. In dev (tsx) it usually does not exist yet —
// then only the API is served and the UI comes from `npm run dev:web`.
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [resolve(here, '../../client'), resolve(here, '../../dist/client')];
const staticDir = candidates.find((dir) => existsSync(resolve(dir, 'index.html')));

const app = createApp({
  db,
  auth: config.auth,
  hardening: hardeningFromEnv(),
  staticDir,
  platform: buildPlatform(config.platform),
  verifyLogin: buildLoginVerifier(config.sso),
  organisation: config.organisation,
  lookupRateLimitRpm: config.lookupRateLimitRpm,
});

app.listen(config.port, () => {
  console.log(`[mod-16] whistleblowing intake on http://localhost:${config.port}`);
  if (staticDir) console.log(`[mod-16] serving client from ${staticDir}`);
  if (config.auth.secret === 'dev-secret-change-me' || config.auth.password === 'admin') {
    console.warn('[mod-16] WARNING: using default credentials/secret — set real ones in production');
  }
});
